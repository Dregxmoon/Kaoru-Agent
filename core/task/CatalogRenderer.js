// @ts-check
'use strict';

/**
 * CatalogRenderer.js — UNICO renderizador del catálogo de tools a prompt.
 *
 * Antes había dos implementaciones que formateaban lo mismo con diferencias
 * sutiles: `ToolRegistry.serializeToPrompt()` y `ToolResolver._buildPromptCatalog()`.
 * Ambas delegan acá; las diferencias reales (notas de disponibilidad, estilo
 * MCP, guías, secciones extra) son flags explícitos, no código duplicado.
 * Único texto normalizado: la guía de git (se usa la variante del resolver,
 * que es la vía productiva; la diferencia era solo redacción).
 *
 * Marcadores estables que los tests y el truncado esperan:
 *   '# HERRAMIENTAS DISPONIBLES', '## Herramientas MCP', 'Servidor: ...'
 */

const GIT_GUIDE_LINES = [
  'Guía de uso: PREFIERE estas herramientas nativas a exec para operaciones de',
  'git (son más confiables y git_commit ya hace add -A). Si usas exec con',
  'comandos git: (1) corre git status antes de commitear; (2) usa "git add ."',
  'salvo que el usuario pida un archivo puntual; (3) si no hay cambios staged,',
  'AVISA y no inventes un commit; (4) usa el mensaje de commit que pidió el',
  'usuario; (5) cuando el push confirme éxito la tarea está completa — detente.',
];

const MCP_FORMAT_BLOCK_LINES = [
  'Para usar MCP, usa el formato:\n  ```action\n  MCP_TOOL: <servidor>.<herramienta> | ARCHIVO/RUTA/CONTENIDO: <valor>\n  ```\n' +
    '  donde <servidor>.<herramienta> es el nombre EXACTO de la lista de arriba (p.ej. filesystem.write_file).\n' +
    '  ARCHIVO→path, RUTA→path, CONTENIDO→content, COMANDO→command, QUERY→query, URL→url.\n' +
    '  Alternativa clásica:\n' +
    '  ```action\n  ACCIÓN: mcp_call | SERVIDOR: <servidor> | HERRAMIENTA: <herramienta> | PARAMS: {...}\n  ```',
];

const LEGACY_USAGE_LINES = [
  '### Formato de uso',
  'Para usar OpenClaw, describe EXACTAMENTE la acción con el formato apropiado:',
  '  - Comandos: "Ejecutar: <comando>"',
  '  - Leer: "Voy a leer el archivo <ruta>"',
  '  - Escribir: "Voy a escribir el archivo <ruta>"',
  '  - Editar: "Voy a editar el archivo <ruta>"',
  '  - Web: "Buscar en internet: <consulta>"',
];

const LEGACY_MCP_USAGE_LINES = [
  'Para usar herramientas MCP, responde con formato exacto:',
  '  ```action',
  '  ACCIÓN: mcp_call | SERVIDOR: <servidor> | HERRAMIENTA: <herramienta> | PARAMS: {...}',
  '  ```',
];

const RESOLVER_USAGE_LINES = [
  '### Formato de uso',
  'Describe EXACTAMENTE qué acción quieres ejecutar.',
  '  - Para comandos: describe el comando directamente',
  '  - Para archivos: describe qué archivo y qué cambio',
  '  - Para web: describe qué buscar o navegar',
];

const LEGACY_RULES_LINES = [
  '### Reglas importantes',
  '1. NUNCA inventes resultados de comandos o herramientas',
  '2. Anuncia cada acción antes de ejecutarla',
  '3. Si una acción requiere aprobación, espera confirmación',
  '4. No ejecutes acciones que no te hayan pedido explícitamente',
];

/**
 * @param {Array<{name: string, source: string, description?: string, server?: string, highImpact?: boolean}>} tools herramientas ya filtradas/ordenadas por el caller
 * @param {object} [opts]
 * @param {string|null} [opts.domainLabel] línea "Puedes usar estas herramientas para..." (registry)
 * @param {boolean} [opts.skillNote] nota de skills que reemplazan (resolver)
 * @param {boolean} [opts.openclawUnavailableNote] sufijo ' (servicio no disponible)'
 * @param {boolean} [opts.lspUnavailableNote] sufijo ' (LSP no activo)'
 * @param {boolean} [opts.openclawTitleSuffix] ' (OpenClaw)' en el título del sistema (registry)
 * @param {'grouped'|'flat-capped'} [opts.mcpStyle] grouped = resolver, flat-capped = registry
 * @param {number} [opts.maxTools] tope para flat-capped
 * @param {boolean} [opts.includePlugins] sección de plugins (solo registry la tenía)
 * @param {'legacy'|'resolver'} [opts.usageStyle]
 * @param {boolean} [opts.rulesSection] "### Reglas importantes" (solo legacy)
 * @returns {string}
 */
