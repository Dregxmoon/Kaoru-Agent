// @ts-nocheck
/**
 * StructuredActionParser.js — Fase 3
 *
 * Reemplaza el ActionParser basado en regex de Planner.js para el flujo
 * donde el LLM fue instruido con toolIntent (nivel high o medium).
 *
 * Cuando el GroqSerializer inyectó una instrucción de formato en el
 * system prompt, el LLM responde con un bloque así:
 *
 *   ```action
 *   ACCIÓN: edit_file | ARCHIVO: src/main.js
 *   ```
 *
 * Este parser extrae ese bloque de forma determinista sin regex frágil
 * sobre narrativa libre — solo busca el bloque delimitado.
 *
 * Si no encuentra bloque estructurado (el LLM ignoró la instrucción,
 * o el nivel era 'none'), delega en el ActionParser original de Planner.js
 * como fallback — compatibilidad hacia atrás total.
 *
 * Campos que puede devolver el bloque:
 *   ACCIÓN        — nombre de la intención (siempre presente, salvo con MCP_TOOL)
 *   ARCHIVO       — path de archivo (para create/edit/read/delete_file)
 *   RUTA          — directorio (para list_directory, create_directory)
 *   COMANDO       — comando shell (para run_command, git_action, etc.)
 *   QUERY         — búsqueda web (para web_search)
 *   URL           — URL (para navigate_browser)
 *   MCP_TOOL      — tool MCP como "servidor.herramienta" (p.ej.
 *                   filesystem.write_file). Cuando la precedencia activa es
 *                   MCP y el tool-calling nativo falla, el LLM la usa para
 *                   expresar "llamar write_file del servidor filesystem".
 *                   Se traduce a la pseudo-tool 'mcp' con params
 *                   { server, tool, args } para MCPManager.callTool().
 *                   Los campos genéricos (ARCHIVO→path, RUTA→path,
 *                   CONTENIDO→content, COMANDO→command, QUERY→query,
 *                   URL→url) se convierten en argumentos de la tool, y
 *                   PARAMS (JSON) si viene los sobreescribe.
 *
 * Contrato de salida (mismo que ActionParser original):
 * [
 *   {
 *     tool:        string,   — herramienta de OpenClaw
 *     params:      object,   — parámetros para OpenClawBridge.execute()
 *     description: string,   — descripción legible para el usuario
 *     source:      'structured' | 'legacy_regex'
 *   }
 * ]
 */

'use strict';
const logger = require('../observability/Logger.js');

const path = require('path');

// ── Mapa action → tool de OpenClaw ────────────────────────────────────────────
// Mismo mapping que en el catálogo de init_vectors.js para consistencia.
const ACTION_TO_TOOL = {
  // FIX: 'create_file' iba mapeado a tool 'write', pero Planner._executeStep
  // solo dispara el flujo especial (llm → write → verify, ver
  // _executeCreateFile) cuando tool === 'create_file' exactamente. Con
  // 'write' se habría llamado a OpenClawBridge.execute('write', {path,
  // instruction}) directo — y el schema de 'write' espera {path, content},
  // no {path, instruction}, así que 'content' habría llegado undefined.
  create_file: 'create_file',
  edit_file: 'edit_file', // manejado especialmente en Planner._executeEditFile
  write: 'create_file', // alias moderno (el LLM en fallback textual usa write/edit)
  edit: 'edit_file',
  read: 'read',
  read_file: 'read',
  delete_file: 'exec', // mock: delete via exec del
  create_directory: 'exec', // mkdir
  list_directory: 'exec', // ls / dir
  run_command: 'exec',
  run_script: 'exec',
  git_action: 'exec',
  install_package: 'exec',
  exec: 'exec', // alias directo (algunos modelos usan "exec")
  web_search: 'web_search',
  websearch: 'websearch',
  webfetch: 'webfetch',
  fetch_web: 'webfetch',
  navigate_browser: 'browser',
  browser_action: 'browser',
  apply_patch: 'apply_patch',
  run_code: 'code_execution',
  // Subagentes: perfil opcional (general por defecto). Ahora el fallback
  // textual puede delegar sub-tareas igual que el tool-calling nativo.
  subagent: 'subagent',

  // MCP — independiente de OpenClaw. 'mcp' es un pseudo-tool, manejado
  // especialmente en Planner._executeMCP (ver ahí), no por OpenClawBridge.
  mcp_call: 'mcp',

  // Plugins — pseudo-tool manejado en Planner._executePlugin (ver ahí).
  plugin_call: 'plugin',
};

