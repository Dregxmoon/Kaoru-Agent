'use strict';

const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Harness para el benchmark de tareas reales (§8 del roadmap).
 *
 * Inicializa Core de forma standalone (evalMode: toda tool de alto impacto se
 * auto-aprueba) y ejecuta Core.runAgent(). El servidor OpenClaw lo levanta el
 * PROPIO Core.init (como en producción): con la workspace de la tarea como
 * OPENCLAW_ALLOWED_PATH, su propia API key en memoria (setApiKey) y limpia el
 * proceso en shutdown(). No levantamos un server propio — duplicar el server
 * hacía que el bridge apuntara al puerto equivocado con la key equivocada
 * (auth fail) y rompía las corridas con EADDRINUSE entre runs.
 *
 * Uso (desde benchmarks/run.js):
 *   const h = require('./lib/harness');
 *   const agent = h.spawn();
 *   const res = await agent.run(prompt);
 *   await agent.close();
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Puerto libre y efímero por corrida. Se expone como OPENCLAW_PORT ANTES de
 * Core.init: el server que Core forkea (heredando el env) y el bridge (que
 * lee process.env.OPENCLAW_PORT en cada request) coinciden en el mismo puerto.
 * Evita el EADDRINUSE entre corridas consecutivas del benchmark (el socket del
 * server anterior queda en TIME_WAIT un instante tras stopOpenClaw).
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

class Harness {
  /**
   * @param {object} opts
   * @param {string} opts.workspace - directorio git de la tarea
   * @param {string} [opts.llmKey] - API key de Groq (default: env LLM_KEY_GROQ)
   * @param {number} [opts.maxIterations]
   * @param {string} [opts.mode] - 'fast' | 'smart'
   */
  constructor(opts = {}) {
    this.workspace = opts.workspace;
    this.llmKey = opts.llmKey || process.env.LLM_KEY_GROQ;
    this.maxIterations = opts.maxIterations || 10;
    this.mode = opts.mode || 'fast';
    this._core = null;
  }

  async start() {
    // Puerto efímero por corrida: el server de Core (fork hereda env) y el
    // bridge (lee env) usan este puerto, sin colisión entre corridas.
    this.port = await findFreePort();
    process.env.OPENCLAW_PORT = String(this.port);

    // Cargar Core (standalone, sin app de Electron).
    const Core = require(path.join(ROOT, 'core', 'Core.js'));
    const LLMProvider = require(path.join(ROOT, 'core', 'llm', 'LLMProvider.js'));

    // Configurar la key ANTES de init (init lee config solo si hay _configPath,
    // que en standalone es null → configurar manualmente).
    if (this.llmKey) {
      LLMProvider.configure({
        llm: {
          providers: { groq: { apiKey: this.llmKey } },
          // Fase J: en corridas del benchmark el TPM de Groq se agota seguido
          // (429 con "try again in X"). La cola serializa y espera el cooldown
          // con presupuesto largo para que la corrida no muera a mitad de camino.
          queue: { enabled: true, concurrency: 1, maxWaitMs: 15 * 60 * 1000, priority: 0 },
        },
      });
    }
    process.env.ASISTENTE_WORKSPACE = this.workspace;

    Core.init(null);

    // Esperar a que OpenClaw esté disponible para el bridge (Core.init lo
    // levanta de forma async; en standalone arranca en 18789).
    const bridge = Core.getBridge();
    for (let i = 0; i < 20; i++) {
      if (await bridge.isAvailable()) break;
      await sleep(500);
    }
    if (!(await bridge.isAvailable())) {
      console.warn('[harness] OpenClaw no disponible para el bridge');
    }

    this._core = Core;
    return this;
  }

  async run(prompt, extra = {}) {
    if (!this._core) throw new Error('Harness no iniciado: llamá start()');

    // Fase 3, ítem 3: snapshot del UsageTracker antes/después de la corrida
    // para atribuir tokens y coste ESTIMADO a esta ejecución (no al histórico
    // acumulado del proceso). El tracker vive en memoria en standalone.
    const LLMProvider = require(path.join(ROOT, 'core', 'llm', 'LLMProvider.js'));
    const tracker = LLMProvider.getUsageTracker();
    const before = tracker ? tracker.recent(0) : [];

    const t0 = Date.now();
    const result = await this._core.runAgent(prompt, {
      evalMode: true,
      mode: this.mode,
      maxIterations: this.maxIterations,
      ...extra,
    });
    const elapsedMs = Date.now() - t0;

    const after = tracker ? tracker.recent(0) : [];
    const usage = after.slice(before.length).reduce(
      (acc, e) => {
        acc.requests += 1;
        acc.promptTokens += e.promptTokens || 0;
        acc.completionTokens += e.completionTokens || 0;
        acc.costUsd += e.costUsd || 0;
        acc.errors += e.error ? 1 : 0;
        if (e.costEstimated) acc.costEstimated = true;
        return acc;
      },
      {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        errors: 0,
        costEstimated: false,
      }
    );
    usage.totalTokens = usage.promptTokens + usage.completionTokens;

    let activeModel = null;
    try {
      activeModel = LLMProvider.getActiveModel(this.mode);
    } catch (_) {
      activeModel = null;
    }

    return {
      ...result,
      elapsedMs,
      llm: {
        provider: LLMProvider.getActiveProvider() || 'unknown',
        model: activeModel || null,
        mode: this.mode,
        ...usage,
      },
    };
  }

  async close() {
    // Core.shutdown() mata el proceso OpenClaw que él mismo levantó y resetea
    // state.initialized. Es crítico AWAIT-arlo: si la siguiente corrida corre
    // Core.init() mientras el shutdown aún está en curso, el init se ignora
    // ("llamado más de una vez") y el server de la corrida siguiente nunca
    // arranca (OpenClaw no disponible).
    try {
      await this._core?.shutdown?.();
    } catch {}
    this._core = null;
    // Limpiar el env para que la siguiente corrida asigne un puerto nuevo.
    if (process.env.OPENCLAW_PORT === String(this.port)) {
      delete process.env.OPENCLAW_PORT;
    }
  }
}

async function create(opts) {
  const h = new Harness(opts);
  await h.start();
  return h;
}

module.exports = { Harness, create };
