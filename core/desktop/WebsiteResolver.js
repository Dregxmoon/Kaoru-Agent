// @ts-check
'use strict';

/**
 * WebsiteResolver.js — resolución universal de destinos web en runtime.
 *
 * Nada hardcodeado: cualquier destino ("amazon", "la web de Renfe", una URL
 * completa o un alias común) se resuelve con la misma tubería:
 *   URL https → alias conocido (atajo) → búsqueda real + scoring + UrlGuard.
 *
 * Los alias son un ATAJO (evitan una búsqueda para destinos muy comunes), no
 * una lista blanca. El fallback de búsqueda usa el navegador propio (managed)
 * y elige por relevancia (cobertura de términos en host+título), no por "el
 * primero que pase el candado". Todo resultado pasa por UrlGuard antes de
 * abrirse. Los resultados de búsqueda se cachean con TTL corto.
 *
 * Lo usan `DesktopControl.openWebsite` y `OpenClawBridge` (mismo contrato en
 * ambas capas, ver P0 del plan de autonomía).
 */

const { isUrlSafe } = require('../security/UrlGuard.js');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const MAX_TARGET_LENGTH = 2048;
const MAX_SEARCH_RESULTS = 5;

/** @param {unknown} value */
function _normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** @param {unknown} value @returns {string[]} */
function _terms(value) {
  return _normalize(value).match(/[a-z0-9]+/g) || [];
}

/** @typedef {(input: {query: string, max_results?: number}) => Promise<unknown>} WebSearchFn */
/** @typedef {(url: string, opts?: {timeout?: number}) => Promise<unknown>} ResolverGuardFn */
/** @typedef {() => number} NowFn */
/** @typedef {{aliases?: Record<string, string>, webSearch?: WebSearchFn|null, urlGuard?: ResolverGuardFn|null, now?: NowFn, cacheTtlMs?: number, localeHints?: string[]}} ResolverOptions */
/** @typedef {{title?: unknown, url?: unknown}} SearchCandidate */
/** @typedef {{url: string, resolvedBy: string, query?: string, score?: number, cached?: boolean}} ResolvedTarget */

class WebsiteResolver {
  /** @param {ResolverOptions} [options] */
  constructor(options = {}) {
    this._aliases = options.aliases || {};
    this._webSearch = options.webSearch || null;
    this._urlGuard = options.urlGuard || isUrlSafe;
    this._now = options.now || Date.now;
    this._cacheTtlMs = options.cacheTtlMs || CACHE_TTL_MS;
    /** @type {string[]} sufijos de TLD preferidos del usuario (p.ej. ['mx','es']) */
    this._localeHints = Array.isArray(options.localeHints)
      ? options.localeHints.map((h) => String(h).toLowerCase())
      : [];
    /** @type {Map<string, {at: number, value: {url: string, resolvedBy: string, query?: string, score?: number}}>} */
    this._cache = new Map();
  }

  /**
   * Actualiza las preferencias de TLD en caliente (p.ej. desde el idioma del
   * usuario). Limpia la caché: lo resuelto con otro locale puede no aplicar.
   * @param {string[]} [hints]
   */
  setLocaleHints(hints) {
    const next = Array.isArray(hints) ? hints.map((h) => String(h).toLowerCase()) : [];
    if (JSON.stringify(next) === JSON.stringify(this._localeHints)) return;
    this._localeHints = next;
    this._cache.clear();
  }

