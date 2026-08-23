// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// sensor-events.js — conversión de señales de sensores (GitWatcher,
// SystemWatcher, TitleWatcher, ClipboardWatcher, UpcomingEventsWatcher,
// LSPErrorWatcher) en triggers del pipeline proactivo.

const path = require('path');

const LLMProvider = require('../../../llm/LLMProvider.js');
const { _extractPatch, _patchLanguageRule } = require('../helpers.js');

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
  async _generatePatch(trigger) {
    if (!trigger?.absPath) return null;
    const fs = require('fs');
    let content;
    try {
      content = fs.readFileSync(trigger.absPath, 'utf-8');
    } catch (e) {
      return null;
    }

    const firstErr = trigger.errors?.[0] || {};
    const errLine = firstErr.line ?? 0;

    // Contexto: el fragmento del archivo alrededor del error (texto EXACTO),
    // el/los errores y el símbolo (función) donde está.
    const lines = content.split('\n');
    const from = Math.max(0, errLine - 30);
    const to = Math.min(lines.length, errLine + 40);
    const slice = lines.slice(from, to).join('\n');

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
El contenido REAL del archivo (fragmento alrededor del error, delimitado por ---):
---
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
      return { changes };
    } catch (e) {
      logger.warn('sensor-events', '[proactive] error generando parche:', e.message);
      return null;
    }
  },
};
