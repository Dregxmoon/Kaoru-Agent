'use strict';

const commands = new Map();

function _parse(text) {
  const trimmed = text.trim().slice(1);
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const name = (parts[0] || '').toLowerCase();
  const args = parts.slice(1).map(a => a.replace(/^["']|["']$/g, ''));
  return { name, args, raw: text };
}

function register(def) {
  if (commands.has(def.name)) {
    console.warn(`[commands] comando "${def.name}" ya registrado — se reemplaza`);
  }
  commands.set(def.name, def);
}

function getHelp() {
  const groups = {
    'IA / LLM':      ['mode', 'model', 'provider', 'agent', 'code', 'skill'],
    'Desarrollo':    ['init', 'review', 'plan', 'fix', 'undo', 'retry'],
    'General':       ['help', 'clear', 'memory', 'stats', 'export'],
    'Config':        ['credenciales'],
  };
  const lines = ['**Comandos disponibles:**\n'];
  for (const [group, names] of Object.entries(groups)) {
    lines.push(`┌─ ${group}`);
    for (const name of names) {
      const def = commands.get(name);
      if (!def) continue;
      const usage = def.usage || `/${name}`;
      const desc = def.description || '';
      lines.push(`│ \`${usage}\` — ${desc}`);
    }
    lines.push('└─\n');
  }
  return lines.join('\n');
}

function getNames() {
  return [...commands.keys()];
}

function getCommand(name) {
  return commands.get(name);
}

async function execute(text, ctx = {}) {
  const { name, args, raw } = _parse(text);
  if (!name) return { error: 'Comando vacío. Escribe /help para ver la lista.' };

  const def = commands.get(name);
  if (!def) {
    const similar = getNames().filter(n => n.startsWith(name[0])).slice(0, 3);
    const hint = similar.length > 0 ? ` Quizá quisiste decir: \`/${similar.join('`, `')}\`` : '';
    return { error: `Comando desconocido: \`/${name}\`.${hint} Escribe \`/help\` para ver la lista.` };
  }

  try {
    const result = await def.handler(args, ctx, raw);
    return { result };
  } catch (e) {
    return { error: `Error ejecutando \`/${name}\`: ${e.message}` };
  }
}

// ── Comandos incorporados ────────────────────────────────────────────────────

register({
  name: 'help',
  description: 'Muestra esta lista de comandos',
  usage: '/help',
  handler: async (args, ctx) => {
    return getHelp();
  },
});

register({
  name: 'clear',
  description: 'Borra el historial de la conversación actual',
  usage: '/clear',
  handler: async (args, ctx) => {
    ctx.sessionHistory?.splice(0, ctx.sessionHistory.length);
    if (ctx.pushToSession) ctx.pushToSession('system', 'Historial borrado.');
    return 'Historial de conversacion borrado.';
  },
});

register({
  name: 'mode',
  description: 'Cambia entre modo conversación y tareas',
  usage: '/mode <conversational|task>',
  completions: ['conversational', 'task'],
  handler: async (args, ctx) => {
    const valid = { conversational: 'conversational', conversation: 'conversational', task: 'task', tasks: 'task' };
    const mode = valid[args[0]];
    if (!mode) {
      return `Modo actual: \`${ctx.chatMode}\`. Usa \`/mode conversational\` o \`/mode task\`.`;
    }
    if (ctx.applyModeUI) ctx.applyModeUI(mode);
    if (ctx.sendIPC) ctx.sendIPC('chat-mode-changed', mode);
    return `Modo cambiado a: **${mode === 'task' ? 'Tareas (GPT-OSS)' : 'Conversacion'}**`;
  },
});

register({
  name: 'model',
  description: 'Cambia el proveedor LLM activo',
  usage: '/model <nombre>',
  handler: async (args, ctx) => {
    const LLMProvider = ctx.LLMProvider;
    if (!LLMProvider) return 'LLMProvider no disponible.';

    const provider = (args[0] || '').toLowerCase();
    const available = LLMProvider.getAvailableProviders();
    const valid = available.find(p => p.id === provider);

    if (!valid) {
      const current = LLMProvider.getActiveProvider();
      const lines = available.map(p => {
        const cost = p.free ? '*gratis*' : '*pago*';
        const active = p.id === current ? ' >' : '';
        return `  \`/${p.id}\`${active} — ${p.name} (${cost})`;
      }).join('\n');
      return `Proveedor activo: **${current || 'ninguno'}**\n\n**Disponibles:**\n${lines}`;
    }
    LLMProvider.configure({ llm: { primary: provider } });
    if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: provider });
    const active = LLMProvider.getActiveProvider();
    return `Proveedor cambiado a: **${valid.name}**`;
  },
});

register({
  name: 'memory',
  description: 'Muestra el historial reciente de la conversación',
  usage: '/memory',
  handler: async (args, ctx) => {
    const history = ctx.sessionHistory || [];
    if (history.length === 0) return 'No hay mensajes en el historial.';
    const lines = history.map((m, i) => {
      const role = m.role === 'user' ? '[U]' : m.role === 'assistant' ? '[A]' : '[S]';
      const preview = (m.content || '').slice(0, 200).replace(/\n/g, ' ');
      return `${role} **${m.role}**: ${preview}${m.content.length > 200 ? '...' : ''}`;
    });
    return `**Historial (${history.length} mensajes):**\n\n${lines.join('\n')}`;
  },
});

register({
  name: 'retry',
  description: 'Reintenta la última respuesta del LLM',
  usage: '/retry',
  handler: async (args, ctx) => {
    const history = ctx.sessionHistory || [];
    if (history.length < 2) return 'No hay suficiente historial para reintentar.';

    const lastUserIdx = history.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0).pop();
    if (lastUserIdx === undefined) return 'No se encontró un mensaje de usuario para reintentar.';

    const lastUserMsg = history[lastUserIdx].content;
    if (!lastUserMsg || lastUserMsg.startsWith('/')) {
      return 'El último mensaje era un comando, no se puede reintentar.';
    }
    if (ctx.processMessage) {
      ctx.processMessage(lastUserMsg);
      return `Reintentando ultimo mensaje...`;
    }
    return 'No se puede reintentar — processMessage no disponible.';
  },
});

