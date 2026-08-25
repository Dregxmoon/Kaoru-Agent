// @ts-check
'use strict';

/**
 * startupCheck.js — validación temprana de config.json para el arranque.
 *
 * Hoy ConfigManager.load() degrada en silencio: config ausente → defaults,
 * JSON corrupto → defaults + log solo-verbose. El usuario no se entera hasta
 * que su primer mensaje falla con un error críptico de API key.
 *
 * Esta función devuelve issues ESTRUCTURADAS para que main.js las muestre
 * EN LA VENTANA durante el arranque, cubriendo los 3 casos:
 *   1. config.json no existe            → cómo crearlo desde el ejemplo
 *   2. existe pero JSON inválido        → línea/columna del error
 *   3. válido pero sin ninguna API key  → mensaje accionable del selector
 *      de modelos (mismo texto que LLMProvider usa al fallar)
 */

const fs = require('fs');

/**
 * Escáner JSON mínimo: devuelve el OFFSET del primer error de sintaxis.
 * Solo corre cuando JSON.parse ya falló y el mensaje del runtime no incluye
 * posición (Node 18/Electron 28 trunca el contexto sin línea/columna).
 * Soporta strings con escapes, números, literales, objetos y arrays anidados.
 * @param {string} raw
 * @returns {number} índice base-0 del problema, o -1 si no lo encuentra
 */
