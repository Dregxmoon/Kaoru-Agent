// @ts-nocheck
'use strict';

module.exports = function registerCommands(register) {
  register({
    name: 'clear',
    description: 'Borra el historial de la conversacion actual',
    usage: '/clear',
    handler: async (args, ctx) => {
      ctx.sessionHistory?.splice(0, ctx.sessionHistory.length);
      if (ctx.pushToSession) ctx.pushToSession('system', 'Historial borrado.');
      return 'Historial de conversacion borrado.';
    },
  });

  register({
    name: 'mudo',
    description: 'Activa/desactiva la voz (TTS)',
    usage: '/mudo',
    handler: async (args, ctx) => {
      const muted = ctx.isTtsMuted ? ctx.isTtsMuted() : false;
      const next = !muted;
      if (ctx.setTtsMuted) ctx.setTtsMuted(next);
      return next ? 'Voz silenciada (TTS apagado).' : 'Voz activada (TTS encendido).';
    },
  });

  register({
    name: 'contexto',
    description: 'Muestra el presupuesto de contexto de la sesion',
    usage: '/contexto',
    handler: async (args, ctx) => {
      const history = ctx.sessionHistory || [];
      const chars = history.reduce((acc, m) => acc + String(m.content || '').length, 0);
      const budget = 8000; // MAX_HISTORY_CHARS de GroqSerializer
      const pct = history.length ? Math.min(100, Math.round((chars / budget) * 100)) : 0;
      return [
        '**Presupuesto de contexto:**',
        `- Turnos en sesion: **${history.length}**`,
        `- Caracteres: **${chars.toLocaleString()}** / ${budget.toLocaleString()} (${pct}%)`,
        pct >= 80 ? '- ⚠️ Contexto casi lleno — usa /clear para empezar una sesion limpia.' : '',
        '- El excedente se resume automaticamente (no se pierde memoria).',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  register({
    name: 'memory',
    description: 'Muestra el historial reciente de la conversacion',
    usage: '/memory',
    handler: async (args, ctx) => {
      const history = ctx.sessionHistory || [];
      if (history.length === 0) return 'No hay mensajes en el historial.';
      const lines = history.map((m) => {
        const role = m.role === 'user' ? '[U]' : m.role === 'assistant' ? '[A]' : '[S]';
        const preview = (m.content || '').slice(0, 200).replace(/\n/g, ' ');
        return `${role} **${m.role}**: ${preview}${m.content.length > 200 ? '...' : ''}`;
      });
      return `**Historial (${history.length} mensajes):**\n\n${lines.join('\n')}`;
    },
  });

  register({
    name: 'stats',
    description: 'Muestra estadisticas de uso de herramientas',
    usage: '/stats',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      try {
        const stats = await ctx.ipcRenderer.invoke('get-bridge-stats');
        if (!stats) return 'No hay estadisticas disponibles.';
        return [
          '**Estadisticas de herramientas:**',
          `- Total acciones: **${stats.total || 0}**`,
          `- Exitosas: **${stats.ok || 0}**`,
          `- Fallidas: **${stats.failed || 0}**`,
          `- Herramientas: ${(stats.tools || []).join(', ') || 'ninguna'}`,
          `- OpenClaw disponible: ${stats.available ? 'si' : 'no'}`,
        ].join('\n');
      } catch (e) {
        return `Error obteniendo estadisticas: ${e.message}`;
      }
    },
  });

  register({
    name: 'telemetria',
    description: 'Muestra si estamos mejor que el mes pasado (datos locales)',
    usage: '/telemetria',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      try {
        const { ok, report, error } = await ctx.ipcRenderer.invoke('telemetry-report');
        if (!ok) return `Telemetria no disponible: ${error}`;
        if (!report) return 'No hay datos de telemetria aun.';
        const { current, previous, deltas, verdict, acceptance, prevAcceptance } = report;
        if (!current.activeDays && !current.userMessages && !current.agentRuns)
          return 'No hay actividad registrada este mes todavia.';
        const arrow = (v) => (v == null ? '–' : v > 0 ? `▲ +${v}%` : v < 0 ? `▼ ${v}%` : '＝ 0%');
        const fmtMs = (ms) =>
          ms == null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
        const verdictLabel = { improved: 'mejor que', regressed: 'peor que', stable: 'igual que' }[
          verdict
        ];
        const lines = [
          `**¿Estamos mejor que el mes pasado?** → ${verdictLabel} ${previous.monthKey}`,
          '',
          `│ ${current.monthKey} vs ${previous.monthKey}`,
          `│ Mensajes/dia: ${current.messagesPerDay.toFixed(1)} vs ${previous.messagesPerDay.toFixed(1)}  ${arrow(deltas.messagesPerDay)}`,
          `│ Respuesta p50: ${fmtMs(current.p50ResponseMs)} vs ${fmtMs(previous.p50ResponseMs)}  ${arrow(deltas.p50ResponseMs)}`,
          `│ Sesiones/dia: ${current.sessionsPerDay.toFixed(1)} vs ${previous.sessionsPerDay.toFixed(1)}  ${arrow(deltas.sessionsPerDay)}`,
          `│ Silencios: ${current.silenceCount} (${current.silenceHours} h) vs ${previous.silenceCount} (${previous.silenceHours} h)  ${arrow(deltas.silenceCount)}`,
          `│ Dias activos: ${current.activeDays} vs ${previous.activeDays}  ${arrow(deltas.activeDays)}`,
        ];
        if (current.agentRuns || previous.agentRuns) {
          const runsArrow =
            previous.agentRuns == null || previous.agentRuns === 0
              ? null
              : current.agentRuns - previous.agentRuns;
          const toolsPerRun =
            current.agentRuns > 0
              ? (current.agentToolCalls / current.agentRuns).toFixed(1)
              : '–';
          lines.push(
            `│ Runs agente: ${current.agentRuns || 0} vs ${previous.agentRuns || 0}  ${arrow(runsArrow)}`,
            `│ Tools/run: ${toolsPerRun} | Errores: ${current.agentErrors || 0} | Aprobaciones: ${current.agentApprovalsGranted || 0}/${current.agentApprovalRequests || 0}`,
            `│ Cancelados: ${current.agentCancelled || 0} | Duracion p90: ${fmtMs(current.p90RunDurationMs)} vs ${fmtMs(previous.p90RunDurationMs)}`
          );
        }
        if (acceptance.rate != null || prevAcceptance.rate != null) {
          const cur = acceptance.rate == null ? '–' : `${acceptance.rate}%`;
          const prev = prevAcceptance.rate == null ? '–' : `${prevAcceptance.rate}%`;
          lines.push(`│ Aceptacion: ${cur} vs ${prev}  ${arrow(deltas.acceptanceRate)}`);
        }
        return lines.join('\n');
      } catch (e) {
        return `Error obteniendo telemetria: ${e.message}`;
      }
    },
  });

  register({
    name: 'export',
    description: 'Exporta la conversacion como texto',
    usage: '/export',
    handler: async (args, ctx) => {
      const history = ctx.sessionHistory || [];
      if (history.length === 0) return 'No hay conversacion para exportar.';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const lines = [`# Conversacion (${timestamp})`, `# Total mensajes: ${history.length}`, ''];
      for (const m of history) {
        const role =
          m.role === 'user' ? '## Usuario' : m.role === 'assistant' ? '## Asistente' : '## Sistema';
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
    name: 'olvida',
    description: 'Archiva de la memoria lo que coincida con el texto',
    usage: '/olvida <texto>',
    handler: async (args, ctx) => {
      const text = args.join(' ').trim();
      if (!text)
        return 'Usa `/olvida <texto>` — p. ej. `/olvida cumpleanos` para quitar esa fecha de mi memoria.';
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      try {
        const res = await ctx.ipcRenderer.invoke('memory-forget', { text });
        if (res.error) return `No pude olvidarlo: ${res.error}`;
        if (!res.found) return `No encontré nada en mi memoria que coincida con \`${text}\`.`;
        if (res.warning) return `*${res.warning}*`;
        const items = (res.nodes || []).map((n) => `- ~~${n.label}~~ — ${n.content}`).join('\n');
        const extra =
          res.found > res.archived
            ? `\n_(quedaron ${res.found - res.archived} coincidencias mas que no toque por precaucion)_`
            : '';
        return `Archivé **${res.archived}** nodo(s) de memoria con \`${text}\`:\n${items}${extra}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });

  register({
    name: 'memoria',
    description: 'Muestra el grafo de nodos de memoria en el chat',
    usage: '/memoria',
    handler: async (args, ctx) => {
      if (typeof ctx.openNodes === 'function') {
        ctx.openNodes();
        return 'Mostrando el grafo de memoria en el chat.';
      }
      return 'Este comando solo funciona desde la ventana del chat.';
    },
  });

  register({
    name: 'sesiones',
    description: 'Abre el panel de sesiones pasadas (reanudar conversaciones)',
    usage: '/sesiones',
    handler: async (args, ctx) => {
      if (typeof ctx.openSessions === 'function') {
        ctx.openSessions();
        return 'Abriendo el panel de sesiones pasadas.';
      }
      return 'Este comando solo funciona desde la ventana del chat.';
    },
  });

  register({
    name: 'mcp',
    description: 'Abre el panel de servidores MCP',
    usage: '/mcp',
    handler: async (args, ctx) => {
      if (typeof ctx.openMcp === 'function') {
        ctx.openMcp();
        return 'Abriendo el panel de servidores MCP.';
      }
      return 'Este comando solo funciona desde la ventana del chat.';
    },
  });

  register({
    name: 'permisos',
    description: 'Abre el panel de permisos de herramientas (allow/ask/deny)',
    usage: '/permisos',
    handler: async (args, ctx) => {
      if (typeof ctx.openPerms === 'function') {
        ctx.openPerms();
        return 'Abriendo el panel de permisos de herramientas.';
      }
      return 'Este comando solo funciona desde la ventana del chat.';
    },
  });

  register({
    name: 'dir',
    description: 'Elige la carpeta del proyecto (workspace)',
    usage: '/dir',
    handler: async (args, ctx) => {
      if (typeof ctx.pickWorkspace === 'function') {
        await ctx.pickWorkspace();
        return 'Abriendo el selector de carpeta.';
      }
      return 'Este comando solo funciona desde la ventana del chat.';
    },
  });

  register({
    name: 'uso',
    description: 'Muestra el consumo de LLM: llamadas, tokens y coste estimado',
    usage: '/uso [recientes|reset]',
    handler: async (args, ctx) => {
      const getTracker =
        (ctx && ctx.LLMProvider && ctx.LLMProvider.getUsageTracker) ||
        (() => require('../llm/LLMProvider.js').getUsageTracker());
      const tracker = getTracker();
      if (!tracker || typeof tracker.getSummary !== 'function') {
        return 'Uso de LLM no disponible.';
      }
      const sub = (args[0] || '').toLowerCase();

      if (sub === 'reset' && typeof tracker.reset === 'function') {
        tracker.reset();
        return 'Contador de uso de LLM reiniciado.';
      }

      if (sub === 'recientes' && typeof tracker.recent === 'function') {
        const events = tracker.recent(10);
        if (!events.length) return 'No hay eventos de uso recientes.';
        const lines = events
          .slice()
          .reverse()
          .map((ev) => {
            const time = new Date(ev.ts).toLocaleTimeString('es-AR', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const flag = ev.error ? ' [error]' : ev.stream ? ' [stream]' : '';
            return `  - ${time} \`${ev.provider}\` **${ev.model}** — ${Number(ev.totalTokens || 0).toLocaleString('es-AR')} tok · $${Number(ev.costUsd || 0).toFixed(4)}${flag}`;
          });
        return `**Eventos de uso recientes:**\n\n${lines.join('\n')}`;
      }

      const s = tracker.getSummary();
      const fmtN = (v) => Number(v || 0).toLocaleString('es-AR');
      const fmtCost = (v) => `$${Number(v || 0).toFixed(4)}`;
      const byProvider = Object.entries(s.byProvider || {})
        .sort((a, b) => b[1].requests - a[1].requests)
        .map(
          ([id, p]) =>
            `  - \`${id}\`: **${fmtN(p.requests)}** llamadas · ${fmtN(p.tokens)} tokens · ${fmtCost(p.costUsd)}`
        );
      const lines = [
        '**Uso de LLM:**',
        `- Llamadas: **${fmtN(s.totalRequests)}**`,
        `- Tokens: **${fmtN(s.totalTokens)}** (${fmtN(s.totalPromptTokens)} in / ${fmtN(s.totalCompletionTokens)} out)`,
        `- Coste estimado: **${fmtCost(s.totalCostUsd)}**`,
        `- Hoy: **${fmtN(s.today.requests)}** llamadas · ${fmtN(s.today.promptTokens)} in / ${fmtN(s.today.completionTokens)} out · ${fmtCost(s.today.costUsd)}`,
      ];
      if (byProvider.length) lines.push('', '**Por proveedor:**', ...byProvider);
      return lines.join('\n');
    },
  });
};
