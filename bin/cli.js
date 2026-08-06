#!/usr/bin/env node
'use strict';

/**
 * asistente-cli — interfaz headless del asistente (modo terminal).
 *
 * REQUIERE correr bajo el Node de Electron (better-sqlite3/sqlite-vec están
 * compilados para el ABI de Electron, no para el node del sistema). Desde el
 * repo:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron bin/cli.js chat
 *
 * Comandos:
 *   run "<prompt>" [--workspace dir] [--json] [--auto-approve] [--session id]
 *                  → una consulta y sale.
 *   chat [--workspace dir] [--session id]  → REPL interactivo con streaming.
 *   sessions [--limit n]                   → lista sesiones pasadas.
 *   checkpoint save <nombre>               → guarda un snapshot de la sesión.
 *   checkpoint load <nombre>               → retoma un snapshot guardado.
 *   checkpoint list                        → lista snapshots.
 *   checkpoint delete <nombre>             → borra un snapshot.
 *   usage                                  → resumen de uso de LLM.
 *   help                                   → este mensaje.
 *
 * En el REPL:
 *   /exit | /quit         salir (cierra y persiste la sesión)
 *   /help                 ayuda
 *   /session              id + turnos de la sesión activa
 *   /checkpoint save|load|list|delete <nombre>
 *   /usage                uso de LLM
 *   cualquier otro texto  → pregunta al asistente (streaming en vivo)
 */