register({
  name: 'stats',
  description: 'Muestra estadísticas de uso de herramientas',
  usage: '/stats',
  handler: async (args, ctx) => {
    if (!ctx.ipcRenderer) return 'IPC no disponible.';
    try {
      const stats = await ctx.ipcRenderer.invoke('get-bridge-stats');
      if (!stats) return 'No hay estadísticas disponibles.';
      return [
        '**Estadisticas de herramientas:**',
        `- Total acciones: **${stats.total || 0}**`,
        `- Exitosas: **${stats.ok || 0}**`,
        `- Fallidas: **${stats.failed || 0}**`,
        `- Herramientas: ${(stats.tools || []).join(', ') || 'ninguna'}`,
        `- OpenClaw disponible: ${stats.available ? 'si' : 'no'}`,
      ].join('\n');
    } catch (e) {
      return `Error obteniendo estadísticas: ${e.message}`;
    }
  },
});

register({
  name: 'export',
  description: 'Exporta la conversación como texto',
  usage: '/export',
  handler: async (args, ctx) => {
    const history = ctx.sessionHistory || [];
    if (history.length === 0) return 'No hay conversación para exportar.';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const lines = [
      `# Conversación — March 7th (${timestamp})`,
      `# Total mensajes: ${history.length}`,
      '',
    ];
    for (const m of history) {
      const role = m.role === 'user' ? '## Usuario' : m.role === 'assistant' ? '## March 7th' : '## Sistema';
      lines.push(`${role}\n${m.content}\n`);
    }
    const text = lines.join('\n');

    if (ctx.fs && ctx.path) {
      const exportDir = ctx.path.join(ctx.process.cwd(), 'exports');
      if (!ctx.fs.existsSync(exportDir)) ctx.fs.mkdirSync(exportDir, { recursive: true });
      const filePath = ctx.path.join(exportDir, `conversacion-${timestamp}.md`);
      ctx.fs.writeFileSync(filePath, text, 'utf-8');
      return `Conversacion exportada a: \`${filePath}\` (${text.length} caracteres)`;
    }

    if (text.length <= 1800) return `**Conversacion exportada:**\n\n${text}`;
    return `Conversacion de ${text.length} caracteres. Tamano muy grande para mostrar aqui.`;
  },
});

