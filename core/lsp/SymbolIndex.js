'use strict';

/**
 * SymbolIndex.js — Fase D: índice de símbolos del workspace.
 *
 * Fuente única: el LSP (textDocument/documentSymbol), no heurísticas de regex.
 * El ProactiveEngine usa este índice para saber EN QUÉ función/clase vive un
 * error antes de proponer un parche, de modo que el LLM recibe contexto de
 * símbolo real (nombre + línea) y no "el error está en algún archivo".
 *
 * Diseño:
 *   - getSymbolsFor(file) → lista aplanada [{ name, kindName, line, detail }]
 *     recorriendo también los símbolos anidados (children) del árbol LSP.
 *   - Cache con TTL por archivo (invalidable): no machacar al server LSP en
 *     cada poll del watcher.
 *   - Nunca lanza en producción: cualquier fallo del LSP devuelve [].
 */

const SYMBOL_KINDS = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
  15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array',
  19: 'Object', 20: 'Key', 21: 'Null', 22: 'EnumMember',
  23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
};

class SymbolIndex {
  constructor({ lsp, cacheTtlMs = 60 * 1000 } = {}) {
    this._lsp          = lsp || null;
    this._cacheTtlMs   = cacheTtlMs;
    this._cache        = new Map(); // absPath → { at, symbols }
    this._stats        = { lookups: 0, hits: 0, errors: 0, indexed: 0 };
  }

  /** Símbolos (aplanados) de un archivo, con cache. */
  async getSymbolsFor(filePath) {
    this._stats.lookups += 1;
    const absPath = require('path').resolve(filePath);
    const cached  = this._cache.get(absPath);
    if (cached && Date.now() - cached.at < this._cacheTtlMs) {
      this._stats.hits += 1;
      return cached.symbols;
    }

    if (!this._lsp || typeof this._lsp.getDocumentSymbols !== 'function') return [];
    let raw;
    try {
      raw = await this._lsp.getDocumentSymbols(absPath);
    } catch(e) {
      this._stats.errors += 1;
      return [];
    }
    if (!Array.isArray(raw) || !raw.length) return [];

    const flat = [];
    const walk = (syms) => {
      for (const s of syms || []) {
        flat.push({
          name:      s.name,
          kindName:  SYMBOL_KINDS[s.kind] || (s.kindName || `Kind_${s.kind}`),
          detail:    s.detail || '',
          line:      s.selectionRange?.start?.line ?? s.range?.start?.line ?? 0,
        });
        if (Array.isArray(s.children) && s.children.length) walk(s.children);
      }
    };
    walk(raw);

    this._cache.set(absPath, { at: Date.now(), symbols: flat });
    this._stats.indexed += flat.length;
    return flat;
  }

  /** Invalida la cache de un archivo (p.ej. tras aplicar un parche). */
  invalidate(filePath) {
    this._cache.delete(require('path').resolve(filePath));
  }

  getStats() {
    return { ...this._stats, cacheSize: this._cache.size };
  }
}

module.exports = { SymbolIndex, SYMBOL_KINDS };
