// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const commands = new Map();

function _parse(text) {
  const trimmed = text.trim().slice(1);
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const name = (parts[0] || '').toLowerCase();
  const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ''));
  return { name, args, raw: text };
}

function register(def) {
  if (commands.has(def.name)) {
    logger.warn('CommandRegistry', `[commands] comando "${def.name}" ya registrado — se reemplaza`);
  }
  commands.set(def.name, def);
}

const CATEGORIES = {
  help: 'General',
  clear: 'General',
  memory: 'General',
  olvida: 'General',
  stats: 'General',
  export: 'General',
  telemetria: 'General',
  proactive: 'General',
  model: 'IA / LLM',
  provider: 'IA / LLM',
  agent: 'IA / LLM',
  code: 'IA / LLM',
  skill: 'IA / LLM',
  credenciales: 'Config',
  github: 'Cuentas',
  init: 'Desarrollo',
  review: 'Desarrollo',
  plan: 'Desarrollo',
  fix: 'Desarrollo',
  undo: 'Desarrollo',
  retry: 'Desarrollo',
  'cambio-modelo': 'Modelo',
  'modelo-vistas': 'Modelo',
  gestos: 'Modelo',
};

function getHelp() {
  const groups = new Map();
  for (const name of commands.keys()) {
    const group = CATEGORIES[name] || 'General';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  }
  const lines = ['**Comandos disponibles:**\n'];
  for (const [group, names] of groups) {
    lines.push(`┌─ ${group}`);
    for (const name of names) {
      const def = commands.get(name);
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
  if (!name) return { error: 'Comando vacio. Escribe /help para ver la lista.' };

  const def = commands.get(name);
  if (!def) {
    const LLMProvider = ctx?.LLMProvider;
    const provider = LLMProvider?.getAvailableProviders?.().find((p) => p.id === name);
    if (provider) {
      LLMProvider.configure({ llm: { primary: provider.id } });
      if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: provider.id });
      const warn = provider.hasKey
        ? ''
        : `\n\n**${provider.name}** no tiene API key configurada. Todos los proveedores (incluso los "gratis") necesitan su propia key — agrega la de ${provider.name} con \`/credenciales\` antes de usarlo.`;
      return { result: `Proveedor cambiado a: **${provider.name}**${warn}` };
    }
    const similar = getNames()
      .filter((n) => n.startsWith(name[0]))
      .slice(0, 3);
    const hint = similar.length > 0 ? ` Quizas quisiste decir: \`/${similar.join('`, `')}\`` : '';
    return {
      error: `Comando desconocido: \`/${name}\`.${hint} Escribe \`/help\` para ver la lista.`,
    };
  }

  try {
    const result = await def.handler(args, ctx, raw);
    return { result };
  } catch (e) {
    return { error: `Error ejecutando \`/${name}\`: ${e.message}` };
  }
}

require('./general')(register);
require('./llm')(register);
require('./config')(register);
require('./dev')(register);
require('./model')(register);
require('./github')(register);
require('./proactive')(register);

register({
  name: 'help',
  description: 'Muestra esta lista de comandos',
  usage: '/help',
  handler: async (args, ctx) => {
    return getHelp();
  },
});

module.exports = { register, execute, getHelp, getNames, getCommand, _parse };