register({
  name: 'agent',
  description: 'Cambia el agente activo',
  usage: '/agent <conversation|coder|reviewer|planner>',
  completions: ['conversation', 'coder', 'reviewer', 'planner'],
  handler: async (args, ctx) => {
    const AgentManager = require('../agents/AgentManager.js');
    const name = (args[0] || '').toLowerCase();

    if (!name) {
      const all = AgentManager.getAll();
      const active = AgentManager.getActive().name;
      const list = all.map(a => {
        const marker = a.name === active ? '→' : ' ';
        return `${marker} **/${a.name}** — ${a.description}`;
      }).join('\n');
      return `**Agente activo:** \`${active}\`\n\n${list}`;
    }

    const switched = AgentManager.setActive(name);
    if (!switched) return `Agente desconocido: \`${name}\`. Usa \`/agent\` para ver la lista.`;

    if (ctx.applyModeUI) ctx.applyModeUI(AgentManager.getMode());
    if (ctx.sendIPC) ctx.sendIPC('chat-mode-changed', AgentManager.getMode());

    return `Agente cambiado a: **${switched.label}**\n\n${switched.description}`;
  },
});

register({
  name: 'init',
  description: 'Analiza el proyecto y muestra su estructura',
  usage: '/init',
  handler: async (args, ctx) => {
    if (!ctx.fs || !ctx.path) return 'Sistema de archivos no disponible.';
    const cwd = ctx.process?.cwd?.() || process.cwd();

    const readDir = (dir, depth = 0) => {
      if (depth > 3) return [];
      const items = [];
      let entries;
      try { entries = ctx.fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'exports') continue;
        const full = ctx.path.join(dir, e.name);
        const rel = ctx.path.relative(cwd, full);
        if (e.isDirectory()) {
          items.push({ path: rel, type: 'dir' });
          items.push(...readDir(full, depth + 1));
        } else if (e.isFile()) {
          try {
            const stat = ctx.fs.statSync(full);
            items.push({ path: rel, type: 'file', size: stat.size });
          } catch { items.push({ path: rel, type: 'file' }); }
        }
      }
      return items;
    };

    const files = readDir(cwd);
    const pkgPath = ctx.path.join(cwd, 'package.json');
    let pkgInfo = '';
    if (ctx.fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(ctx.fs.readFileSync(pkgPath, 'utf-8'));
        pkgInfo = `\n- **Nombre:** ${pkg.name || '(sin nombre)'}\n- **Versión:** ${pkg.version || '-'}`;
        if (pkg.description) pkgInfo += `\n- **Descripción:** ${pkg.description}`;
      } catch {}
    }

    const totalFiles = files.filter(f => f.type === 'file').length;
    const totalDirs = files.filter(f => f.type === 'dir').length;
    const byExt = {};
    for (const f of files) {
      if (f.type !== 'file') continue;
      const ext = ctx.path.extname(f.path).toLowerCase() || '(sin ext)';
      byExt[ext] = (byExt[ext] || 0) + 1;
    }
    const topExt = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([ext, count]) => `${ext} (${count})`).join(', ');

    const treeLines = [];
    const topDirs = files.filter(f => f.type === 'dir' && f.path.split(ctx.path.sep).length === 2).slice(0, 20);
    for (const d of topDirs) treeLines.push(`[DIR] ${d.path}`);
    const topFiles = files.filter(f => f.type === 'file' && f.path.split(ctx.path.sep).length <= 2).slice(0, 30);
    for (const f of topFiles) treeLines.push(`      ${f.path} (${_formatSize(f.size)})`);

    // store project context to persistent memory (fire & forget)
    if (ctx.sendIPC) {
      const projDesc = pkgInfo ? pkgInfo.trim() : `Proyecto en ${cwd}`;
      ctx.sendIPC('store-fact', {
        type: 'Project',
        label: 'proyecto_actual',
        content: `Proyecto actual: ${projDesc}. Tecnologias: ${topExt || 'varias'}. Estructura: ${totalDirs} directorios, ${totalFiles} archivos.`,
        importance: 0.9,
        tags: ['proyecto', 'contexto'],
      });
    }

    return [
      `**Resumen del proyecto:**${pkgInfo}`,
      `- **Total:** ${totalDirs} directorios, ${totalFiles} archivos`,
      topExt ? `- **Extensiones:** ${topExt}` : '',
      '',
      '**Estructura (primer nivel):**',
      '```',
      ...treeLines.slice(0, 40),
      '```',
      treeLines.length > 40 ? `*... y ${treeLines.length - 40} items mas*` : '',
    ].filter(Boolean).join('\n');
  },
});