function renderToolCatalog(tools, opts = {}) {
  const {
    domainLabel = null,
    skillNote = false,
    openclawUnavailableNote = false,
    lspUnavailableNote = false,
    openclawTitleSuffix = false,
    mcpStyle = 'grouped',
    maxTools = 30,
    includePlugins = false,
    usageStyle = 'resolver',
    rulesSection = false,
  } = opts;

  const lines = ['# HERRAMIENTAS DISPONIBLES'];
  if (domainLabel)
    lines.push(`Puedes usar estas herramientas para tareas relacionadas con: ${domainLabel}`);
  if (skillNote)
    lines.push('Se han cargado skills específicas que reemplazan herramientas genéricas.');
  lines.push('');

  /** @param {string} source */
  const bySource = (source) => tools.filter((t) => t.source === source);
  const openclawTools = bySource('openclaw');
  const desktopTools = bySource('desktop');
  const lspTools = bySource('lsp');
  const gitTools = bySource('git');
  const githubTools = bySource('github');
  const mcpTools = bySource('mcp');
  const pluginTools = bySource('plugin');

  if (openclawTools.length > 0) {
    lines.push(
      openclawTitleSuffix ? '## Herramientas del sistema (OpenClaw)' : '## Herramientas del sistema'
    );
    for (const t of openclawTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      if (openclawUnavailableNote) line += ' (servicio no disponible)';
      lines.push(line);
    }
    lines.push('');
  }

  if (desktopTools.length > 0) {
    lines.push('## Control visible del escritorio');
    for (const t of desktopTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      lines.push(line);
    }
    lines.push('');
  }

  if (lspTools.length > 0) {
    lines.push('## Herramientas LSP (análisis de código)');
    for (const t of lspTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      if (lspUnavailableNote) line += ' (LSP no activo)';
      lines.push(line);
    }
    lines.push('');
  }

  if (mcpTools.length > 0) {
    if (mcpStyle === 'grouped') {
      lines.push('## Herramientas MCP');
      /** @type {Record<string, typeof tools>} */
      const grouped = Object.create(null);
      for (const t of mcpTools) {
        const server = t.server || 'unknown';
        if (!grouped[server]) grouped[server] = [];
        grouped[server].push(t);
      }
      for (const [server, serverTools] of Object.entries(grouped)) {
        lines.push(`  Servidor: ${server}`);
        for (const t of serverTools) {
          let line = `    - ${t.name}`;
          if (t.description) line += ` — ${t.description}`;
          lines.push(line);
        }
      }
      lines.push('');
      lines.push(...MCP_FORMAT_BLOCK_LINES);
      lines.push('');
    } else {
      const usedByOthers =
        openclawTools.length +
        desktopTools.length +
        lspTools.length +
        gitTools.length +
        githubTools.length +
        pluginTools.length;
      const capped = mcpTools.slice(0, Math.max(0, maxTools - usedByOthers));
      lines.push('## Herramientas MCP externas');
      for (const t of capped) {
        let line = `  - [${t.server}] ${t.name}`;
        if (t.description) line += ` — ${t.description}`;
        lines.push(line);
      }
      if (mcpTools.length > capped.length) {
        lines.push(`  ... y ${mcpTools.length - capped.length} herramientas más`);
      }
      lines.push('');
    }
  }

  if (gitTools.length > 0) {
    lines.push('## Herramientas Git (nativas)');
    for (const t of gitTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      if (t.highImpact) line += ' (requiere aprobación)';
      lines.push(line);
    }
    lines.push(...GIT_GUIDE_LINES);
    lines.push('');
  }

  if (githubTools.length > 0) {
    lines.push('## Herramientas GitHub (nativas)');
    for (const t of githubTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      if (t.highImpact) line += ' (requiere aprobación)';
      lines.push(line);
    }
    lines.push('');
  }

  if (includePlugins && pluginTools.length > 0) {
    lines.push('## Herramientas de plugins');
    for (const t of pluginTools) {
      let line = `  - ${t.name}`;
      if (t.description) line += `: ${t.description}`;
      if (t.highImpact) line += ' (requiere aprobación)';
      lines.push(line);
    }
    lines.push('');
  }

  if (usageStyle === 'legacy') {
    lines.push(...LEGACY_USAGE_LINES);
    if (mcpTools.length > 0) {
      lines.push('');
      lines.push(...LEGACY_MCP_USAGE_LINES);
    }
    lines.push('');
    if (rulesSection) lines.push(...LEGACY_RULES_LINES);
  } else {
    lines.push(...RESOLVER_USAGE_LINES);
  }

  return lines.join('\n');
}

module.exports = { renderToolCatalog };