function _scanJsonFirstError(raw) {
  const n = raw.length;
  let i = 0;
  let depth = 0;

  const failAt = () => i;
  const skipWs = () => {
    while (i < n && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r')) i++;
  };

  /** @returns {boolean} true = OK, false = error en i */
  function parseString() {
    i++; // comilla inicial
    while (i < n) {
      const c = raw[i];
      if (c === '"') { i++; return true; }
      if (c === '\\') { i += 2; continue; }
      if (c === '\n' || c === '\r') return false; // salto sin escape
      i++;
    }
    return false;
  }

  function expectValue() {
    if (depth > 200) return false;
    skipWs();
    if (i >= n) return false;
    const c = raw[i];
    if (c === '{') { i++; return parseObject(); }
    if (c === '[') { i++; return parseArray(); }
    if (c === '"') return parseString();
    if (raw.startsWith('true', i)) { i += 4; return true; }
    if (raw.startsWith('false', i)) { i += 5; return true; }
    if (raw.startsWith('null', i)) { i += 4; return true; }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (num && num[0]) { i += num[0].length; return true; }
    return false;
  }

  function parseObject() {
    depth++;
    skipWs();
    if (raw[i] === '}') { i++; depth--; return true; }
    for (;;) {
      skipWs();
      if (i >= n || raw[i] !== '"') { depth--; return false; } // clave debe ser string
      if (!parseString()) { depth--; return false; }
      skipWs();
      if (raw[i] !== ':') { depth--; return false; }
      i++;
      if (!expectValue()) { depth--; return false; }
      skipWs();
      if (raw[i] === ',') { i++; continue; }
      if (raw[i] === '}') { i++; depth--; return true; }
      depth--;
      return false;
    }
  }

  function parseArray() {
    depth++;
    skipWs();
    if (raw[i] === ']') { i++; depth--; return true; }
    for (;;) {
      if (!expectValue()) { depth--; return false; }
      skipWs();
      if (raw[i] === ',') { i++; skipWs(); if (raw[i] === ']') { depth--; return false; } continue; }
      if (raw[i] === ']') { i++; depth--; return true; }
      depth--;
      return false;
    }
  }

  skipWs();
  if (i >= n) return -1;
  if (!expectValue()) return i < n ? i : Math.max(0, n - 1);
  skipWs();
  if (i < n) return i; // contenido sobrante tras el valor raíz
  return -1;
}

/**
 * Convierte la posición cruda de un SyntaxError de JSON.parse a línea/columna.
 * Estrategias en orden:
 *   1. Node ≥20 incluye "at line X column Y" en el mensaje.
 *   2. Fallback determinista: escáner JSON propio que localiza el primer
 *      carácter problemático (Node 18/Electron 28 trunca el mensaje sin
 *      posición).
 * @param {string} raw
 * @param {unknown} err
 * @returns {{ line: number, column: number }}
 */
function _lineColFromParseError(raw, err) {
  const msg = String((err && err.message) || err);
  const detailed = msg.match(/at line (\d+) column (\d+)/i);
  if (detailed) return { line: Number(detailed[1]), column: Number(detailed[2]) };
  const posMatch = msg.match(/position (\d+)/i);
  if (posMatch) {
    const pos = Number(posMatch[1]);
    const before = raw.slice(0, Math.min(pos, raw.length));
    const line = before.split('\n').length;
    const lastNl = before.lastIndexOf('\n');
    return { line, column: pos - lastNl };
  }
  const idx = _scanJsonFirstError(raw);
  if (idx >= 0) {
    const before = raw.slice(0, idx);
    const line = before.split('\n').length;
    const lastNl = before.lastIndexOf('\n');
    return { line, column: idx - lastNl };
  }
  return { line: 0, column: 0 };
}

/** ¿Hay ALGUNA API key configurada (config o llavero)? */
function _hasAnyApiKey(parsed, keychainHasKeys) {
  if (keychainHasKeys) return true;
  const llm = parsed && typeof parsed === 'object' ? parsed.llm : null;
  if (!llm || typeof llm !== 'object') return false;
  if (llm.apiKeys && typeof llm.apiKeys === 'object') {
    for (const v of Object.values(llm.apiKeys)) {
      if (typeof v === 'string' && v.trim()) return true;
    }
  }
  if (llm.providers && typeof llm.providers === 'object') {
    for (const p of Object.values(llm.providers)) {
      if (p && typeof p === 'object' && typeof p.apiKey === 'string' && p.apiKey.trim()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.configPath       Ruta absoluta del config.json del usuario.
 * @param {string|null} [opts.examplePath] Ruta del ejemplo a sugerir copiar.
 * @param {boolean} [opts.keychainHasKeys] true si el llavero del SO tiene keys.
 * @returns {{ ok: boolean, issues: Array<{ type: 'missing'|'invalid_json'|'no_keys', message: string }> }}
 */
function validateStartupConfig({ configPath, examplePath = null, keychainHasKeys = false } = {}) {
  /** @type {Array<{ type: string, message: string }>} */
  const issues = [];

  // ── Caso 1: no existe ──
  if (!configPath || !fs.existsSync(configPath)) {
    issues.push({
      type: 'missing',
      message:
        '**Configuración no encontrada.** No existe `config.json` en ' +
        `\`${configPath || '(ruta sin resolver)'}\`. ` +
        (examplePath
          ? `Copiá el ejemplo:\n\n\`\`\`bash\ncp ${examplePath} ${configPath}\n\`\`\`\ny luego editá tus datos. `
          : '') +
        'Después de configurar tu API key, reiniciá la app.',
    });
    return { ok: false, issues };
  }

  // ── Caso 2: JSON inválido (con línea/columna) ──
  let raw = '';
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (e) {
    issues.push({
      type: 'invalid_json',
      message: `**config.json no se pudo leer:** ${e instanceof Error ? e.message : String(e)}`,
    });
    return { ok: false, issues };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const { line, column } = _lineColFromParseError(raw, err);
    const reason = String((err && err.message) || err).replace(/\s*\n\s*/g, ' ').slice(0, 140);
    issues.push({
      type: 'invalid_json',
      message:
        `**config.json es JSON inválido** (línea ${line}, columna ${column}). ` +
        `Motivo: ${reason}\n\nCorregí el archivo y reiniciá la app — ` +
        'hasta entonces Kaoru corre con defaults vacíos.',
    });
    return { ok: false, issues };
  }

  // ── Caso 3: válido pero sin NINGUNA API key ──
  if (!_hasAnyApiKey(parsed, keychainHasKeys)) {
    issues.push({
      type: 'no_keys',
      message:
        '**Sin API key configurada.** Todos los proveedores (incluso los "gratis") necesitan su propia key — ' +
        '**configurala en el selector de modelos** (tocá el modelo en la barra superior o escribí `/model`) ' +
        'antes de enviar tu primer mensaje.',
    });
  }

  return { ok: issues.length === 0, issues };
}

module.exports = { validateStartupConfig, _lineColFromParseError, _hasAnyApiKey };
