// @ts-nocheck
'use strict';

// proactive.js — control en runtime del ProactiveEngine vía comando /.
//
// El usuario pidió no sobrecargar la UI, así que el control vive aquí:
//   - /proactive                    → stats en vivo (resumen legible).
//   - /proactive autonomy <m>       → observe | suggest | act.
//   - /proactive shadow <on|off>    → el gate corre pero nada se envía.
//
// El comando corre en el preload del chat (mundo aislado), así que todo pasa
// por IPC hacia main.js (ipc/proactive-handlers.js), con los canales validados
// en ipc/channel-whitelist.js.

function _hms(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function _formatStats(s) {
  if (!s) return 'ProactiveEngine no inicializado.';
  const lines = [
    `**ProactiveEngine** (${s.running ? 'activo' : 'detenido'})`,
    `- Autonomía: **${s.autonomyMode}** · Shadow mode: **${s.gate?.shadowMode ? 'ON' : 'OFF'}**`,
    `- Receptividad: ${s.gate?.receptivity?.toFixed(3) ?? '—'} · Score: ${(s.proactiveScore ?? 0).toFixed(3)}`,
    `- Último envío: ${_hms(s.lastProactive ? Date.now() - s.lastProactive : 0)} atrás (${s.lastProactiveTrigger || 'nunca'})`,
    `- Silencio: ${_hms(s.silenceMs)} · Chat abierto: ${s.chatOpen ? 'sí' : 'no'}`,
    `- Presupuesto del día: ${s.dailyBudget?.count ?? 0}/${s.dailyBudget?.limit ?? '—'} (límite dinámico)`,
    `- Cola QUEUE: ${s.gate?.queued ?? 0} · Propuestas pendientes: ${s.pendingProposals ?? 0}`,
    `- Foco contextual: ${s.contextFocus?.mode || 'aún no evaluado'} · términos: ${s.contextFocus?.terms?.slice(0, 5).join(', ') || '—'}`,
    `- Alineación: ${s.contextAlignment?.accepted ?? 0} candidato(s) válidos · ${s.contextAlignment?.rejected ?? 0} fuera de contexto`,
    `- Aprendizaje activo: ${s.activeLearning?.answered ?? 0} respondida(s) · ${s.activeLearning?.awaitingAnswer ?? 0} esperando respuesta`,
    `- Hilo de proyecto: ${s.projectCompanion ? `${s.projectCompanion.projectName} · ${s.projectCompanion.phase}` : 'sin estado para el workspace actual'}`,
    `- Categoría actual: ${s.currentCategory || '—'} (${s.categoryStreakSec || 0}s) · Cambios de app: ${s.recentSwitchesCount ?? 0}`,
  ];
  const slo = s.slo;
  if (slo && (slo.total || slo.porTipo)) {
    const total = slo.total ?? 0;
    const degraded = Object.values(slo.porTipo || {}).filter((t) => t.degraded).length;
    lines.push(`- SLO: ${total} decisiones · ${degraded} tipo(s) degradado(s)`);
  }
  const audit = s.gate?.audit;
  if (audit && audit.total) {
    lines.push(`- Audit del gate: ${audit.total} entradas`);
  }
  const gated = Object.keys(s.gate?.audit?.byVerdict || {});
  if (gated.length)
    lines.push(
      `  - Por veredicto: ${gated.map((v) => `${v} (${s.gate.audit.byVerdict[v]})`).join(', ')}`
    );
  return lines.join('\n');
}

module.exports = function registerCommands(register) {
  register({
    name: 'proactive',
    description: 'Control del ProactiveEngine en vivo (stats, autonomía, shadow)',
    usage: '/proactive [autonomy observe|suggest|act | shadow on|off]',
    handler: async (args, ctx) => {
      const ipc = ctx.ipcRenderer;
      if (!ipc) return 'IPC no disponible.';
      const sub = (args[0] || '').toLowerCase();

      try {
        if (sub === 'autonomy') {
          const mode = (args[1] || '').toLowerCase();
          const res = await ipc.invoke('proactive:set-autonomy', mode);
          return res.ok ? `Autonomía → **${res.mode}**` : `Error: ${res.error}`;
        }

        if (sub === 'shadow') {
          const on = ['on', 'true', '1', 'si', 'sí'].includes((args[1] || '').toLowerCase());
          const res = await ipc.invoke('proactive:set-shadow-mode', on);
          return res.ok
            ? `Shadow mode → **${res.shadowMode ? 'ON' : 'OFF'}** (el gate corre pero nada se envía)`
            : `Error: ${res.error}`;
        }

        if (sub) {
          return `Uso: \`/proactive\` · \`/proactive autonomy observe|suggest|act\` · \`/proactive shadow on|off\``;
        }

        return _formatStats(await ipc.invoke('proactive:get-stats'));
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });
};
