'use strict';

module.exports = function registerCommands(register) {
  register({
    name: 'model',
    description: 'Cambia el proveedor LLM activo',
    usage: '/model <nombre>',
    handler: async (args, ctx) => {
      const LLMProvider = ctx.LLMProvider;
      if (!LLMProvider) return 'LLMProvider no disponible.';

      const provider = (args[0] || '').toLowerCase();
      const available = LLMProvider.getAvailableProviders();
      const valid = available.find((p) => p.id === provider);

      if (!valid) {
        const current = LLMProvider.getActiveProvider();
        const lines = available
          .map((p) => {
            const cost = p.free ? '*gratis*' : '*pago*';
            const active = p.id === current ? ' >' : '';
            return `  \`/${p.id}\`${active} — ${p.name} (${cost})`;
          })
          .join('\n');
        return `Proveedor activo: **${current || 'ninguno'}**\n\n**Disponibles:**\n${lines}`;
      }
      LLMProvider.configure({ llm: { primary: provider } });
      if (ctx.sendIPC) ctx.sendIPC('set-provider', { primary: provider });
      const active = LLMProvider.getActiveProvider();
      const warn = valid.hasKey
        ? ''
        : `\n\n**${valid.name}** no tiene API key configurada. Todos los proveedores (incluso los "gratis") necesitan su propia key — agrega la de ${valid.name} con \`/credenciales\` antes de usarlo.`;
      return `Proveedor cambiado a: **${valid.name}**${warn}`;
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

      if (sub === 'add' && args.length >= 3) {
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
        const modelFast = activeDef.models?.fast || '?';
        const modelSmart = activeDef.models?.smart || '?';
        lines.push(
          '',
          `**Activo:** ${activeDef.name} — fast: \`${modelFast}\`, smart: \`${modelSmart}\``
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
