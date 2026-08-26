// @ts-nocheck
'use strict';

// skills.js — gestión visual de skills: listar, importar desde disco,
// buscar en GitHub e instalar (SkillHub). Complementa /skill [nombre]
// que muestra el detalle de una skill ya cargada.

const path = require('path');
const fs = require('fs');
const SkillHub = require('../../skills/SkillHub.js');

function register(register) {
  register({
    name: 'skills',
    description:
      'Gestiona skills: lista las instaladas, importa carpetas locales, busca en GitHub e instala',
    usage:
      '/skills [lista | importar <ruta> | buscar <query> | instalar <owner/repo> [subdir] | quitar <name>]',
    handler: async (args, ctx) => {
      const sub = (args[0] || 'lista').toLowerCase();
      const rest = args.slice(1);

      const sm = ctx.skillManager
        ? typeof ctx.skillManager === 'function'
          ? ctx.skillManager()
          : ctx.skillManager
        : null;
      if (!sm || !sm.skillsDir) {
        return 'SkillManager no disponible.';
      }
      const skillsDir = sm.skillsDir;

      try {
        switch (sub) {
          case 'lista':
          case '': {
            await sm.scan(true);
            const list = await sm.scan();
            if (!list.length) {
              return (
                `**Skills instaladas:** ninguna.\n\n` +
                `Importá una con \`/skills importar <ruta>\` o buscá en GitHub con \`/skills buscar <query>\`.`
              );
            }
            const lines = [`**Skills instaladas (${list.length}):**`, ''];
            for (const s of list) {
              const doms = s.domains && s.domains.length ? ` — ${s.domains.join(', ')}` : '';
              lines.push(`- **${s.name}** v${s.version}${doms}\n  ${String(s.description).slice(0, 110)}`);
            }
            lines.push(
              '',
              'Detalle: `/skill <nombre>` · Buscar: `/skills buscar <query>` · Importar: `/skills importar <ruta>`'
            );
            return lines.join('\n');
          }

          case 'importar': {
            const ruta = rest[0];
            if (!ruta) return 'Uso: `/skills importar <ruta-de-carpeta-con-SKILL.md>`';
            let abs = ruta;
            if (!path.isAbsolute(abs)) {
              abs = path.resolve(ctx.process ? ctx.process.cwd() : process.cwd(), ruta);
            }
            const name = SkillHub.importarDesdeDisco(abs, skillsDir);
            await sm.index(await sm.scan(true));
            return `✓ Skill importada: **${name}** — indexada y lista para matchear.`;
          }

          case 'buscar': {
            const query = rest.join(' ').trim();
            if (!query) return 'Uso: `/skills buscar <query>` — ej: `/skills buscar code review`';
            const results = await SkillHub.buscarEnGitHub(query, { limit: 6 });
            if (!results.length) return `Sin resultados para \`${query}\`.`;
            const lines = [
              `**Resultados en GitHub** (${results.length}) — instalar con:`,
              '`/skills instalar owner/repo`',
              '',
            ];
            for (const r of results) {
              lines.push(`- **${r.full_name}** ⭐ ${r.stars}\n  ${r.description || '(sin descripción)'}`);
            }
            return lines.join('\n');
          }

          case 'instalar': {
            const repoSpec = rest[0];
            if (!repoSpec) return 'Uso: `/skills instalar owner/repo [subdir]`';
            const subdir = rest[1] || null;

            const tarPath = await SkillHub.descargarTarball(repoSpec);
            const extractDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'skillhub-'));
            await SkillHub.extraerTar(tarPath, extractDir);

            // Si pidieron un subdir específico, instalar solo esa carpeta.
            let sourceDirs = SkillHub.findSkillDirs(extractDir);
            if (subdir) {
              const matches = sourceDirs.filter((d) => d.toLowerCase().endsWith(subdir.toLowerCase()));
              sourceDirs = matches.length ? matches : sourceDirs;
            }

            const res = SkillHub.instalarDesdeExtract(
              // instalarDesdeExtract opera sobre el padre común: si hay varias,
              // instalamos cada una individualmente reutilizando la lógica por carpeta.
              extractDir,
              skillsDir,
              {}
            );
            void res;
            // Rehacer con detalle por carpeta:
            const installed = [];
            const skipped = [];
            for (const src of sourceDirs.slice(0, 5)) {
              try {
                if (!SkillHub._skillMdValida(path.join(src, 'SKILL.md'))) {
                  skipped.push(`${path.basename(src)} (SKILL.md sin description)`);
                  continue;
                }
                const name = SkillHub._sanitizeSkillName(path.basename(src));
                const dest = path.join(skillsDir, name);
                if (fs.existsSync(dest)) {
                  skipped.push(`${name} (ya existía)`);
                  continue;
                }
                fs.cpSync(src, dest, { recursive: true });
                installed.push(name);
              } catch (e2) {
                skipped.push(`${path.basename(src)} (${e2.message})`);
              }
            }
            fs.rmSync(extractDir, { recursive: true, force: true });
            try { fs.unlinkSync(tarPath); } catch {}

            if (installed.length) await sm.index(await sm.scan(true));

            const lines = [];
            if (installed.length) lines.push(`✓ Instaladas: **${installed.join('**, **')}**`);
            if (skipped.length) lines.push(`Saltadas: ${skipped.join(', ')}`);
            if (!lines.length) lines.push('No se encontró ningún SKILL.md en el repo.');
            else lines.push('', 'Listado: `/skills` · Detalle: `/skill <nombre>`');
            return lines.join('\n');
          }

          case 'quitar': {
            const name = (rest[0] || '').trim();
            if (!name) return 'Uso: `/skills quitar <name>`';
            const dest = path.join(skillsDir, name);
            if (!fs.existsSync(dest)) return `No existe la skill \`${name}\`.`;
            fs.rmSync(dest, { recursive: true, force: true });
            await sm.scan(true);
            return `Skill **${name}** eliminada del catálogo.`;
          }

          default:
            return `Subcomando desconocido: \`${sub}\`. Usa \`/skills lista | importar | buscar | instalar | quitar\`.`;
        }
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });
}

module.exports = { register };