function _formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

register({
  name: 'review',
  description: 'Solicita revisión de un archivo',
  usage: '/review <archivo>',
  handler: async (args, ctx) => {
    if (!args[0]) return 'Especifica un archivo: \`/review src/main.js\`';
    if (!ctx.fs || !ctx.path) return 'Sistema de archivos no disponible.';
    const cwd = ctx.process?.cwd?.() || process.cwd();
    const filePath = ctx.path.resolve(cwd, args[0]);
    if (!ctx.fs.existsSync(filePath)) return `Archivo no encontrado: \`${args[0]}\``;

    const content = ctx.fs.readFileSync(filePath, 'utf-8');
    const relPath = ctx.path.relative(cwd, filePath);

    return [
      `**Revision solicitada:** \`${relPath}\` (${content.split('\n').length} lineas, ${content.length} caracteres)`,
      '',
      'Para obtener una revisión detallada, envía un mensaje como:',
      `\`Revisa el código en @${relPath} y busca bugs, problemas de seguridad y mejoras\``,
      '',
      'O cambia al agente reviewer con \`/agent reviewer\` y luego pide la revisión.',
    ].join('\n');
  },
});

register({
  name: 'plan',
  description: 'Crea un plan de implementación',
  usage: '/plan <descripción>',
  handler: async (args, ctx) => {
    if (args.length === 0) {
      return [
        '**Planificador de tareas**',
        '',
        'Para crear un plan, describe que quieres implementar:',
        '  `/plan Anadir autenticacion con Google`',
        '  `/plan Refactorizar el modulo de pagos`',
        '',
        'O cambia al agente planner con `/agent planner` para activar el modo planificacion.',
      ].join('\n');
    }
    const userRequest = args.join(' ');
    return [
      '**Plan solicitado:**',
      `\`\`\`${userRequest}\`\`\``,
      '',
      'Para obtener un plan detallado, cambia al agente planner:',
      '  \`/agent planner\`',
      '',
      'Luego pide el plan con:',
      `  \`Crea un plan para: ${userRequest}\``,
    ].join('\n');
  },
});

