// @ts-nocheck
'use strict';

// Chips de metadata para listar modelos en los comandos.
function modelChip(meta) {
  const chips = [];
  if (meta.tools) chips.push('tools');
  if (meta.vision) chips.push('visión');
  if (meta.reasoning) chips.push('razonamiento');
  if (meta.free) chips.push('gratis');
  return chips.length ? ` — *${chips.join(', ')}*` : '';
}

function formatContext(tokens) {
  if (typeof tokens !== 'number' || tokens <= 0) return '';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1).replace(/\.0$/, '')}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k ctx`;
  return `${tokens} ctx`;
}

// Accesos defensivos al LLMProvider: los tests (y ctx sin metadata) pueden
// exponer un mock mínimo sin estos métodos del catálogo.
function providerMeta(LLMProvider, pid, mid) {
  return (
    (typeof LLMProvider.getModelMeta === 'function' && LLMProvider.getModelMeta(pid, mid)) || {}
  );
}
function providerResolveRole(LLMProvider, token) {
  return typeof LLMProvider.resolveRole === 'function' ? LLMProvider.resolveRole(token) : null;
}
function providerResolveModel(LLMProvider, pid, token, catalog) {
  if (typeof LLMProvider.resolveModelId === 'function') {
    const id = LLMProvider.resolveModelId(pid, token);
    if (id) return id;
  }
  const t = String(token || '').toLowerCase();
  return (catalog || []).find((m) => m.toLowerCase().includes(t)) || null;
}
function providerRoleLabels(LLMProvider) {
  return LLMProvider.ROLE_LABELS || { fast: 'charla', smart: 'agente' };
}

module.exports = function registerCommands(register) {
  register({
    name: 'model',
    description: 'Cambia el proveedor LLM activo y su modelo (por rol: charla o tareas de agente)',
    usage: '/model [proveedor] [modelo|alias] [charla|agente]',
    handler: async (args, ctx) => {
      const LLMProvider = ctx.LLMProvider;
      if (!LLMProvider) return 'LLMProvider no disponible.';

      const arg0 = (args[0] || '').toLowerCase();
      const available = LLMProvider.getAvailableProviders();
      const valid = available.find((p) => p.id === arg0 || p.name.toLowerCase() === arg0);

      // ── Sin proveedor válido ──────────────────────────────────────────────
      if (!valid) {
        // Alias global: ¿arg0 es un modelo de algún proveedor? → proponer.
        if (arg0 && !providerResolveRole(LLMProvider, arg0)) {
          const hits = [];
          for (const p of available) {
            const m = providerResolveModel(LLMProvider, p.id, arg0, p.catalog);
            if (m) hits.push({ p, m });
          }
          if (hits.length === 1) {
            const h = hits[0];
            const meta = providerMeta(LLMProvider, h.p.id, h.m);
            return [
              `**${meta.label || h.m}** está en **${h.p.name}**.`,
              '',
              `Activalo con: \`/model ${h.p.id} ${h.m}\` (charla) o \`/model ${h.p.id} ${h.m} agente\``,
            ].join('\n');
          }
          if (hits.length > 1) {
            const lines = hits.map((h) => `  \`/model ${h.p.id} ${h.m}\``);
            return `"${arg0}" coincide con varios modelos. Elegí uno:\n${lines.join('\n')}`;
          }
        }

        const current = LLMProvider.getActiveProvider();
        const lines = available
          .map((p) => {
            const cost = p.free ? '*gratis*' : '*pago*';
            const toolsOk = Object.values(p.modelMeta || {}).some((m) => m && m.tools);
            const active = p.id === current ? ' >' : '';
            return `  \`${p.id}\`${active} — ${p.name} (${cost}${toolsOk ? ', tools ✓' : ''})`;
          })
          .join('\n');
        return [
          `Proveedor activo: **${current || 'ninguno'}**`,
          '',
          '**Disponibles:**',
          lines,
          '',
          'Elegí un proveedor: `/model <proveedor>` (lista sus modelos).',
          'O asigná un modelo directo: `/model <proveedor> <modelo> [charla|agente]` (default charla).',
        ].join('\n');
      }

      // ── Con proveedor pero sin modelo: activarlo y listar sus modelos ─────
      if (!args[1]) {
        LLMProvider.configure({ llm: { primary: valid.id } });
        if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: valid.id });
        // Valida el catálogo contra el endpoint real (con TTL) antes de
        // listar: descarta modelos que la cuenta no tiene accesibles (p.ej.
        // 404 "Function not found" en NVIDIA Build). Sin key no hace red y
        // usa el catálogo.
        await LLMProvider.refreshProviderModels(valid.id);
        const catalog = LLMProvider.listModels(valid.id);
        const active = valid.activeModel || {};
        const modelLines = catalog
          .map((m) => {
            const meta = providerMeta(LLMProvider, valid.id, m);
            const marks = [];
            if (m === active.fast) marks.push('charla');
            if (m === active.smart) marks.push('agente');
            const badge = marks.length ? ` — *${marks.join(' + ')}*` : '';
            const ctxLabel = meta.context ? `, ${formatContext(meta.context)}` : '';
            const label = meta.label && meta.label !== m ? `${meta.label} (\`${m}\`)` : `\`${m}\``;
            return `  ${label}${modelChip(meta)}${ctxLabel}${badge}`;
          })
          .join('\n');
        const hint = valid.hasKey
          ? ''
          : `\n\n**${valid.name}** no tiene API key configurada. Todos los proveedores (incluso los "gratis") necesitan su propia key — agrega la de ${valid.name} con \`/credenciales\` antes de usarlo.`;
        return `Proveedor activo: **${valid.name}**\n\n**Modelos disponibles (${catalog.length}):**\n${modelLines || '  *(sin modelos)*'}\n\nElige uno: \`/model ${valid.id} <modelo> [charla|agente]\` (default charla)${hint}`;
      }

      // ── Con proveedor + modelo: cambia el modelo por rol ──────────────────
      const roleWord = (args[2] || 'charla').toLowerCase();
      const mode =
        providerResolveRole(LLMProvider, roleWord) ||
        (['fast', 'smart'].includes(roleWord) ? roleWord : null);
      if (!mode) {
        return 'Rol inválido. Usa: `charla` (rápido) o `agente` (tareas de agente).\nEj: `/model groq llama-3.3-70b agente`';
      }
      const modelName = providerResolveModel(
        LLMProvider,
        valid.id,
        args[1],
        LLMProvider.listModels(valid.id)
      );
      if (!modelName) {
        const catalog = LLMProvider.listModels(valid.id);
        const closest = catalog
          .filter((m) => m.toLowerCase().includes(args[1].toLowerCase()))
          .slice(0, 5);
        const suggestion = closest.length
          ? `\n\n¿Quizá quisiste decir?\n${closest.map((m) => `  \`${m}\``).join('\n')}`
          : '';
        return `\`${args[1]}\` no está en los modelos disponibles de **${valid.name}**.${suggestion}`;
      }
      const meta = providerMeta(LLMProvider, valid.id, modelName);
      const warn =
        mode === 'smart' && meta.tools === false
          ? `\n\n⚠ **${meta.label || modelName}** no soporta tools — **no sirve para tareas de agente** (solo charla). Elegí un modelo con *tools* para el rol de agente.`
          : '';

      // Persistir en config.json (IPCs) y aplicar en memoria.
      const cfg = {
        llm: { primary: valid.id, providers: { [valid.id]: { model: { [mode]: modelName } } } },
      };
      LLMProvider.configure(cfg);
      if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: valid.id });
      if (ctx.ipcRenderer) {
        try {
          await ctx.ipcRenderer.invoke('set-llm-model', {
            provider: valid.id,
            mode,
            model: modelName,
          });
        } catch {}
      }
      const roleLabel = providerRoleLabels(LLMProvider)[mode] || mode;
      return `**${meta.label || modelName}** activado como *${roleLabel}* en **${valid.name}**.${warn}`;
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
      const SUBCOMMANDS = ['set', 'add', 'remove'];

      // CAMBIO 3: /provider <nombre-de-provider> (sin subcomando) == set.
      // Si el provider no tiene key, no cambia a un provider inservible.
      if (args[0] && !SUBCOMMANDS.includes(sub)) {
        const available = LLMProvider.getAvailableProviders();
        const direct = available.find((p) => p.id === sub || p.name.toLowerCase() === sub);
        if (direct) {
          if (!direct.hasKey) {
            return `${direct.name} no tiene API key. Usá: /credenciales ${direct.id} <tu-key>`;
          }
          LLMProvider.configure({ llm: { primary: direct.id } });
          if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: direct.id });
          return `Proveedor cambiado a: **${direct.name}**`;
        }
      }

      if (sub === 'add') {
        if (args.length < 3) {
          return 'Uso: `/provider add <nombre> <url> <fastModel> [smartModel]`\nFaltan argumentos requeridos: `<nombre>` y `<url>`.';
        }
        const name = args[1];
        const baseURL = args[2].replace(/\/+$/, '');
        const fastModel = args[3] || 'gpt-4o-mini';
        const smartModel = args[4] || fastModel;
        try {
          const id = LLMProvider.addCustomProvider({
            name,
            baseURL,
            type: 'openai',
            models: { fast: fastModel, smart: smartModel },
          });
          return `Provider custom agregado: **${name}** (\`${id}\`)\nEndpoint: \`${baseURL}\`\nModelos: fast=\`${fastModel}\`, smart=\`${smartModel}\`\n\nConfigura la API key con \`/credenciales\` y activalo con \`/model ${id}\``;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      if (sub === 'remove') {
        if (!args[1]) return 'Uso: `/provider remove <id>`';
        try {
          LLMProvider.removeCustomProvider(args[1]);
          return `Provider \`${args[1]}\` eliminado.`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      if (sub === 'set') {
        if (!args[1]) return 'Uso: `/provider set <id>`';
        const available = LLMProvider.getAvailableProviders();
        const target = available.find((p) => p.id === args[1].toLowerCase());
        if (!target) {
          const names = available
            .filter((p) => p.hasKey)
            .map((p) => `\`${p.id}\``)
            .join(', ');
          return `No encontrado. Proveedores con key: ${names || 'ninguno'}`;
        }
        if (!target.hasKey) {
          return `**${target.name}** no tiene API key configurada.\n\nAgregala con \`/credenciales\` y vuelve a intentar.`;
        }
        LLMProvider.configure({ llm: { primary: target.id } });
        if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: target.id });
        return `Proveedor cambiado a: **${target.name}**`;
      }

      const all = LLMProvider.getAvailableProviders();
      const active = LLMProvider.getActiveProvider();
      const activeDef = all.find((p) => p.id === active);

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
      lines.push('  `/provider set <id>` — Cambiar a ese proveedor');
      lines.push('  `/provider add <nombre> <url> <fastModel> [smartModel]` — Agregar custom');
      lines.push('  `/provider remove <id>` — Eliminar custom');
      lines.push('', '**Para configurar keys:** `/credenciales`');

      if (activeDef) {
        const roles = LLMProvider.ROLE_LABELS || { fast: 'charla', smart: 'agente' };
        const modelFast = activeDef.models?.fast || '?';
        const modelSmart = activeDef.models?.smart || '?';
        lines.push(
          '',
          `**Activo:** ${activeDef.name} — ${roles.fast}: \`${modelFast}\`, ${roles.smart}: \`${modelSmart}\``
        );
      }

      return lines.join('\n');
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
        const list = all
          .map((a) => {
            const marker = a.name === active ? '→' : ' ';
            return `${marker} **/${a.name}** — ${a.description}`;
          })
          .join('\n');
        return `**Agente activo:** \`${active}\`\n\n${list}`;
      }

      const switched = AgentManager.setActive(name);
      if (!switched) return `Agente desconocido: \`${name}\`. Usa \`/agent\` para ver la lista.`;

      return `Agente cambiado a: **${switched.label}**\n\n${switched.description}`;
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
      return [
        `Cambiado a: **${switched.label}**`,
        '',
        'Ahora puedes pedirme tareas de programacion como:',
        '  - "Refactoriza esta funcion @src/utils.js"',
        '  - "Añade tests para @src/api.js"',
        '  - "Arregla el bug en @src/server.js"',
        '',
        'Usa `@archivo` para referenciar archivos especificos.',
      ].join('\n');
    },
  });

  register({
    name: 'skill',
    description: 'Muestra informacion de skills cargadas',
    usage: '/skill [nombre]',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      const skills = await ctx.ipcRenderer.invoke('list-skills');
      if (!skills || skills.length === 0) return 'No hay skills cargadas.';
      const name = (args[0] || '').toLowerCase();
      if (name) {
        const skill = skills.find((s) => s.name.toLowerCase() === name);
        if (!skill) return `Skill no encontrada: \`${args[0]}\`. Usa \`/skill\` para ver la lista.`;
        const lines = [`**${skill.name}** v${skill.version}`, '', skill.description];
        if (skill.domains && skill.domains.length > 0) {
          lines.push('', `**Dominios:** ${skill.domains.join(', ')}`);
        }
        return lines.join('\n');
      }
      const lines = skills.map((s) => `• **${s.name}** — ${s.description}`);
      return `**Skills disponibles (${skills.length}):**\n\n${lines.join('\n')}`;
    },
  });
};
