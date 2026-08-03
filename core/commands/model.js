'use strict';

module.exports = function registerCommands(register) {
  register({
    name: 'cambio-modelo',
    description: 'Cambia el modelo Live2D del asistente',
    usage: '/cambio-modelo [nombre]',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      try {
        const models = await ctx.ipcRenderer.invoke('models-list');
        if (!models || models.length === 0) return 'No hay modelos Live2D en la carpeta models/.';
        const q = (args[0] || '').trim().toLowerCase();
        if (!q) {
          const active = models.find(m => m.active);
          const esc = s => String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
          const list = models.map(m => {
            const label = m.active ? `${m.name} (activo)` : m.name;
            const cls = m.active ? 'model-select-btn active' : 'model-select-btn';
            return `<button class="${cls}" data-model-set="${esc(m.id)}">${esc(label)}</button>`;
          }).join('\n');
          return [
            `**Modelo activo:** \`${active ? active.name : 'ninguno'}\``,
            '',
            list,
            '',
            'Selecciona un modelo para cargarlo. Para importar uno nuevo, arrastra la carpeta del modelo sobre la ventana de chat.',
          ].join('\n');
        }

        const find = pred => models.filter(m => pred(m.name.toLowerCase()));
        const exact = find(n => n === q);
        const prefix = exact.length ? exact : find(n => n.startsWith(q));
        const matches = prefix.length ? prefix : find(n => n.includes(q));

        let target = null;
        if (matches.length === 1) target = matches[0];
        if (!target) {
          if (matches.length > 1) {
            const names = matches.map(m => `  \`${m.name}\``).join('\n');
            return `\`${q}\` coincide con varios modelos:\n${names}\n\nSe mas especifico, o usa \`/cambio-modelo\` y elige de la lista.`;
          }
          const names = models.map(m => `  \`${m.name}\``).join('\n');
          return `Modelo no encontrado: \`${q}\`.\n\n**Disponibles:**\n${names}`;
        }
        if (target.active) return `**${target.name}** ya es el modelo activo.`;
        const res = await ctx.ipcRenderer.invoke('model-set', { id: target.id });
        if (res.error) return `Error al cambiar modelo: ${res.error}`;
        return `Modelo cambiado a: **${target.name}**`;
      } catch (e) { return `Error: ${e.message}`; }
    },
  });

  register({
    name: 'modelo-vistas',
    description: 'Selecciona el tamano de vista del modelo (cuerpo completo, medio cuerpo, solo cabeza o aleatorio)',
    usage: '/modelo-vistas [full|half|head|random]',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      const MODES = ['full', 'half', 'head', 'random'];
      const LABELS = { full: 'Cuerpo completo', half: 'Medio cuerpo', head: 'Solo cabeza', random: 'Aleatorio' };
      try {
        const state = await ctx.ipcRenderer.invoke('views-get');
        if (!state || !state.mode) return 'No se pudo leer el modo de vista.';
        const mode = state.mode;

        const q = (args[0] || '').trim().toLowerCase();
        if (!q) {
          const buttons = MODES.map(m =>
            `<button class="view-toggle-btn ${m === mode ? 'active' : ''}" data-view-mode="${m}">${LABELS[m]}${m === mode ? ' <span class="view-state">✓</span>' : ''}</button>`
          ).join('\n');
          return [
            `**Tamaño de vista del modelo:**`,
            '',
            `<div class="view-toggle-group">\n${buttons}\n</div>`,
            '',
            `La opcion que elijas queda guardada como la predeterminada para este modelo. \`Aleatorio\` hace que el modelo rote automaticamente entre las tres vistas.`,
            '',
            `Tambien puedes usar: \`/modelo-vistas full\`, \`/modelo-vistas half\`, \`/modelo-vistas head\`, \`/modelo-vistas random\`.`,
          ].join('\n');
        }

        if (!MODES.includes(q)) {
          return `Modo desconocido: \`${q}\`. Usa \`full\`, \`half\`, \`head\` o \`random\`.`;
        }

        const res = await ctx.ipcRenderer.invoke('views-set', { mode: q });
        if (res.error) return `Error: ${res.error}`;
        return `Modo de vista guardado: **${LABELS[q]}**${q === 'random' ? ' — el modelo rotará entre las tres vistas.' : ' — el modelo queda fijo en esa posición.'}`;
      } catch (e) { return `Error: ${e.message}`; }
    },
  });

  register({
    name: 'gestos',
    description: 'Muestra los gestos (expresiones y animaciones) disponibles del modelo Live2D activo y permite probarlos',
    usage: '/gestos [test <gesto|emocion> | <emocion>]',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      const ModelAugmenter   = require('../behavior/ModelAugmenter.js');
      const GestureHeuristic = require('../behavior/GestureHeuristic.js');
      const mappings         = (ctx.gestureConfig || {}).mappings || {};

      try {
        const info = await ctx.ipcRenderer.invoke('get-model-info');
        if (!info || !info.model3Path) return 'No hay modelo Live2D configurado.';
        const gestures = ModelAugmenter.listGestures(info.model3Path);
        const total = gestures.expressions.length + gestures.motions.length;
        if (total === 0) return `El modelo **${info.name}** no tiene expresiones ni animaciones para mostrar.`;

        const first  = (args[0] || '').trim().toLowerCase();
        const query  = args.join(' ').trim().toLowerCase();

        if (first === 'test') {
          const q = args.slice(1).join(' ').trim().toLowerCase();
          if (!q) return 'Uso: `/gestos test <gesto o emocion>`\nEjemplos: `/gestos test angry`, `/gestos test 哭`, `/gestos test zhaiyan`, `/gestos test tired`.';
          if (!ctx.gestureEngine) return 'El motor de gestos aun no esta listo — espera a que cargue el modelo en el panel.';
          const res = await ctx.gestureEngine.play(q, { priority: 'force' });
          if (res.ok && res.gesture) {
            return `Gesto **${res.gesture.name}** (${res.gesture.kind || res.gesture.type}) aplicado en el mini-avatar${res.source ? ` — via ${res.source}` : ''}.`;
          }
          const names = [...gestures.expressions, ...gestures.motions].map(g => g.name);
          return `No encontre un gesto para \`${q}\`. Disponibles para probar: ${names.slice(0, 8).map(n => `\`${n}\``).join(', ')}${names.length > 8 ? '…' : ''}.`;
        }

        if (query && first !== 'test') {
          const r = GestureHeuristic.resolveMood(query, gestures, { mappings });
          if (r.ok && r.gesture) {
            return [
              `Para **${first}** el gesto mas acertado en **${info.name}** es **${r.gesture.name}**`,
              `(${r.gesture.kind || r.gesture.type}, score ${r.score}, via ${r.source}).`,
              '',
              `Pruébalo con: \`/gestos test ${r.gesture.name}\``,
            ].join(' ');
          }
          const names = [...gestures.expressions, ...gestures.motions].map(g => g.name);
          return `No hay un gesto para \`${first}\` en **${info.name}**. Usa \`/gestos\` para ver los disponibles.`;
        }

        const mapped = GestureHeuristic.resolveAll(gestures, { mappings });
        const esc = s => String(s).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
        const lines = [
          `**Gestos de ${esc(info.name)}** — ${gestures.expressions.length} expresiones, ${gestures.motions.length} animaciones:`,
          '',
        ];
        const entries = Object.entries(mapped.map);
        if (entries.length) {
          lines.push('**Emociones → gesto:**');
          for (const [mood, g] of entries) {
            lines.push(`\`${mood}\` → **${esc(g.name)}** (${g.kind || g.type})`);
          }
          lines.push('');
        }
        if (mapped.unmapped.length) {
          lines.push(`**Sin mapear** (probar con \`/gestos test\`):`);
          lines.push(mapped.unmapped.map(esc).map(n => `\`${n}\``).join(', '));
        }
        lines.push('', `Prueba: \`/gestos test 哭\`, \`/gestos test angry\`, \`/gestos test sleepy\`.`);
        return lines.join('\n');
      } catch (e) { return `Error: ${e.message}`; }
    },
  });
};