// ── Descripción legible por acción ────────────────────────────────────────────
function _buildDescription(action, fields) {
  const f = fields;
  switch (action) {
    case 'create_file':
      return `Crear archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'edit_file':
      return `Editar archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'read_file':
      return `Leer archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'delete_file':
      return `Eliminar archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'create_directory':
      return `Crear directorio: ${f.RUTA || '(sin nombre)'}`;
    case 'list_directory':
      return `Listar directorio: ${f.RUTA || '.'}`;
    case 'run_command':
      return `Ejecutar: ${f.COMANDO || '(sin comando)'}`;
    case 'run_script':
      return `Ejecutar script: ${f.COMANDO || '(sin comando)'}`;
    case 'git_action':
      return `Git: ${f.COMANDO || '(sin comando)'}`;
    case 'install_package':
      return `Instalar paquete: ${f.COMANDO || '(sin comando)'}`;
    case 'web_search':
      return `Buscar en la web: "${f.QUERY || ''}"`;
    case 'websearch':
      return `Buscar en la web (ligero): "${f.QUERY || ''}"`;
    case 'webfetch':
      return `Leer URL: ${f.URL || '(sin URL)'}`;
    case 'navigate_browser':
      return `Navegar a: ${f.URL || '(sin URL)'}`;
    case 'browser_action':
      return `Navegador: ${f.ACCION || f.ACTION || f.URL || '(sin acción)'}`;
    case 'apply_patch':
      return `Aplicar patch a: ${f.ARCHIVO || '(sin archivo)'}`;
    case 'run_code':
      return `Ejecutar código: ${(f.CÓDIGO || f.CODIGO || f.CODE || '').slice(0, 60)}`;
    case 'subagent':
      return `Subagente (${f.AGENT || 'general'}): ${f.TAREA || f.TASK || '(sin tarea)'}`;
    case 'mcp_call':
      if (f.MCP_TOOL) return `MCP · ${f.MCP_TOOL}`;
      return `MCP · ${f.SERVIDOR || f.SERVER || '?'}: ${f.HERRAMIENTA || f.TOOL || '?'}`;
    case 'plugin_call':
      return `Plugin · ${f.HERRAMIENTA || f.TOOL || f.NOMBRE || '?'}`;
    default:
      return action;
  }
}

// ── Sanitización antes de interpolar en un comando de shell ──────────────────
// ARCHIVO/RUTA vienen del LLM, que a su vez puede haber sido influenciado por
// contenido externo no confiable (p.ej. una página web leída con browser/
// web_search — inyección de prompt indirecta). Antes de meterlos en un string
// de shell como `del "${valor}"`, hay que asegurarse de que no puedan romper
// el escapado e inyectar un comando extra. Esto es defensa en profundidad
// ADEMÁS del diálogo de aprobación — si por lo que sea ese diálogo se salta,
// esto igual frena la inyección.
const SHELL_METACHAR_RE = /["'`$;&|<>\n\r]/;

function _sanitizeShellArg(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SHELL_METACHAR_RE.test(trimmed)) {
    logger.warn(
      'StructuredActionParser',
      '[structured-parser] valor rechazado por caracteres de shell sospechosos:',
      JSON.stringify(trimmed)
    );
    return null;
  }
  return trimmed;
}

// ── Extracción de JSON balanceado para el campo PARAMS ────────────────────────
// PARAMS (usado por mcp_call) trae JSON, que casi siempre tiene ':' y a
// veces '{...}' anidado. El split genérico de campos de abajo parte por
// "|" y toma el primer ':' de cada línea — funciona para un JSON plano de
// una sola línea, pero un regex simple para encontrar el cierre del
// objeto se rompe con JSON anidado (se para en el primer '}', que puede
// ser el de un objeto interno). Por eso esto cuenta llaves de verdad,
// respetando strings, en vez de usar regex para el cierre.
function _extractBalancedJSON(content, label) {
  const labelRe = new RegExp(label + '\\s*:\\s*', 'i');
  const m = content.match(labelRe);
  if (!m) return null;

  const searchFrom = m.index + m[0].length;
  const braceStart = content.indexOf('{', searchFrom);
  // El '{' debe venir casi inmediatamente después del label — si hay texto
  // largo en medio, no es el JSON de este campo.
  if (braceStart === -1 || braceStart - searchFrom > 10) return null;

  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = braceStart; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return {
          json: content.slice(braceStart, i + 1),
          fullMatchStart: m.index,
          fullMatchEnd: i + 1,
        };
      }
    }
  }
  return null; // JSON sin cerrar — se ignora, no se intenta adivinar
}

