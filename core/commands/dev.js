// @ts-nocheck
'use strict';

function _formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = function registerCommands(register) {
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
        try {
          entries = ctx.fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
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
            } catch {
              items.push({ path: rel, type: 'file' });
            }
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
          pkgInfo = `\n- **Nombre:** ${pkg.name || '(sin nombre)'}\n- **Version:** ${pkg.version || '-'}`;
          if (pkg.description) pkgInfo += `\n- **Descripción:** ${pkg.description}`;
        } catch {}
      }

      const totalFiles = files.filter((f) => f.type === 'file').length;
      const totalDirs = files.filter((f) => f.type === 'dir').length;
      const byExt = {};
      for (const f of files) {
        if (f.type !== 'file') continue;
        const ext = ctx.path.extname(f.path).toLowerCase() || '(sin ext)';
        byExt[ext] = (byExt[ext] || 0) + 1;
      }
      const topExt = Object.entries(byExt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([ext, count]) => `${ext} (${count})`)
        .join(', ');

      const treeLines = [];
      const topDirs = files
        .filter((f) => f.type === 'dir' && f.path.split(ctx.path.sep).length === 2)
        .slice(0, 20);
      for (const d of topDirs) treeLines.push(`[DIR] ${d.path}`);
      const topFiles = files
        .filter((f) => f.type === 'file' && f.path.split(ctx.path.sep).length <= 2)
        .slice(0, 30);
      for (const f of topFiles) treeLines.push(`      ${f.path} (${_formatSize(f.size)})`);

      if (ctx.ipcRenderer) {
        const projDesc = pkgInfo ? pkgInfo.trim() : `Proyecto en ${cwd}`;
        await ctx.ipcRenderer.invoke('store-fact', {
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
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  register({
    name: 'review',
    description: 'Solicita revision de un archivo',
    usage: '/review <archivo>',
    handler: async (args, ctx) => {
      if (!args[0]) return 'Especifica un archivo: `/review src/main.js`';
      if (!ctx.fs || !ctx.path) return 'Sistema de archivos no disponible.';
      const cwd = ctx.process?.cwd?.() || process.cwd();
      const filePath = ctx.path.resolve(cwd, args[0]);
      if (!ctx.fs.existsSync(filePath)) return `Archivo no encontrado: \`${args[0]}\``;

      const content = ctx.fs.readFileSync(filePath, 'utf-8');
      const relPath = ctx.path.relative(cwd, filePath);

      return [
        `**Revisión solicitada:** \`${relPath}\` (${content.split('\n').length} lineas, ${content.length} caracteres)`,
        '',
        'Para obtener una revision detallada, envia un mensaje como:',
        `\`Revisa el codigo en @${relPath} y busca bugs, problemas de seguridad y mejoras\``,
        '',
        'O cambia al agente reviewer con `/agent reviewer` y luego pide la revision.',
      ].join('\n');
    },
  });

  register({
    name: 'plan',
    description: 'Crea un plan de implementacion',
    usage: '/plan <descripcion>',
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
        '  `/agent planner`',
        '',
        'Luego pide el plan con:',
        `  \`Crea un plan para: ${userRequest}\``,
      ].join('\n');
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
        const lines = output
          .trim()
          .split('\n')
          .filter((l) => l.includes(': error') || l.includes(': warning'));
        if (lines.length === 0) return 'No se encontraron errores de lint.';
        const errorCount = lines.filter((l) => l.includes(': error')).length;
        const warningCount = lines.filter((l) => l.includes(': warning')).length;
        return [
          `**Lint completo — ${lines.length} issues**`,
          `- ${errorCount} errores, ${warningCount} warnings`,
          '',
          '```',
          ...lines.slice(0, 30),
          '```',
          lines.length > 30 ? `... y ${lines.length - 30} mas` : '',
        ]
          .filter(Boolean)
          .join('\n');
      } catch (e) {
        return `Error ejecutando linter: ${e.message}. ¿Esta instalado eslint?`;
      }
    },
  });

  register({
    name: 'revertir-tarea',
    description:
      'Deshace SOLO los cambios que hizo la ultima tarea del agente (no toca tu working tree previo)',
    usage: '/revertir-tarea [id]',
    handler: async (args) => {
      const {
        getCheckpoint,
        listCheckpoints,
        revertCheckpoint,
      } = require('../git/WorkspaceCheckpoint.js');
      const id = (args[0] || '').trim();
      if (id === 'list' || args[0] === 'list') {
        const cps = listCheckpoints();
        if (cps.length === 0) return 'No hay checkpoints de tareas registrados.';
        return (
          'Checkpoints de tareas (mas reciente primero):\n' +
          cps
            .map(
              (c) =>
                `- \`${c.id}\` — ${c.canRevert ? `${c.files.length} archivo(s) tocado(s)` : `NO reversible (${c.reason || 'sin baseline'})`}`
            )
            .join('\n')
        );
      }
      const cp = id ? getCheckpoint(id) : null;
      if (id && !cp)
        return `No existe un checkpoint \`${id}\`. Usa \`/revertir-tarea list\` para verlos.`;
      const result = await revertCheckpoint(id || undefined);
      if (!result.ok) return `No se pudo revertir: ${result.error || 'error desconocido'}`;
      const lines = [
        'Tarea revertida. Cambios de la tarea deshechos sin tocar tu working tree previo:',
      ];
      for (const r of result.reverted) lines.push(`- ${r}`);
      for (const s of result.skipped) lines.push(`- (sin cambios) ${s}`);
      if (result.warnings.length > 0) {
        lines.push('Advertencias:');
        for (const w of result.warnings) lines.push(`- ${w}`);
      }
      return lines.join('\n');
    },
  });

  register({
    name: 'undo',
    description: 'Revierte el ultimo commit (git)',
    usage: '/undo',
    handler: async (args, ctx) => {
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      try {
        const stat = await ctx.ipcRenderer.invoke('exec-command', {
          command: 'git log --oneline -1',
          timeout: 5,
        });
        if (!stat || stat.exitCode !== 0)
          return 'No hay commits para revertir o no es un repo git.';
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
    name: 'retry',
    description: 'Reintenta la ultima respuesta del LLM',
    usage: '/retry',
    handler: async (args, ctx) => {
      const history = ctx.sessionHistory || [];
      if (history.length < 2) return 'No hay suficiente historial para reintentar.';
      const lastUserIdx = history
        .map((m, i) => (m.role === 'user' ? i : -1))
        .filter((i) => i >= 0)
        .pop();
      if (lastUserIdx === undefined) return 'No se encontro un mensaje de usuario para reintentar.';
      const lastUserMsg = history[lastUserIdx].content;
      if (!lastUserMsg || lastUserMsg.startsWith('/'))
        return 'El ultimo mensaje era un comando, no se puede reintentar.';
      if (ctx.processMessage) {
        ctx.processMessage(lastUserMsg);
        return 'Reintentando ultimo mensaje...';
      }
      return 'No se puede reintentar — processMessage no disponible.';
    },
  });

  // ── Tareas en vuelo: estado y reanudación ─────────────────────────────────
  // /estado muestra las intenciones activas (metas pendientes) con su plan y
  // progreso; /reanudar-tarea [id] retoma la más reciente (o la indicada)
  // desde donde quedó. Ambas son la contraparte de UI del HUD del plan.
  async function _listActiveIntentions(ctx) {
    if (!ctx.ipcRenderer) return [];
    try {
      return (await ctx.ipcRenderer.invoke('intentions-list')) || [];
    } catch (_) {
      return [];
    }
  }

  function _intentionSteps(intention) {
    const structured = Array.isArray(intention?.goal_plan);
    let steps = structured ? intention.goal_plan : [];
    if (!steps.length && typeof intention?.steps === 'string') {
      try {
        steps = JSON.parse(intention.steps);
      } catch (_) {}
    } else if (Array.isArray(intention?.steps)) {
      steps = intention.steps;
    }
    return steps
      .map((s) => {
        if (typeof s === 'string') return s;
        const description = s && (s.description || s.label);
        return description && structured
          ? `[${s.status || 'pending'}] ${description}`
          : description;
      })
      .filter(Boolean);
  }

  register({
    name: 'estado',
    description: 'Muestra las tareas pendientes en vuelo (intenciones activas) y su progreso',
    usage: '/estado',
    handler: async (args, ctx) => {
      const intentions = await _listActiveIntentions(ctx);
      if (intentions.length === 0) {
        return 'No hay tareas en vuelo. Todo listo por acá.';
      }
      const lines = [`**Tareas pendientes (${intentions.length}):**`, ''];
      for (const it of intentions) {
        const steps = _intentionSteps(it);
        const stepLine = steps.length
          ? '\n    Pasos: ' + steps.map((s) => `\`${s}\``).join(' → ')
          : '';
        const progress = it.last_progress ? `\n    Progreso: ${it.last_progress}` : '';
        const governance = it.governance
          ? `\n    Gobernador: ${it.governance.state} · autonomía ${it.governance.autonomy} · prioridad ${it.governance.priority} · intentos ${it.governance.attempts}/${it.governance.maxAttempts}`
          : '';
        lines.push(
          `- **#${it.id}** — ${it.goal}${progress}${governance}${stepLine}\n    ↳ para retomar: \`/reanudar-tarea ${it.id}\``
        );
      }
      return lines.join('\n');
    },
  });

  register({
    name: 'autonomia-meta',
    description: 'Configura si una meta se ejecuta manualmente, se sugiere o puede actuar',
    usage: '/autonomia-meta <id> <manual|suggest|act> [prioridad 0-100]',
    handler: async (args, ctx) => {
      const id = Number(args[0]);
      const autonomy = String(args[1] || '').toLowerCase();
      const priority = args[2] === undefined ? undefined : Number(args[2]);
      if (!Number.isInteger(id) || !['manual', 'suggest', 'act'].includes(autonomy)) {
        return 'Uso: `/autonomia-meta <id> <manual|suggest|act> [prioridad 0-100]`';
      }
      if (
        priority !== undefined &&
        (!Number.isFinite(priority) || priority < 0 || priority > 100)
      ) {
        return 'La prioridad debe estar entre 0 y 100.';
      }
      if (!ctx.ipcRenderer) return 'IPC no disponible.';
      const result = await ctx.ipcRenderer.invoke('intention-governance-set', {
        id,
        autonomy,
        priority,
      });
      if (!result?.ok) return `No pude configurar la meta #${id}: ${result?.error || 'error'}.`;
      const note =
        autonomy === 'act'
          ? ' Para ejecución autónoma también necesitas una regla `allow` explícita para `goal_run` en este workspace.'
          : '';
      return `Meta #${id}: autonomía **${autonomy}**, prioridad **${result.governance.priority}**.${note}`;
    },
  });

  register({
    name: 'reanudar-tarea',
    description: 'Retoma la tarea pendiente (la mas reciente, o una por id) desde donde quedo',
    usage: '/reanudar-tarea [id]',
    handler: async (args, ctx) => {
      const intentions = await _listActiveIntentions(ctx);
      if (intentions.length === 0) {
        return 'No hay tareas pendientes para reanudar.';
      }
      const idArg = args[0] ? Number(args[0]) : null;
      let target = null;
      if (idArg) {
        target = intentions.find((it) => Number(it.id) === idArg) || null;
        if (!target)
          return `No existe una tarea pendiente \`#${idArg}\`. Usa \`/estado\` para verlas.`;
      } else {
        target = intentions[0]; // tope del stack = más reciente
      }
      const steps = _intentionSteps(target);
      const lines = [`Retomá la tarea pendiente y completala:`, ``, `Objetivo: ${target.goal}`];
      if (target.last_progress) lines.push(`Progreso previo: ${target.last_progress}`);
      if (steps.length) {
        lines.push(`Pasos planificados:`);
        for (const s of steps) lines.push(`- ${s}`);
      }
      if (target.resume_point?.step?.description) {
        const prefix = target.resume_point.state === 'verify' ? 'Verificá primero' : 'Próximo paso';
        lines.push(`${prefix}: ${target.resume_point.step.description}`);
        const criteria = target.resume_point.step.successCriteria || [];
        if (criteria.length) lines.push(`Criterios de éxito: ${criteria.join('; ')}`);
      }
      lines.push(
        ``,
        `Continuá DESDE donde quedó (no reinicies desde cero): primero verificá el estado actual con las herramientas y seguí con el próximo paso pendiente.`
      );
      if (ctx.processMessage) {
        ctx.processMessage(lines.join('\n'));
        return `Reanudando la tarea **#${target.id}**...`;
      }
      return 'No se pudo reanudar — processMessage no disponible.';
    },
  });
};