  /** @param {string} rawTarget */
  async resolve(rawTarget) {
    const trimmed = String(rawTarget || '').trim();
    if (!trimmed || trimmed.length > MAX_TARGET_LENGTH) {
      throw new Error('Sitio o URL inválido');
    }

    const aliasUrl = this._aliases[_normalize(trimmed)];
    const candidate = aliasUrl || trimmed;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
        return { url: parsed.href, resolvedBy: aliasUrl ? 'alias' : 'url' };
      }
    } catch (_) {
      // No era URL directa — sigue el fallback de búsqueda.
    }

    const cacheKey = `target:${_normalize(trimmed)}`;
    const cached = this._cache.get(cacheKey);
    if (cached && this._now() - cached.at < this._cacheTtlMs) {
      try {
        const safety = /** @type {{safe?: unknown}} */ (
          await this._urlGuard(cached.value.url, { timeout: 3000 })
        );
        if (safety.safe === true) return { ...cached.value, cached: true };
      } catch (_) {
        // Fall through to a fresh search; stale DNS must not bypass the guard.
      }
      this._cache.delete(cacheKey);
    }

    if (!this._webSearch) {
      throw new Error(`Usa un sitio conocido o una URL https completa para "${trimmed}"`);
    }

    /** @type {SearchCandidate[]} */
    let searchResults = [];
    try {
      const outcome = /** @type {{result?: unknown}} */ (
        await this._webSearch({ query: trimmed, max_results: MAX_SEARCH_RESULTS })
      );
      searchResults = Array.isArray(outcome.result)
        ? /** @type {SearchCandidate[]} */ (outcome.result)
        : [];
    } catch (searchError) {
      throw new Error(
        `No se pudo resolver "${trimmed}": ni es una URL https, ni un sitio conocido, y la ` +
          `búsqueda falló (${searchError instanceof Error ? searchError.message : String(searchError)})`
      );
    }

    const ranked = this._rankCandidates(trimmed, searchResults);
    for (const item of ranked) {
      try {
        const safety = /** @type {{safe?: unknown}} */ (
          await this._urlGuard(item.url, { timeout: 3000 })
        );
        if (safety.safe !== true) continue;
      } catch (_) {
        continue;
      }
      const value = { url: item.url, resolvedBy: 'search', query: trimmed, score: item.score };
      this._store(cacheKey, value);
      return value;
    }

    // Clarificación kawaii y funcional: si hubo candidatos https pero ninguno
    // pasó el candado (o no hubo cobertura), se devuelven los mejores hosts
    // como datos para que el agente pregunte UNA cosa concreta en el idioma
    // del usuario en vez de adivinar o rendirse en seco.
    const seenHosts = ranked
      .slice(0, 3)
      .map((item) => {
        try {
          return new URL(item.url).hostname;
        } catch (_) {
          return '';
        }
      })
      .filter(Boolean);
    throw new Error(
      `No encontré un destino seguro para "${trimmed}".` +
        (seenHosts.length ? ` Vi estas opciones: ${[...new Set(seenHosts)].join(', ')}.` : '') +
        ` ¿Cuál querías? (o dame la URL https completa)`
    );
  }

  /**
   * Ordena candidatos por relevancia: cobertura de términos de la consulta en
   * host+título, bonus por coincidencia exacta, preferencia por hosts que
   * contienen todos los términos y bonus de locale (TLD del usuario, p.ej. la
   * tienda de su país). Determinista (desempate por orden).
   * @param {string} query
   * @param {Array<{title?: unknown, url?: unknown}>} candidates
   */
  _rankCandidates(query, candidates) {
    const queryTerms = [...new Set(_terms(query))];
    const normalizedQuery = queryTerms.join(' ');
    /** @type {Array<{url: string, score: number, index: number}>} */
    const scored = [];
    (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
      const rawUrl = candidate && typeof candidate.url === 'string' ? candidate.url : '';
      if (!rawUrl) return;
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (_) {
        return;
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return;
      const hostTerms = _terms(parsed.hostname);
      const titleTerms = _terms(candidate.title);
      const haystack = new Set([...hostTerms, ...titleTerms]);
      const coverage = queryTerms.filter((term) => haystack.has(term)).length;
      const hostHasAll =
        queryTerms.length > 0 && queryTerms.every((term) => hostTerms.includes(term));
      const exactBonus =
        normalizedQuery && _normalize(candidate.title).includes(normalizedQuery)
          ? queryTerms.length + 2
          : 0;
      const hostTld = String(parsed.hostname.split('.').pop() || '').toLowerCase();
      const localeBonus = this._localeHints.includes(hostTld) ? 4 : 0;
      scored.push({
        url: parsed.href,
        score: coverage * 10 + (hostHasAll ? 5 : 0) + exactBonus + localeBonus - index * 0.01,
        index,
      });
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored;
  }

  /** @param {string} key @param {ResolvedTarget} value */
  _store(key, value) {
    this._cache.set(key, { at: this._now(), value });
    while (this._cache.size > CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      if (typeof oldest === 'string') this._cache.delete(oldest);
      else break;
    }
  }

  clearCache() {
    this._cache.clear();
  }
}

module.exports = { WebsiteResolver, CACHE_TTL_MS };
