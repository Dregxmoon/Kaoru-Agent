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
 *   ACCIÓN        — nombre de la intención (siempre presente)
 *   ARCHIVO       — path de archivo (para create/edit/read/delete_file)
 *   RUTA          — directorio (para list_directory, create_directory)
 *   COMANDO       — comando shell (para run_command, git_action, etc.)
 *   QUERY         — búsqueda web (para web_search)
 *   URL           — URL (para navigate_browser)
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
  create_file:      'create_file',
  edit_file:        'edit_file',   // manejado especialmente en Planner._executeEditFile
  read_file:        'read',
  delete_file:      'exec',        // mock: delete via exec del
  create_directory: 'exec',        // mkdir
  list_directory:   'exec',        // ls / dir
  run_command:      'exec',
  run_script:       'exec',
  git_action:       'exec',
  install_package:  'exec',
  web_search:       'web_search',
  navigate_browser: 'browser',

  // MCP — independiente de OpenClaw. 'mcp' es un pseudo-tool, manejado
  // especialmente en Planner._executeMCP (ver ahí), no por OpenClawBridge.
  mcp_call:         'mcp',
};

// ── Descripción legible por acción ────────────────────────────────────────────
function _buildDescription(action, fields) {
  const f = fields;
  switch (action) {
    case 'create_file':      return `Crear archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'edit_file':        return `Editar archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'read_file':        return `Leer archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'delete_file':      return `Eliminar archivo: ${f.ARCHIVO || '(sin nombre)'}`;
    case 'create_directory': return `Crear directorio: ${f.RUTA || '(sin nombre)'}`;
    case 'list_directory':   return `Listar directorio: ${f.RUTA || '.'}`;
    case 'run_command':      return `Ejecutar: ${f.COMANDO || '(sin comando)'}`;
    case 'run_script':       return `Ejecutar script: ${f.COMANDO || '(sin comando)'}`;
    case 'git_action':       return `Git: ${f.COMANDO || '(sin comando)'}`;
    case 'install_package':  return `Instalar paquete: ${f.COMANDO || '(sin comando)'}`;
    case 'web_search':       return `Buscar en la web: "${f.QUERY || ''}"`;
    case 'navigate_browser': return `Navegar a: ${f.URL || '(sin URL)'}`;
    case 'mcp_call':         return `MCP · ${f.SERVIDOR || f.SERVER || '?'}: ${f.HERRAMIENTA || f.TOOL || '?'}`;
    default:                 return action;
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
    console.warn('[structured-parser] valor rechazado por caracteres de shell sospechosos:', JSON.stringify(trimmed));
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
  if (braceStart === -1 || braceStart - searchFrom > 3) return null;

  let depth = 0, inString = false, escaped = false;
  for (let i = braceStart; i < content.length; i++) {
    const c = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return { json: content.slice(braceStart, i + 1), fullMatchStart: m.index, fullMatchEnd: i + 1 };
      }
    }
  }
  return null; // JSON sin cerrar — se ignora, no se intenta adivinar
}

// ── Construcción de params para OpenClawBridge ────────────────────────────────
function _buildParams(action, fields, userGoal, projectCwd) {
  const cwd = projectCwd || process.cwd();

  switch (action) {
    case 'create_file':
      return {
        path:        fields.ARCHIVO,
        instruction: userGoal || `Crear el archivo ${fields.ARCHIVO}`,
      };

    case 'edit_file':
      return {
        path:        fields.ARCHIVO,
        instruction: userGoal || `Editar el archivo ${fields.ARCHIVO}`,
      };

    case 'read_file':
      return { path: fields.ARCHIVO };

    case 'mcp_call': {
      const server   = fields.SERVIDOR || fields.SERVER;
      const toolName = fields.HERRAMIENTA || fields.TOOL;
      if (!server || !toolName) {
        console.warn('[structured-parser] mcp_call sin SERVIDOR o HERRAMIENTA:', fields);
        return null;
      }
      let mcpArgs = {};
      if (fields.PARAMS) {
        try {
          mcpArgs = JSON.parse(fields.PARAMS);
        } catch (e) {
          console.warn('[structured-parser] PARAMS de mcp_call no es JSON válido, se ignora:', fields.PARAMS);
          return null;
        }
      }
      return { server, tool: toolName, args: mcpArgs };
    }

    case 'delete_file': {
      const safeArchivo = _sanitizeShellArg(fields.ARCHIVO);
      if (!safeArchivo) return null;
      return {
        command: process.platform === 'win32'
          ? `del "${safeArchivo}"`
          : `rm "${safeArchivo}"`,
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
      return {
        command: fields.COMANDO,
        cwd,
      };

    case 'web_search':
      return { query: fields.QUERY, max_results: 5 };

    case 'navigate_browser':
      return { action: 'navigate', url: fields.URL };

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
   *
   * @returns {Array} — array de acciones (compatible con ActionParser original)
   *                    campo extra `source: 'structured' | 'legacy_regex'`
   */
  parse(llmResponse, userGoal = '', toolIntent = null) {
    // ── 1. Intentar parsear bloque estructurado ───────────────────────────────
    const structured = this._parseStructuredBlock(llmResponse, userGoal);
    if (structured.length > 0) {
      console.log(`[structured-parser] Bloque estructurado encontrado: ${structured.map(a => a.tool).join(', ')}`);
      return structured;
    }

    // ── 2. Fallback: ActionParser original (regex) ────────────────────────────
    // Solo si no hay bloque estructurado — compatibilidad hacia atrás.
    try {
      const { ActionParser } = require('../planner/Planner.js');
      const legacyActions = ActionParser.parse(llmResponse, userGoal);

      if (legacyActions.length > 0) {
        console.log(`[structured-parser] Fallback a ActionParser legacy: ${legacyActions.map(a => a.tool).join(', ')}`);
        return legacyActions.map(a => ({ ...a, source: 'legacy_regex' }));
      }
    } catch (e) {
      console.warn('[structured-parser] Error en ActionParser legacy:', e.message);
    }

    // ── 3. Si el IntentDetector detectó algo con alta confianza pero el LLM
    //       no respondió con formato estructurado, lo reportamos para debug.
    if (toolIntent?.detected && toolIntent.level === 'high') {
      console.warn(
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
    const BLOCK_RE = /```action\s*\n([\s\S]*?)```/gi;

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
      workingContent = content.slice(0, paramsExtracted.fullMatchStart)
                     + content.slice(paramsExtracted.fullMatchEnd);
    }

    // Extraer el resto de campos clave:valor separados por "|" o por newlines
    const normalized = workingContent.replace(/\|/g, '\n');

    for (const line of normalized.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key   = line.slice(0, colonIdx).trim().toUpperCase();
      const value = line.slice(colonIdx + 1).trim();

      if (key && value) fields[key] = value;
    }

    // ACCIÓN es obligatorio
    const rawAction = fields['ACCIÓN'] || fields['ACCION'] || fields['ACTION'];
    if (!rawAction) {
      console.warn('[structured-parser] Bloque sin campo ACCIÓN:', content);
      return null;
    }

    // Normalizar nombre de acción (el LLM a veces usa mayúsculas o espacios)
    const action = rawAction.toLowerCase().trim().replace(/\s+/g, '_');

    const tool = ACTION_TO_TOOL[action];
    if (!tool) {
      // Acción desconocida — podría ser answer_question o explain_code, que no tienen herramienta
      if (action === 'answer_question' || action === 'explain_code') {
        return null; // No hay herramienta que ejecutar
      }
      console.warn(`[structured-parser] Acción no reconocida: "${action}"`);
      return null;
    }

    // Validaciones mínimas por tipo de acción
    if (['create_file', 'edit_file', 'read_file', 'delete_file'].includes(action)) {
      if (!fields.ARCHIVO) {
        console.warn(`[structured-parser] ${action} sin campo ARCHIVO`);
        return null;
      }
    }

    if (['run_command', 'run_script', 'git_action', 'install_package'].includes(action)) {
      if (!fields.COMANDO) {
        console.warn(`[structured-parser] ${action} sin campo COMANDO`);
        return null;
      }
    }

    if (action === 'web_search' && !fields.QUERY) {
      console.warn('[structured-parser] web_search sin campo QUERY');
      return null;
    }

    if (action === 'navigate_browser' && !fields.URL) {
      console.warn('[structured-parser] navigate_browser sin campo URL');
      return null;
    }

    const params = _buildParams(action, fields, userGoal, this._cwd);
    if (!params) {
      console.warn(`[structured-parser] ${action} descartado — params inválidos tras sanitización`);
      return null;
    }
    const description = _buildDescription(action, fields);

    return {
      tool,
      params,
      description,
      action,    // guardamos la intención original también
      source: 'structured',
    };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _instance = null;

function getStructuredActionParser(projectCwd = null) {
  if (!_instance) _instance = new StructuredActionParser(projectCwd);
  return _instance;
}

module.exports = { StructuredActionParser, getStructuredActionParser };
