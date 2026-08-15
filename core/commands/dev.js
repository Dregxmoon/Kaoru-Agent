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
    description: 'Deshace SOLO los cambios que hizo la ultima tarea del agente (no toca tu working tree previo)',
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
      if (id && !cp) return `No existe un checkpoint \`${id}\`. Usa \`/revertir-tarea list\` para verlos.`;
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
};