/**
 * Extrae el span crudo de un campo de bloque estructurado (CONTENIDO, COMANDO),
 * SIN normalizar pipes (mismo patrón que _extractBalancedJSON con PARAMS). El
 * valor empieza tras "<CAMPO>:" y termina en la siguiente línea que parezca
 * otro campo "CLAVE: valor" o en el final del bloque. Extraerlo sobre el texto
 * original ANTES del replace de "|" → salto de línea evita corromper pipes
 * literales del valor (operador || de JS, alternancia de regex, tablas
 * markdown).
 *
 * @param {string} content
 * @param {string} fieldName
 * @param {boolean} [allowInline]
 *   true: acepta el ancla compacta "| CAMPO:" (formato de una línea); false:
 *   solo acepta el ancla al inicio de línea (formato multilínea). El formato
 *   compacto de una línea no puede usar span — el valor termina en el mismo
 *   "|" que separa los campos siguientes y debe pasar por el parser genérico.
 * @returns {{ value: string, start: number, end: number }|null}
 *   null si no hay el campo. `[start,end)` es el span completo (desde el
 *   inicio de la línea "<CAMPO>:" hasta el campo siguiente o el final).
 */
function _extractFieldSpan(content, fieldName, allowInline = true) {
  const re = new RegExp('(^|\\n|\\|)[ \\t]*' + fieldName + ':[ \\t]*', 'i');
  const m = content.match(re);
  if (!m) return null;
  if (!allowInline && m[1] === '|') return null;
  const valueStart = m.index + m[0].length;
  const rest = content.slice(valueStart);
  const nextField = rest.match(/(^|\n)[ \t]*[A-ZÀ-ÚÑ_][A-ZÀ-ÚÑ_0-9]{1,}:[ \t]/);
  const valueEnd = nextField ? valueStart + nextField.index : content.length;
  return {
    value: content.slice(valueStart, valueEnd).trim(),
    start: m.index,
    end: valueEnd,
  };
}

// ── Parseo de MCP_TOOL: "servidor.herramienta" ───────────────────────────────
// Formato: filesystem.write_file, filesystem/write_file, mcp__filesystem__write_file.
// Se parte por el PRIMER separador ('.' o '/') — el nombre de la herramienta
// puede contener puntos (p.ej. server.tool.tool2) pero el servidor nunca.
function _parseMCPTool(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dotIdx = trimmed.indexOf('.');
  const slashIdx = trimmed.indexOf('/');
  let sepIdx = -1;
  if (dotIdx === -1) sepIdx = slashIdx;
  else if (slashIdx === -1) sepIdx = dotIdx;
  else sepIdx = Math.min(dotIdx, slashIdx);
  if (sepIdx === -1) return null;
  const server = trimmed.slice(0, sepIdx).trim();
  const tool = trimmed.slice(sepIdx + 1).trim();
  if (!server || !tool) return null;
  return { server, tool };
}

// ── Args MCP desde campos genéricos del bloque estructurado ──────────────────
// El LLM en fallback textual conoce el vocabulario del bloque (ARCHIVO,
// CONTENIDO, ...) pero no el nombre de cada parámetro del schema MCP. Se
// traducen los campos genéricos a los nombres de parámetro más comunes de las
// tools MCP del servidor filesystem/código. PARAMS (JSON explícito) gana sobre
// el mapeo genérico si ambos vienen.
const MCP_FIELD_TO_ARG = {
  ARCHIVO: 'path',
  RUTA: 'path',
  CONTENIDO: 'content',
  COMANDO: 'command',
  QUERY: 'query',
  URL: 'url',
};

function _buildMCPArgs(fields) {
  const args = {};
  for (const [field, param] of Object.entries(MCP_FIELD_TO_ARG)) {
    if (fields[field]) args[param] = fields[field];
  }
  if (fields.PARAMS) {
    try {
      Object.assign(args, JSON.parse(fields.PARAMS));
    } catch (e) {
      logger.warn(
        'StructuredActionParser',
        '[structured-parser] PARAMS de mcp_call no es JSON válido, se ignora:',
        fields.PARAMS
      );
      return null;
    }
  }
  return args;
}