register({
  name: 'undo',
  description: 'Revierte el último commit (git)',
  usage: '/undo',
  handler: async (args, ctx) => {
    if (!ctx.ipcRenderer) return 'IPC no disponible.';
    try {
      const stat = await ctx.ipcRenderer.invoke('exec-command', {
        command: 'git log --oneline -1',
        timeout: 5,
      });
      if (!stat || stat.exitCode !== 0) return 'No hay commits para revertir o no es un repo git.';
      const lastCommit = (stat.stdout || '').trim();
      const result = await ctx.ipcRenderer.invoke('exec-command', {
        command: 'git reset --soft HEAD~1',
        timeout: 5,
      });
      if (result.exitCode === 0) {
        return `Commit revertido (soft): \`${lastCommit}\`\nLos cambios quedan en staging. Usa \`git reset HEAD .\` para sacarlos si quieres.`;
      }
      return `Error al revertir: ${result.stderr || 'desconocido'}`;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});

register({
  name: 'fix',
  description: 'Ejecuta el linter y muestra errores',
  usage: '/fix',
  handler: async (args, ctx) => {
    if (!ctx.ipcRenderer) return 'IPC no disponible.';
    try {
      const result = await ctx.ipcRenderer.invoke('exec-command', {
        command: 'npx eslint . --format compact 2>&1 || true',
        timeout: 30,
      });
      const output = (result.stdout || '') + (result.stderr || '');
      const lines = output.trim().split('\n').filter(l => l.includes(': error') || l.includes(': warning'));
      if (lines.length === 0) return 'No se encontraron errores de lint.';
      const errorCount = lines.filter(l => l.includes(': error')).length;
      const warningCount = lines.filter(l => l.includes(': warning')).length;
      return [
        `**Lint completo — ${lines.length} issues**`,
        `- ${errorCount} errores, ${warningCount} warnings`,
        '',
        '```',
        ...lines.slice(0, 30),
        '```',
        lines.length > 30 ? `... y ${lines.length - 30} más` : '',
      ].filter(Boolean).join('\n');
    } catch (e) {
      return `Error ejecutando linter: ${e.message}. ¿Está instalado eslint?`;
    }
  },
});

register({
  name: 'code',
  description: 'Atajo para cambiar al agente coder',
  usage: '/code',
  handler: async (args, ctx) => {
    const AgentManager = require('../agents/AgentManager.js');
    const switched = AgentManager.setActive('coder');
    if (!switched) return 'Error al cambiar a agente coder.';
    if (ctx.applyModeUI) ctx.applyModeUI(AgentManager.getMode());
    if (ctx.sendIPC) ctx.sendIPC('chat-mode-changed', AgentManager.getMode());
    return [
      `Cambiado a: **${switched.label}**`,
      '',
      'Ahora puedes pedirme tareas de programación como:',
      '  • "Refactoriza esta función @src/utils.js"',
      '  • "Añade tests para @src/api.js"',
      '  • "Arregla el bug en @src/server.js"',
      '',
      'Usa \`@archivo\` para referenciar archivos específicos.',
    ].join('\n');
  },
});

register({
  name: 'credenciales',
  description: 'Abre la configuración de API keys',
  usage: '/credenciales',
  handler: async (args, ctx) => {
    if (typeof ctx.openSettings === 'function') {
      ctx.openSettings();
      return 'Abriendo configuración de credenciales...';
    }
    return 'No se puede abrir la configuración desde este contexto.';
  },
});

register({
  name: 'skill',
  description: 'Muestra información de skills cargadas',
  usage: '/skill [nombre]',
  handler: async (args, ctx) => {
    if (!ctx.ipcRenderer) return 'IPC no disponible.';
    const skills = await ctx.ipcRenderer.invoke('list-skills');
    if (!skills || skills.length === 0) return 'No hay skills cargadas.';
    const name = (args[0] || '').toLowerCase();
    if (name) {
      const skill = skills.find(s => s.name.toLowerCase() === name);
      if (!skill) return `Skill no encontrada: \`${args[0]}\`. Usa \`/skill\` para ver la lista.`;
      const lines = [
        `**${skill.name}** v${skill.version}`,
        '',
        skill.description,
      ];
      if (skill.domains && skill.domains.length > 0) {
        lines.push('', `**Dominios:** ${skill.domains.join(', ')}`);
      }
      return lines.join('\n');
    }
    const lines = skills.map(s =>
      `• **${s.name}** — ${s.description}`
    );
    return `**Skills disponibles (${skills.length}):**\n\n${lines.join('\n')}`;
  },
});

register({
  name: 'provider',
  description: 'Gestiona proveedores LLM: listar, cambiar, agregar custom',
  usage: '/provider [set|add|remove]',
  handler: async (args, ctx) => {
    const LLMProvider = ctx.LLMProvider;
    if (!LLMProvider) return 'LLMProvider no disponible.';
    const sub = (args[0] || '').toLowerCase();

    // /provider add <name> <baseURL> <fastModel> [smartModel]
    if (sub === 'add' && args.length >= 3) {
      const name = args[1];
      const baseURL = args[2].replace(/\/+$/, '');
      const fastModel = args[3] || 'gpt-4o-mini';
      const smartModel = args[4] || fastModel;
      try {
        const id = LLMProvider.addCustomProvider({
          name, baseURL, type: 'openai',
          models: { fast: fastModel, smart: smartModel },
        });
        return `Provider custom agregado: **${name}** (\`${id}\`)\nEndpoint: \`${baseURL}\`\nModelos: fast=\`${fastModel}\`, smart=\`${smartModel}\`\n\nConfigura la API key con \`/credenciales\` y activalo con \`/model ${id}\``;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    if (sub === 'remove' && args[1]) {
      try {
        LLMProvider.removeCustomProvider(args[1]);
        return `Provider \`${args[1]}\` eliminado.`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    if (sub === 'set' && args[1]) {
      const available = LLMProvider.getAvailableProviders();
      const target = available.find(p => p.id === args[1].toLowerCase());
      if (!target) {
        const names = available.filter(p => p.hasKey).map(p => `\`${p.id}\``).join(', ');
        return `No encontrado. Proveedores con key: ${names || 'ninguno'}`;
      }
      if (!target.hasKey) {
        return `**${target.name}** no tiene API key configurada.\n\nAgregala con \`/credenciales\` y vuelve a intentar.`;
      }
      LLMProvider.configure({ llm: { primary: target.id } });
      if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: target.id });
      return `Proveedor cambiado a: **${target.name}**`;
    }

    // /provider — list all
    const all = LLMProvider.getAvailableProviders();
    const active = LLMProvider.getActiveProvider();
    const activeDef = all.find(p => p.id === active);

    const lines = ['**Proveedores LLM disponibles:**\n'];
    for (const p of all) {
      const isActive = p.id === active;
      const status = isActive ? 'ACTIVO' : p.hasKey ? 'key lista' : 'sin key';
      const badges = [];
      if (p.free) badges.push('gratis');
      if (p.builtin) badges.push('built-in');
      if (p.custom) badges.push('custom');
      const badgeStr = badges.length ? ` (${badges.join(', ')})` : '';
      const marker = isActive ? '>' : ' ';
      lines.push(`${marker} **${p.name}**${badgeStr} — ${status}`);
    }

    lines.push('', '**Comandos:**');
    lines.push('  \`/provider set <id>\` — Cambiar a ese proveedor');
    lines.push('  \`/provider add <nombre> <url> <fastModel> [smartModel]\` — Agregar custom');
    lines.push('  \`/provider remove <id>\` — Eliminar custom');
    lines.push('', '**Para configurar keys:** \`/credenciales\`');

    if (activeDef) {
      const modelFast = activeDef.models?.fast || '?';
      const modelSmart = activeDef.models?.smart || '?';
      lines.push('', `**Activo:** ${activeDef.name} — fast: \`${modelFast}\`, smart: \`${modelSmart}\``);
    }

    return lines.join('\n');
  },
});

module.exports = { register, execute, getHelp, getNames, getCommand, _parse };
