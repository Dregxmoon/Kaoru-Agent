// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// sensor-events.js — conversión de señales de sensores (GitWatcher,
// SystemWatcher, TitleWatcher, ClipboardWatcher, UpcomingEventsWatcher,
// LSPErrorWatcher) en triggers del pipeline proactivo.

const path = require('path');

const LLMProvider = require('../../../llm/LLMProvider.js');
const { _extractPatch, _patchLanguageRule } = require('../helpers.js');
const { TRIGGER_COOLDOWN_MS, WORK_SIGNAL_TYPES } = require('../config.js');

// P3: cooldown corto para re-disparos de lsp_error (el watcher emite por
// flanco — cada emisión es un error nuevo/distinto).
const LSP_ERROR_RETRIGGER_COOLDOWN_MS =
  TRIGGER_COOLDOWN_MS.lsp_error_retrigger ?? 8 * 60 * 1000;

module.exports = {
  _onGitRedflag({ kind, message, branch, count, file } = {}) {
    if (!message) return;
    this._tryTrigger({
      type: 'git_redflag',
      kind,
      branch,
      count,
      file,
      context: message,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger git_redflag:', e.message)
    );
  },

  _onSystemWarning({ kind, message } = {}) {
    if (!message) return;
    this._tryTrigger({
      type: 'system_warning',
      kind,
      context: message,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger system_warning:', e.message)
    );
  },

  _onErrorTitle({ title, app, category } = {}) {
    if (!title) return;
    this._tryTrigger({
      type: 'error_title',
      app,
      category,
      context: `La ventana activa parece mostrar un error: "${title.slice(0, 120)}".`,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger error_title:', e.message)
    );
  },

  _onClipboard({ kind, snippet } = {}) {
    if (!kind || !snippet) return;
    this._tryTrigger({
      type: 'clipboard_context',
      kind,
      context:
        kind === 'stacktrace'
          ? `El usuario acaba de copiar un stacktrace de error: "${snippet.slice(0, 120)}".`
          : `El usuario acaba de copiar una URL: "${snippet.slice(0, 120)}".`,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger clipboard_context:', e.message)
    );
  },

  _onUpcomingEvent({ content, when } = {}) {
    if (!content) return;
    const timeStr = when
      ? new Date(when).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      : '';
    this._tryTrigger({
      type: 'upcoming_event',
      context: `El usuario pidió que recordaras: "${content}".${timeStr ? ` Es alrededor de las ${timeStr}.` : ''}`,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger upcoming_event:', e.message)
    );
  },

  // ── Fase D: errores del LSP como señal proactiva ──────────────────────────
  // El LSPErrorWatcher emite `lsp:error` con el archivo y los diagnósticos de
  // severidad 1. Aquí se convierte en un trigger del pipeline normal (cooldown,
  // presupuesto, chat reciente, y el LLM con la última palabra).

  _onLspError({ file, absPath, workspace, errors, focused, symbols, languageId, fileType } = {}) {
    if (!file || !Array.isArray(errors) || !errors.length) return;
    const first = errors[0];
    // P6 telemetría: inicio del circuito, una línea con lo esencial.
    logger.info(
      'sensor-events',
      `[lsp-ciclo] detectado: ${errors.length} error(es) en ${file}${focused ? ' (enfocado)' : ''} — primero: "${String(first.message || '').slice(0, 60)}"`
    );
    this._tryTrigger({
      type: 'lsp_error',
      file,
      absPath,
      workspace,
      errors,
      symbols,
      focused,
      languageId,
      fileType,
      // El watcher emite POR FLANCO (dedup por hash): cada re-disparo es un
      // error nuevo/distinto → cooldown corto en vez de los 45 min base.
      cooldownOverrideMs: LSP_ERROR_RETRIGGER_COOLDOWN_MS,
      context: `Hay ${errors.length} error(es) de código en "${file}"${focused ? ' — es el archivo que estás viendo' : ''}. El primero: "${first.message.slice(0, 120)}" (línea ${(first.line ?? 0) + 1}).`,
    }).catch((e) =>
      logger.warn('sensor-events', '[proactive] error en trigger lsp_error:', e.message)
    );
  },

  /**
   * Fase D: pide al LLM un parche de reemplazo exacto para el error. Devuelve
   * `{ changes }` o null si no se pudo generar/parsear. Los `old` deben ser
   * fragmentos EXACTOS del archivo (única ocurrencia); el executor los valida
   * antes de proponer nada.
   */
  // ── P1: quickfixes del LSP como fuente de parche determinista ──────────────
  // pyright/tsserver ya SABEN arreglar ciertos errores (codeActions con edit).
  // Usarlos es exacto, instantáneo y sin riesgo de alucinación; el LLM queda
  // como fallback para errores sin quickfix.

  /**
   * Convierte un WorkspaceEdit del LSP en cambios {old,new} validados contra
   * el contenido ACTUAL del archivo (cada old debe aparecer EXACTAMENTE una
   * vez — mismo contrato que el parche del LLM).
   * @param {string} absPath
   * @param {{ changes?: Record<string, Array<{range: object, newText: string}>> }} edit
   * @returns {Array<{old: string, new: string}>|null}
   */
  _workspaceEditToChanges(absPath, edit) {
    const fs = require('fs');
    const { _fromFileUri } = require('../../../lsp/LSPManager.js');
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return null;
    }
    const lines = content.split('\n');
    const all = [];
    for (const [uri, edits] of Object.entries(edit?.changes || {})) {
      let p;
      try {
        p = _fromFileUri(uri);
      } catch {
        continue;
      }
      if (path.resolve(p) !== path.resolve(absPath)) continue; // solo el archivo del error
      for (const e of edits || []) all.push(e);
    }
    if (!all.length) return null;

    const sliceRange = (s, en) => {
      if (
        typeof s?.line !== 'number' ||
        typeof en?.line !== 'number' ||
        s.line < 0 ||
        en.line >= lines.length ||
        en.line < s.line
      ) {
        return null;
      }
      if (s.line === en.line) return String(lines[s.line]).slice(s.character, en.character);
      const head = String(lines[s.line]).slice(s.character ?? 0);
      const tail = String(lines[en.line]).slice(0, en.character ?? 0);
      const middle = lines.slice(s.line + 1, en.line);
      return [head, ...middle, tail].join('\n');
    };

    // Ordenar ascendente: los offsets son sobre el contenido ORIGINAL.
    const sorted = [...all].sort((a, b) => {
      const pa = a.range?.start || {};
      const pb = b.range?.start || {};
      return pa.line - pb.line || (pa.character ?? 0) - (pb.character ?? 0);
    });

    const changes = [];
    for (const e of sorted) {
      const oldText = sliceRange(e.range?.start, e.range?.end);
      if (oldText == null) return null;
      changes.push({ old: oldText, new: String(e.newText ?? '') });
    }
    // Validar unicidad de cada old (contrato del executor).
    for (const c of changes) {
      if (!c.old.trim()) continue;
      if (content.split(c.old).length - 1 !== 1) return null;
    }
    return changes;
  },

  /**
   * P1: intenta construir el parche desde quickfixes del LSP (isPreferred o
   * kind=quickfix con edit). Devuelve null si no hay ninguno aplicable.
   * @param {object} trigger
   * @returns {Promise<{changes: Array, source: string}|null>}
   */
  async _patchFromQuickFixes(trigger) {
    if (typeof this._getCodeActions !== 'function' || !trigger?.absPath) return null;
    const errors = Array.isArray(trigger.errors) ? trigger.errors.slice(0, 3) : [];
    for (const err of errors) {
      let actions = [];
      try {
        actions =
          (await this._getCodeActions(
            trigger.absPath,
            err.line ?? 0,
            err.character ?? 0,
            { diagnostics: trigger.errors }
          )) || [];
      } catch {
        continue;
      }
      const fix =
        actions.find((a) => a.isPreferred && a.edit?.changes) ||
        actions.find((a) => a.kind === 'quickfix' && a.edit?.changes);
      if (!fix) continue;
      const changes = this._workspaceEditToChanges(trigger.absPath, fix.edit);
      if (changes && changes.length) {
        logger.info(
          'sensor-events',
          `[lsp-ciclo] parche desde QUICKFIX del LSP: "${String(fix.title || '').slice(0, 60)}" (${changes.length} cambio/s)`
        );
        return { changes, source: 'lsp_quickfix', fixTitle: fix.title };
      }
    }
    return null;
  },

  /**
   * P5: contexto multi-error — ventanas alrededor de cada CLUSTER de errores
   * (hasta 3 clusters), no solo alrededor del primero.
   */
  _buildMultiErrorSlices(lines, errors) {
    const sorted = [...errors]
      .map((e) => e.line ?? 0)
      .sort((a, b) => a - b);
    const clusters = [];
    for (const line of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && line - last.end <= 15) last.end = Math.max(last.end, line);
      else clusters.push({ start: line, end: line });
      if (clusters.length >= 3) break;
    }
    return clusters
      .map(({ start, end }) => {
        const from = Math.max(0, start - 12);
        const to = Math.min(lines.length, end + 13);
        return `--- Fragmento líneas ${from + 1}-${to} ---\n${lines.slice(from, to).join('\n')}`;
      })
      .join('\n\n');
  },

  async _generatePatch(trigger) {
    if (!trigger?.absPath) return null;

    // P1: quickfix determinista PRIMERO.
    try {
      const qf = await this._patchFromQuickFixes(trigger);
      if (qf) return qf;
    } catch (e) {
      logger.warn('sensor-events', '[proactive] quickfix falló, cayendo a LLM:', e.message);
    }

    const fs = require('fs');
    let content;
    try {
      content = fs.readFileSync(trigger.absPath, 'utf-8');
    } catch (e) {
      return null;
    }

    const firstErr = trigger.errors?.[0] || {};
    const errLine = firstErr.line ?? 0;

    // P5: contexto multi-error por clusters (fallback a ventana simple).
    const lines = content.split('\n');
    const errs = Array.isArray(trigger.errors) && trigger.errors.length ? trigger.errors : [{ line: errLine }];
    const slice =
      errs.length > 1
        ? this._buildMultiErrorSlices(lines, errs)
        : (() => {
            const from = Math.max(0, errLine - 30);
            const to = Math.min(lines.length, errLine + 40);
            return `--- Fragmento alrededor de la línea ${errLine + 1} ---\n${lines.slice(from, to).join('\n')}`;
          })();

    let symbolsCtx = '';
    if (Array.isArray(trigger.symbols) && trigger.symbols.length) {
      const enclosing =
        [...trigger.symbols].reverse().find((s) => s.line <= errLine) || trigger.symbols[0];
      const near = trigger.symbols
        .filter((s) => Math.abs(s.line - errLine) <= 12)
        .slice(0, 5)
        .map((s) => `${s.kindName} ${s.name} (línea ${s.line + 1})`);
      symbolsCtx = `Símbolos del archivo:\n${near.join('\n') || '(sin símbolos cercanos)'}`;
      if (enclosing)
        symbolsCtx += `\nEl error está dentro de: ${enclosing.kindName} ${enclosing.name}.`;
    }

    const errsCtx = trigger.errors
      .map((e) => `- [línea ${(e.line ?? 0) + 1}] ${e.message}${e.code ? ` (${e.code})` : ''}`)
      .join('\n');

    // Lenguaje del archivo (viene del sensor / extensión): el LLM debe parchear
    // en el idioma REAL del archivo. Sin esto, ante `implicit any` (7006) que
    // llega vía checkJs en un .js, un LLM anota sintaxis TS y rompe el archivo.
    const fileType = trigger.fileType || path.extname(trigger.file || '').toLowerCase();
    const langRule = _patchLanguageRule(fileType);

    const systemPrompt = `Eres un asistente de corrección de código. Generas un PARCHE de reemplazo exacto para eliminar los errores reportados. Reglas:
1. Devuelve SOLO JSON: {"changes":[{"old":"...","new":"..."}]}
2. "old" debe ser un fragmento de texto EXACTO del archivo que se te da (respetando espacios y saltos de línea) y debe aparecer UNA sola vez.
3. "new" es el reemplazo corregido.
4. Mínimo de cambios necesario; no reformatees el archivo.
${langRule}`;

    const userPrompt = `Archivo: ${trigger.file}${trigger.fileType ? ` (${trigger.fileType})` : ''}
El contenido REAL del archivo (fragmentos alrededor de los errores, delimitados por ---):
${slice}
---
Errores a corregir:
${errsCtx}
${symbolsCtx}
Genera el parche JSON.`;

    try {
      // maxTokens alto: los modelos de reasoning (nemotron, qwen) queman el
      // presupuesto del modo fast en <think> y el JSON del parche queda
      // truncado ("We need to output JSON..." sin JSON).
      const response = await LLMProvider.complete(
        [{ role: 'user', content: userPrompt }],
        systemPrompt,
        { maxTokens: 4096, timeoutMs: 45_000 }
      );
      const parsed = _extractPatch(response);
      if (!parsed || !Array.isArray(parsed.changes) || !parsed.changes.length) {
        logger.info(
          'sensor-events',
          `[proactive] parche lsp_error: el LLM no devolvió JSON de cambios utilizable (${String(
            response || ''
          ).slice(0, 80)}…)`
        );
        return null;
      }
      const changes = parsed.changes
        .filter((c) => c && typeof c.old === 'string' && c.old.trim() && typeof c.new === 'string')
        .slice(0, 6);
      if (!changes.length) return null;
      logger.info('sensor-events', '[lsp-ciclo] parche desde LLM (sin quickfix disponible)');
      return { changes, source: 'llm' };
    } catch (e) {
      logger.warn('sensor-events', '[proactive] error generando parche:', e.message);
      return null;
    }
  },
};