// Construye el objeto params que espera la pseudo-tool 'mcp' de
// AgentLoop/Planner._executeMCP: { server, tool, args }.
function _mcpParams(server, tool, fields) {
  const args = _buildMCPArgs(fields);
  if (args === null) return null;
  return { server, tool, args };
}

// ── Construcción de params para OpenClawBridge ────────────────────────────────
function _buildParams(action, fields, userGoal, projectCwd) {
  const cwd = projectCwd || process.cwd();

  // Alias modernos (fallback textual del LLM usa write/edit/read)
  const MODERN_ALIASES = { write: 'create_file', edit: 'edit_file', read: 'read_file' };
  action = MODERN_ALIASES[action] || action;

  switch (action) {
    case 'create_file':
      return {
        path: fields.ARCHIVO,
        // G.1: el LLM puede incluir el contenido en CONTENIDO: — si viene,
        // se usa como instruction (en vez de repetir el userGoal como texto).
        instruction: fields.CONTENIDO || userGoal || `Crear el archivo ${fields.ARCHIVO}`,
      };

    case 'edit_file':
      return {
        path: fields.ARCHIVO,
        instruction: fields.CONTENIDO || userGoal || `Editar el archivo ${fields.ARCHIVO}`,
      };

    case 'read_file':
      return { path: fields.ARCHIVO };

    case 'mcp_call': {
      const server = fields.SERVIDOR || fields.SERVER;
      let toolName = fields.HERRAMIENTA || fields.TOOL;
      if (!toolName && fields.MCP_TOOL) {
        const parsed = _parseMCPTool(fields.MCP_TOOL);
        if (!parsed) {
          logger.warn(
            'StructuredActionParser',
            '[structured-parser] MCP_TOOL no es "servidor.herramienta":',
            fields.MCP_TOOL
          );
          return null;
        }
        toolName = parsed.tool;
        // Si el bloque trae SERVIDOR y MCP_TOOL, SERVIDOR manda (el LLM pudo
        // usar el atajo y a la vez fijar el servidor explícito).
        if (server && server !== parsed.server) {
          logger.warn(
            'StructuredActionParser',
            `[structured-parser] SERVIDOR "${server}" difiere del de MCP_TOOL "${parsed.server}", se usa SERVIDOR`
          );
        }
        // SIN server explícito, se toma el del MCP_TOOL.
        if (!server) return _mcpParams(parsed.server, toolName, fields);
      }
      if (!server || !toolName) {
        logger.warn(
          'StructuredActionParser',
          '[structured-parser] mcp_call sin SERVIDOR o HERRAMIENTA:',
          fields
        );
        return null;
      }
      return _mcpParams(server, toolName, fields);
    }

    case 'plugin_call': {
      const toolId = fields.HERRAMIENTA || fields.TOOL || fields.NOMBRE;
      if (!toolId) {
        logger.warn(
          'StructuredActionParser',
          '[structured-parser] plugin_call sin HERRAMIENTA/TOOL:',
          fields
        );
        return null;
      }
      let pluginArgs = {};
      if (fields.PARAMS) {
        try {
          pluginArgs = JSON.parse(fields.PARAMS);
        } catch (e) {
          logger.warn(
            'StructuredActionParser',
            '[structured-parser] PARAMS de plugin_call no es JSON válido, se ignora:',
            fields.PARAMS
          );
          return null;
        }
      }
      return { name: toolId, args: pluginArgs };
    }

    case 'delete_file': {
      const safeArchivo = _sanitizeShellArg(fields.ARCHIVO);
      if (!safeArchivo) return null;
      return {
        command: process.platform === 'win32' ? `del "${safeArchivo}"` : `rm "${safeArchivo}"`,
        cwd,
      };
    }

    case 'create_directory': {
      const safeRuta = _sanitizeShellArg(fields.RUTA || fields.ARCHIVO || 'nueva-carpeta');
      if (!safeRuta) return null;
      return {
        command: `mkdir "${safeRuta}"`,
        cwd,
      };
    }

    case 'list_directory': {
      const safeDir = _sanitizeShellArg(fields.RUTA || fields.ARCHIVO || '.');
      if (!safeDir) return null;
      return {
        command: process.platform === 'win32' ? `dir "${safeDir}"` : `ls -la "${safeDir}"`,
        cwd,
      };
    }

    case 'run_command':
    case 'run_script':
    case 'git_action':
    case 'install_package':
    case 'exec':
      return {
        command: fields.COMANDO,
        cwd,
      };

    case 'web_search':
      return { query: fields.QUERY, max_results: 5 };

    case 'websearch':
      return { query: fields.QUERY, max_results: 5 };

    case 'webfetch':
      return { url: fields.URL };

    case 'navigate_browser':
    case 'browser_action':
      return {
        action: fields.ACCION?.toLowerCase() || fields.ACTION?.toLowerCase() || 'navigate',
        url: fields.URL,
      };

    case 'apply_patch':
      return { path: fields.ARCHIVO, patch: fields.PATCH || fields.DIFF };

    case 'run_code':
      return { code: fields.CÓDIGO || fields.CODIGO || fields.CODE };

    case 'subagent': {
      const params = {
        task: fields.TAREA || fields.TASK || fields.CONTENIDO || userGoal || '',
      };
      if (fields.CONTEXTO || fields.CONTEXT) params.context = fields.CONTEXTO || fields.CONTEXT;
      if (fields.AGENT) params.agent = fields.AGENT;
      if (fields.MAX_ITERATIONS) {
        const n = Number(fields.MAX_ITERATIONS);
        if (Number.isInteger(n) && n > 0) params.max_iterations = n;
      }
      // PARAMS (JSON) gana sobre los campos sueltos: el LLM nativo suele
      // mandar { task, agent, context, max_iterations } completo ahí.
      if (fields.PARAMS) {
        let parsed = null;
        try {
          parsed = typeof fields.PARAMS === 'object' ? fields.PARAMS : JSON.parse(fields.PARAMS);
        } catch (_) {}
        if (parsed && typeof parsed === 'object') Object.assign(params, parsed);
      }
      return params;
    }

    default:
      return { raw: fields };
  }
}