// ── Guard: debe correr bajo el Node de Electron ─────────────────────────────
if (!process.versions.electron) {
  console.error(
    'Este CLI requiere el Node de Electron (ABI de better-sqlite3). Ejecuta:\n\n' +
      '  ELECTRON_RUN_AS_NODE=1 npx electron bin/cli.js <comando>'
  );
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

process.env.ASISTENTE_WORKSPACE = process.env.ASISTENTE_WORKSPACE || process.cwd();

// Datos (core.db, checkpoints) en un directorio por usuario, no en el repo.
// Sobreescribible con --data <dir> o ASISTENTE_DATA_DIR.
const defaultDataDir = path.join(os.homedir(), '.local', 'share', 'asistente-vtuber');
process.env.ASISTENTE_DATA_DIR =
  process.env.ASISTENTE_DATA_DIR || path.join(defaultDataDir, 'data');

// ── Argumentos ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;

// ── Config (reuso de ConfigManager) ─────────────────────────────────────────
function findConfigPath() {
  if (flags.config) return path.resolve(flags.config);
  if (process.env.ASISTENTE_CONFIG) return path.resolve(process.env.ASISTENTE_CONFIG);
  const userData = path.join(os.homedir(), '.config', 'vtuber-overlay');
  const candidates = [path.join(process.cwd(), 'config.json'), path.join(userData, 'config.json')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function loadConfig() {
  const fp = findConfigPath();
  if (!fp) return {};
  try {
    const { ConfigManager } = require('../core/config/ConfigManager.js');
    const mgr = new ConfigManager(fp, { verbose: false });
    const cfg = mgr.load();
    // Inyectar keys desde variables de entorno LLM_KEY_* (como main.js)
    if (!cfg.llm) cfg.llm = {};
    if (!cfg.llm.apiKeys) cfg.llm.apiKeys = {};
    for (const [k, v] of Object.entries(process.env)) {
      const m = k.match(/^LLM_KEY_(.+)$/);
      if (m && v && v.trim()) cfg.llm.apiKeys[m[1].toLowerCase()] = v.trim();
    }
    return cfg;
  } catch (e) {
    console.warn(`[cli] config no legible (${fp}): ${e.message}`);
    return {};
  }
}

// ── Checkpoints ─────────────────────────────────────────────────────────────
function checkpointDir() {
  const dir =
    process.env.ASISTENTE_CHECKPOINTS ||
    path.join(os.homedir(), '.config', 'vtuber-overlay', 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function checkpointPath(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(checkpointDir(), `${safe}.json`);
}

function writeCheckpoint(name, Core) {
  const history = Core.getSessionHistory();
  if (!history.length) {
    console.log('  (sesión vacía — no hay nada que guardar)');
    return;
  }
  const snapshot = {
    name,
    ts: new Date().toISOString(),
    workspace: process.env.ASISTENTE_WORKSPACE,
    sessionId: null,
    history,
  };
  fs.writeFileSync(checkpointPath(name), JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`  checkpoint "${name}" guardado (${history.length} mensajes)`);
}

function loadCheckpoint(name, Core) {
  const fp = checkpointPath(name);
  if (!fs.existsSync(fp)) {
    console.log(`  no existe el checkpoint "${name}"`);
    return false;
  }
  try {
    const snap = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    const out = Core.restoreSessionHistory(Array.isArray(snap.history) ? snap.history : [], null);
    console.log(`  checkpoint "${name}" restaurado (${out.turnCount} turnos)`);
    return true;
  } catch (e) {
    console.log(`  checkpoint corrupto: ${e.message}`);
    return false;
  }
}

function listCheckpoints() {
  const dir = checkpointDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.log('  (sin checkpoints)');
    return;
  }
  for (const f of files) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      console.log(`  ${snap.name || f}: ${snap.history?.length || 0} mensajes · ${snap.ts}`);
    } catch (_) {
      console.log(`  ${f}: (corrupto)`);
    }
  }
}

// ── Setup del Core ──────────────────────────────────────────────────────────
async function setup() {
  const { setProjectCWD, getPlanner } = require('../core/planner/Planner.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const Core = require('../core/Core.js');

  if (flags.data) {
    process.env.ASISTENTE_DATA_DIR = path.resolve(flags.data);
  }
  fs.mkdirSync(process.env.ASISTENTE_DATA_DIR, { recursive: true });

  const workspace = path.resolve(flags.workspace || process.env.ASISTENTE_WORKSPACE || process.cwd());
  process.env.ASISTENTE_WORKSPACE = workspace;
  setProjectCWD(workspace);

  const cfg = loadConfig();
  if (cfg.llm) {
    try {
      LLMProvider.configure(cfg);
    } catch (e) {
      console.warn(`[cli] LLMProvider.configure falló: ${e.message}`);
    }
  }

  Core.init(null);

  // Persistir usage a disco junto a la config del usuario
  if (flags.config || process.env.ASISTENTE_CONFIG) {
    const cfgPath = path.resolve(flags.config || process.env.ASISTENTE_CONFIG);
    const userData = path.dirname(cfgPath);
    LLMProvider.setUsageTracker(new (require('../core/observability/UsageTracker.js').UsageTracker)(
      path.join(userData, 'usage.jsonl')
    ));
  }

  const active = await Core.startSession();
  if (flags.session && active.sessionId !== flags.session) {
    // Retomar una sesión pasada concreta no es soportado en vivo; avisamos.
    console.warn(`[cli] nota: --session ${flags.session} no aplica a una sesión en vivo`);
  }
  return { Core, LLMProvider, workspace, active, getPlanner };
}

async function shutdown(Core) {
  try {
    await Core.closeSession();
  } catch (e) {
    console.warn(`[cli] error cerrando sesión: ${e.message}`);
  }
  try {
    await Core.shutdown();
  } catch (_) {
    /* noop */
  }
}

// ── run: una consulta ───────────────────────────────────────────────────────
async function cmdRun(Core, LLMProvider, prompt) {
  const autoApprove = flags['auto-approve'] === true || flags['auto-approve'] === 'true';
  const start = Date.now();
  let output = '';
  const result = await Core.runAgent(prompt, {
    onToken: (t) => {
      process.stdout.write(t);
      output += t;
    },
    onApprovalNeeded: autoApprove
      ? async () => true
      : async (action) => {
          console.log(`\n[cli] requiere aprobación: ${action.description || action.tool}`);
          console.log(`[cli] usa --auto-approve para permitir herramientas de alto impacto`);
          return false;
        },
  });
  process.stdout.write('\n');
  const ms = Date.now() - start;

  if (flags.json) {
    console.log(JSON.stringify({ ...result, elapsedMs: ms }, null, 2));
    return;
  }
  if (result.error && !result.response) {
    console.error(`[cli] error: ${result.error}`);
    return;
  }
  const summary =
    result.iterations > 0 ? `\n[cli] ${result.iterations} iteraciones · ${ms}ms` : '';
  console.log((output.trim() || result.response || '').trim() + summary);
}

// ── REPL interactivo ────────────────────────────────────────────────────────
async function cmdChat(ctx) {
  const { Core } = ctx;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('kaoru> ');

  console.log(`Sesión activa: ${ctx.active.sessionId} (${ctx.active.resumed ? 'reanudada' : 'nueva'})`);
  console.log('Escribe /help para ayuda. /exit para salir.');

  const ask = (q) =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));

  let busy = false;
  rl.on('line', async (line) => {
    const text = line.trim();
    if (busy) {
      console.log('  (ocupado — espera a que termine la consulta)');
      return;
    }
    if (!text) {
      rl.prompt();
      return;
    }

    if (text.startsWith('/')) {
      const [command, ...args] = text.slice(1).split(/\s+/);
      switch (command) {
        case 'exit':
        case 'quit':
          rl.close();
          return;
        case 'help':
          console.log(
            '  /exit | /quit            salir\n' +
              '  /session                id + turnos de la sesión\n' +
              '  /checkpoint save <n>    guardar snapshot\n' +
              '  /checkpoint load <n>    retomar snapshot\n' +
              '  /checkpoint list        listar snapshots\n' +
              '  /checkpoint delete <n>  borrar snapshot\n' +
              '  /usage                  uso de LLM\n' +
              '  /help                   ayuda'
          );
          break;
        case 'session': {
          const s = Core.getStats();
          console.log(`  sesión ${s.session} · ${s.turns} turnos`);
          break;
        }
        case 'checkpoint': {
          const sub = args[0];
          const name = args[1];
          if (sub === 'save' && name) writeCheckpoint(name, Core);
          else if (sub === 'load' && name) loadCheckpoint(name, Core);
          else if (sub === 'list') listCheckpoints();
          else if (sub === 'delete' && name) {
            const fp = checkpointPath(name);
            if (fs.existsSync(fp)) {
              fs.unlinkSync(fp);
              console.log(`  checkpoint "${name}" borrado`);
            } else console.log(`  no existe el checkpoint "${name}"`);
          } else console.log('  uso: /checkpoint save|load|list|delete <nombre>');
          break;
        }
        case 'usage': {
          const t = Core.getUsageTracker?.();
          if (!t) {
            console.log('  (usage no disponible)');
            break;
          }
          const s = t.getSummary();
          console.log(
            `  ${s.totalRequests} llamadas · ${s.totalTokens} tokens · ` +
              `$${s.totalCostUsd.toFixed(4)} · hoy: ${s.today.requests} llamadas (${s.today.promptTokens} in / ${s.today.completionTokens} out)`
          );
          break;
        }
        default:
          console.log(`  comando desconocido: /${command} (usa /help)`);
      }
      rl.prompt();
      return;
    }

    process.stdout.write('  ');
    busy = true;
    try {
      await Core.runAgent(text, {
        onToken: (t) => process.stdout.write(t),
        onApprovalNeeded: async (action) => {
          console.log(`\n  ¿Aprobar "${action.description || action.tool}"? [y/N] `);
          const ans = await ask('');
          return ans === 'y' || ans === 'yes';
        },
      });
      process.stdout.write('\n');
    } catch (e) {
      console.error(`\n  [error] ${e.message}`);
    } finally {
      busy = false;
    }
    rl.prompt();
  });

  rl.on('close', () => {
    shutdown(Core).then(() => process.exit(0));
  });
  rl.prompt();
}

// ── Dispatch ────────────────────────────────────────────────────────────────
async function main() {
  if (cmd === 'help' || cmd === undefined) {
    const banner = fs.readFileSync(__filename, 'utf-8');
    const lines = banner.split('\n').filter((l) => l.trim().startsWith('*'));
    console.log(lines.map((l) => l.trim().replace(/^\*\s?/, '')).join('\n'));
    return;
  }

  const ctx = await setup();

  switch (cmd) {
    case 'run': {
      const prompt = flags.prompt || rest.join(' ');
      if (!prompt) {
        console.error('uso: asistente-cli run "<prompt>"');
        await shutdown(ctx.Core);
        return;
      }
      await cmdRun(ctx.Core, ctx.LLMProvider, prompt);
      break;
    }
    case 'chat':
      await cmdChat(ctx);
      return;
    case 'sessions': {
      const limit = Number(flags.limit) || 10;
      const sessions = ctx.Core.listSessions(limit);
      if (!sessions.length) {
        console.log('  (sin sesiones pasadas)');
      } else {
        for (const s of sessions) {
          console.log(
            `  #${s.id} · ${s.turnCount} turnos · ${s.startedAt}${s.summary ? ` — ${s.summary}` : ''}`
          );
        }
      }
      break;
    }
    case 'checkpoint': {
      const sub = rest[0];
      const name = rest[1];
      if (sub === 'save' && name) writeCheckpoint(name, ctx.Core);
      else if (sub === 'load' && name) loadCheckpoint(name, ctx.Core);
      else if (sub === 'list') listCheckpoints();
      else if (sub === 'delete' && name) {
        const fp = checkpointPath(name);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          console.log(`  checkpoint "${name}" borrado`);
        } else console.log(`  no existe el checkpoint "${name}"`);
      } else console.log('uso: checkpoint save|load|list|delete <nombre>');
      break;
    }
    case 'usage': {
      const t = ctx.Core.getUsageTracker?.();
      if (!t) {
        console.log('  (usage no disponible — usa --config para persistir)');
      } else {
        const s = t.getSummary();
        console.log(JSON.stringify(s, null, 2));
      }
      break;
    }
    default:
      console.error(`comando desconocido: ${cmd} (usa "help")`);
  }

  await shutdown(ctx.Core);
  process.exit(0);
}

main().catch((e) => {
  console.error('[cli] error fatal:', e);
  process.exit(1);
});
