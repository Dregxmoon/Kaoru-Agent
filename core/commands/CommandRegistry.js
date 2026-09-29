// @ts-nocheck
'use strict';
const logger = require('../observability/Logger.js');

const commands = new Map();
const canonicalNames = new Set();

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
  canonicalNames.add(def.name);
  for (const alias of def.aliases || []) {
    if (commands.has(alias)) throw new Error(`command alias already registered: ${alias}`);
    commands.set(alias, def);
  }
}

const CATEGORIES = {
  help: 'General',
  clear: 'General',
  history: 'General',
  'memory-graph': 'General',
  forget: 'General',
  stats: 'General',
  export: 'General',
  telemetry: 'General',
  proactive: 'General',
  sessions: 'General',
  permissions: 'General',
  workspace: 'General',
  usage: 'AI / LLM',
  model: 'AI / LLM',
  agent: 'AI / LLM',
  skill: 'AI / LLM',
  skills: 'AI / LLM',
  github: 'Accounts',
  retry: 'Development',
  'revert-task': 'Development',
  tasks: 'Development',
  'goal-autonomy': 'Development',
  'resume-task': 'Development',
  'avatar-model': 'Avatar',
  'avatar-view': 'Avatar',
  gestures: 'Avatar',
};
const EN_DESCRIPTIONS = {
  clear: 'Clear the current conversation history',
  mute: 'Toggle speech output',
  context: 'Show the conversation context budget',
  history: 'Show recent messages (also /memory for compatibility)',
  stats: 'Show tool usage statistics',
  telemetry: 'Compare local usage with last month',
  export: 'Export the conversation as text',
  forget: 'Archive matching memories',
  'memory-graph': 'Open the memory explorer',
  sessions: 'Open previous chats and terminals',
  permissions: 'Open tool permission rules',
  workspace: 'Choose a project folder',
  usage: 'Show LLM calls, tokens, and estimated cost',
  model: 'Choose the AI model',
  agent: 'Choose the active agent',
  skill: 'Show a loaded skill',
  skills: 'Manage local skills',
  github: 'Connect and manage a GitHub account',
  proactive: 'Inspect or configure proactive behavior',
  retry: 'Retry the last model response',
  'revert-task': 'Inspect and restore a task checkpoint',
  tasks: 'Show pending tasks',
  'goal-autonomy': 'Configure task autonomy',
  'resume-task': 'Resume a pending task',
  'avatar-model': 'Choose the Live2D avatar',
  'avatar-view': 'Choose the avatar framing',
  gestures: 'Inspect and test avatar gestures',
  help: 'Show the command list',
};
const JA_DESCRIPTIONS = {
  clear: '現在の会話履歴を消去',
  mute: '音声出力を切り替え',
  context: '会話のコンテキスト容量を表示',
  history: '最近のメッセージを表示',
  stats: 'ツールの使用統計を表示',
  telemetry: '先月との利用状況を比較',
  export: '会話をテキストで書き出し',
  forget: '一致する記憶をアーカイブ',
  'memory-graph': '記憶エクスプローラーを開く',
  sessions: '過去のチャットとターミナルを開く',
  permissions: 'ツール権限を開く',
  workspace: 'プロジェクトのフォルダーを選択',
  usage: 'LLMの呼び出しとトークン使用量を表示',
  model: 'AIモデルを選択',
  agent: 'エージェントを選択',
  skill: 'スキルの情報を表示',
  skills: 'ローカルスキルを管理',
  github: 'GitHubアカウントを接続・管理',
  proactive: '自発的な動作を確認・設定',
  retry: '最後の応答を再試行',
  'revert-task': 'タスクのチェックポイントを復元',
  tasks: '保留中のタスクを表示',
  'goal-autonomy': 'タスクの自律性を設定',
  'resume-task': '保留中のタスクを再開',
  'avatar-model': 'Live2Dアバターを選択',
  'avatar-view': 'アバターの表示範囲を選択',
  gestures: 'ジェスチャーを表示・試行',
  help: 'コマンド一覧を表示',
};

function getDescription(name, locale = 'en') {
  const def = commands.get(name);
  if (!def) return '';
  if (locale === 'ja') return JA_DESCRIPTIONS[def.name] || def.description || '';
  if (locale === 'es') return def.descriptions?.es || def.description || '';
  return EN_DESCRIPTIONS[def.name] || def.description || '';
}

function getHelp(locale = 'en') {
  const groups = new Map();
  for (const name of canonicalNames) {
    const group = CATEGORIES[name] || 'General';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  }
  const lines = [
    `**${{ en: 'Available commands', es: 'Comandos disponibles', ja: '利用できるコマンド' }[locale] || 'Available commands'}:**\n`,
  ];
  for (const [group, names] of groups) {
    const groupLabel =
      {
        es: {
          'AI / LLM': 'IA / LLM',
          Accounts: 'Cuentas',
          Development: 'Desarrollo',
          Avatar: 'Avatar',
        },
        ja: {
          General: '一般',
          'AI / LLM': 'AI / LLM',
          Accounts: 'アカウント',
          Development: '開発',
          Avatar: 'アバター',
        },
      }[locale]?.[group] || group;
    lines.push(`┌─ ${groupLabel}`);
    for (const name of names) {
      const def = commands.get(name);
      const usage = def.usage || `/${name}`;
      const desc = getDescription(name, locale);
      const aliases = def.aliases?.length
        ? ` (${def.aliases.map((alias) => `/${alias}`).join(', ')})`
        : '';
      lines.push(`│ \`${usage}\`${aliases} — ${desc}`);
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
        : `\n\n**${provider.name}** no tiene API key configurada. Conectala desde el selector de modelos (tocá el modelo en la barra superior o escribí \`/model\`).`;
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
require('./dev')(register);
require('./model')(register);
require('./skills')(register);
require('./github')(register);
require('./proactive')(register);

// Comandos retirados: eran alias redundantes, devolvían instrucciones sin
// ejecutar la acción, asumían ESLint para cualquier proyecto o mutaban Git
// desde un atajo. Se eliminan también del índice/autocompletado.
for (const name of ['init', 'review', 'plan', 'fix', 'undo', 'code']) {
  commands.delete(name);
  canonicalNames.delete(name);
}

register({
  name: 'help',
  description: 'Show the command list',
  descriptions: { es: 'Muestra la lista de comandos', ja: 'コマンド一覧を表示します' },
  usage: '/help',
  handler: async (args, ctx) => {
    return getHelp(ctx.uiLanguage);
  },
});

module.exports = { register, execute, getHelp, getNames, getCommand, getDescription, _parse };