// ── Parser principal ──────────────────────────────────────────────────────────

class StructuredActionParser {
  /**
   * @param {string} projectCwd — directorio de trabajo del proyecto
   */
  constructor(projectCwd = null) {
    this._cwd = projectCwd;
  }

  /**
   * Intenta parsear el bloque de acción estructurado de la respuesta del LLM.
   *
   * @param {string} llmResponse — respuesta completa del LLM
   * @param {string} userGoal    — mensaje original del usuario (para instrucción de edición)
   * @param {object} toolIntent  — resultado de IntentDetector (opcional, para fallback informado)
   * @param {object} opts        — opciones de parseo:
   *   - `skipLegacy: true` → NO aplicar el fallback legacy de prosa (ActionParser).
   *     Sirve para mensajes que son REPORTES de trabajo ya hecho (p. ej. el
   *     resumen final de un subagente: "Terminé escribiendo el archivo X...").
   *     Sin esto, el parser legacy re-detecta una intención de edición sobre ese
   *     texto y re-ejecuta una acción que el usuario nunca pidió.
   *
   * @returns {Array} — array de acciones (compatible con ActionParser original)
   *                    campo extra `source: 'structured' | 'legacy_regex'`
   */
  parse(llmResponse, userGoal = '', toolIntent = null, opts = {}) {
    // ── 1. Intentar parsear bloque estructurado ───────────────────────────────
    const structured = this._parseStructuredBlock(llmResponse, userGoal);
    if (structured.length > 0) {
      logger.info(
        'StructuredActionParser',
        `[structured-parser] Bloque estructurado encontrado: ${structured.map((a) => a.tool).join(', ')}`
      );
      return structured;
    }

    // ── 1b. Modo reporte (subagentes): texto sin bloque de acción = resumen ──
    // El resumen final de un subagente es un REPORTE de lo que ya hizo, no una
    // instrucción. Dejarlo pasar por el parser legacy de prosa hace que frases
    // naturales ("Terminé escribiendo el archivo X", "Hice la modificación de
    // Y") se reinterpreten como órdenes de edición y se re-ejecute algo no
    // pedido. En este modo solo se honran bloques estructurados / tool calls.
    if (opts.skipLegacy) {
      return [];
    }

    // ── 2. Fallback: ActionParser original (regex) ────────────────────────────
    // Solo si no hay bloque estructurado — compatibilidad hacia atrás.
    try {
      const { ActionParser } = require('./ActionParser.js');
      const legacyActions = ActionParser.parse(llmResponse, userGoal);

      if (legacyActions.length > 0) {
        logger.info(
          'StructuredActionParser',
          `[structured-parser] Fallback a ActionParser legacy: ${legacyActions.map((a) => a.tool).join(', ')}`
        );
        return legacyActions.map((a) => ({ ...a, source: 'legacy_regex' }));
      }
    } catch (e) {
      logger.warn(
        'StructuredActionParser',
        '[structured-parser] Error en ActionParser legacy:',
        e.message
      );
    }

    // ── 3. Si el IntentDetector detectó algo con alta confianza pero el LLM
    //       no respondió con formato estructurado, lo reportamos para debug.
    if (toolIntent?.detected && toolIntent.level === 'high') {
      logger.warn(
        'StructuredActionParser',
        `[structured-parser] El LLM ignoró el bloque de acción. ` +
          `Intent detectado: ${toolIntent.action} (${(toolIntent.confidence * 100).toFixed(0)}%). ` +
          `El system prompt puede necesitar ajuste.`
      );
    }

    return [];
  }

  /**
   * Extrae el bloque ```action ... ``` de la respuesta del LLM y lo parsea.
   * Busca UNO o VARIOS bloques (el LLM puede incluir múltiples acciones).
   */
  _parseStructuredBlock(llmResponse, userGoal) {
    if (!llmResponse) return [];

    // Regex para encontrar bloques ```action ... ```
    // Usamos un regex simple y robusto — no narrativa libre, solo el bloque delimitado.
    const BLOCK_RE = /```action\s*\n?([\s\S]*?)```/gi;

    const actions = [];
    let match;

    while ((match = BLOCK_RE.exec(llmResponse)) !== null) {
      const blockContent = match[1].trim();
      const parsed = this._parseBlockContent(blockContent, userGoal);
      if (parsed) actions.push(parsed);
    }

    return actions;
  }

  /**
   * Parsea el contenido de un bloque individual.
   *
   * Formato esperado:
   *   ACCIÓN: edit_file | ARCHIVO: src/main.js
   *
   * Puede venir en múltiples líneas si hay varios campos:
   *   ACCIÓN: run_command
   *   COMANDO: npm install express
   */
  _parseBlockContent(content, userGoal) {
    if (!content) return null;

    const fields = {};

    // PARAMS (JSON) se extrae ANTES de la normalización genérica — ver
    // _extractBalancedJSON arriba para el porqué.
    let workingContent = content;
    const paramsExtracted = _extractBalancedJSON(content, 'PARAMS');
    if (paramsExtracted) {
      fields['PARAMS'] = paramsExtracted.json;
      workingContent =
        content.slice(0, paramsExtracted.fullMatchStart) +
        content.slice(paramsExtracted.fullMatchEnd);
    }

    // G.1 + corrupción de "|": CONTENIDO puede ser multilínea (markdown/código)
    // y contener "|" literales. Se extrae ANTES de la normalización de pipes
    // (igual que PARAMS) sobre el texto original: el valor empieza tras
    // "CONTENIDO:" y continúa hasta la siguiente línea "CLAVE: valor" o el final
    // del bloque. Si se normalizara primero, "||" de JS o "a|b" de regex se
    // volverían saltos de línea y el archivo quedaría escrito corrupto en disco.
    const contExtracted = _extractFieldSpan(workingContent, 'CONTENIDO');
    if (contExtracted) {
      fields['CONTENIDO'] = contExtracted.value;
      workingContent =
        workingContent.slice(0, contExtracted.start) + workingContent.slice(contExtracted.end);
    }

    // COMANDO multilínea (p.ej. `node -e` con el script en varias líneas): el
    // valor se extrae con el mismo span y ANTES de la normalización de pipes,
    // así un script con `||`/regex no se corrompe y no se trunca en la primera
    // línea como hacía el parser genérico. Solo cuando el campo está al inicio
    // de línea: el formato compacto "| COMANDO: x | CWD: y" sigue el camino
    // genérico (allí el valor es de una línea y el "|" separa campos).
    const cmdExtracted = _extractFieldSpan(workingContent, 'COMANDO', false);
    if (cmdExtracted) {
      fields['COMANDO'] = cmdExtracted.value;
      workingContent =
        workingContent.slice(0, cmdExtracted.start) + workingContent.slice(cmdExtracted.end);
    }

    // Extraer el resto de campos clave:valor separados por "|" o por newlines.
    // Acá la normalización "|" → salto de línea es segura: workingContent ya no
    // tiene CONTENIDO, solo los campos cortos tipo ACCIÓN/ARCHIVO de una línea.
    const normalized = workingContent.replace(/\|/g, '\n');

    for (const line of normalized.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim().toUpperCase();
      const value = line.slice(colonIdx + 1).trim();

      if (key && value) fields[key] = value;
    }

    // ACCIÓN es obligatorio — salvo que venga MCP_TOOL, que identifica la
    // tool MCP directamente y prescinde del nombre de intención OpenClaw.
    const rawAction = fields['ACCIÓN'] || fields['ACCION'] || fields['ACTION'];
    let action;
    if (fields['MCP_TOOL']) {
      action = 'mcp_call';
    } else if (rawAction) {
      // Normalizar nombre de acción (el LLM a veces usa mayúsculas o espacios)
      action = rawAction.toLowerCase().trim().replace(/\s+/g, '_');
    } else {
      logger.warn(
        'StructuredActionParser',
        '[structured-parser] Bloque sin campo ACCIÓN ni MCP_TOOL:',
        content
      );
      return null;
    }

    const tool = ACTION_TO_TOOL[action];
    if (!tool) {
      // Acción desconocida — podría ser answer_question o explain_code, que no tienen herramienta
      if (action === 'answer_question' || action === 'explain_code') {
        return null; // No hay herramienta que ejecutar
      }
      // 2.2: no descartar en silencio. Se devuelve un marcador con
      // source:'unrecognized' para que AgentLoop lo convierta en una señal
      // visible (feedback al LLM / aviso al usuario) en vez de tragárselo.
      logger.warn(
        'StructuredActionParser',
        `[structured-parser] Acción no reconocida: "${action}" — se marca para notificar al usuario`
      );
      return {
        tool: 'unknown_action',
        params: { action },
        description: `Acción no reconocida: ${action}`,
        action,
        source: 'unrecognized',
      };
    }

    // Validaciones mínimas por tipo de acción
    if (['create_file', 'edit_file', 'read_file', 'delete_file'].includes(action)) {
      if (!fields.ARCHIVO) {
        logger.warn('StructuredActionParser', `[structured-parser] ${action} sin campo ARCHIVO`);
        return null;
      }
    }

    if (['run_command', 'run_script', 'git_action', 'install_package'].includes(action)) {
      if (!fields.COMANDO) {
        logger.warn('StructuredActionParser', `[structured-parser] ${action} sin campo COMANDO`);
        return null;
      }
    }

    if (action === 'web_search' && !fields.QUERY) {
      logger.warn('StructuredActionParser', '[structured-parser] web_search sin campo QUERY');
      return null;
    }

    if (action === 'websearch' && !fields.QUERY) {
      logger.warn('StructuredActionParser', '[structured-parser] websearch sin campo QUERY');
      return null;
    }

    if (action === 'webfetch' && !fields.URL) {
      logger.warn('StructuredActionParser', '[structured-parser] webfetch sin campo URL');
      return null;
    }

    if (action === 'navigate_browser' || action === 'browser_action') {
      if (!fields.URL && !fields.ACCION && !fields.ACTION) {
        logger.warn('StructuredActionParser', '[structured-parser] browser sin URL ni ACCION');
        return null;
      }
    }

    if (action === 'apply_patch' && !fields.ARCHIVO) {
      logger.warn('StructuredActionParser', '[structured-parser] apply_patch sin campo ARCHIVO');
      return null;
    }

    if (action === 'run_code' && !fields.CÓDIGO && !fields.CODIGO && !fields.CODE) {
      logger.warn('StructuredActionParser', '[structured-parser] run_code sin campo CÓDIGO');
      return null;
    }

    const params = _buildParams(action, fields, userGoal, this._cwd);
    if (!params) {
      logger.warn(
        'StructuredActionParser',
        `[structured-parser] ${action} descartado — params inválidos tras sanitización`
      );
      return null;
    }
    const description = _buildDescription(action, fields);

    return {
      tool,
      params,
      description,
      action, // guardamos la intención original también
      source: 'structured',
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance = null;

function getStructuredActionParser(projectCwd = null) {
  if (!_instance) {
    _instance = new StructuredActionParser(projectCwd);
  } else if (projectCwd && _instance._cwd !== projectCwd) {
    _instance._cwd = projectCwd;
  }
  return _instance;
}

module.exports = { StructuredActionParser, getStructuredActionParser };
