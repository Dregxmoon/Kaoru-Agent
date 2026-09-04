// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// lifecycle.js — ciclo de vida del ProactiveEngine: arranque/parada,
// setters públicos y registro de listeners del bus.

const {
  EVAL_INTERVAL_MS,
  AUTONOMY_MODES,
  DEFAULT_AUTONOMY_MODE,
  CONVO_ACTIVE_WINDOW_MS,
} = require('../config.js');

module.exports = {
  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  },

  setChatOpen(open) {
    this._chatOpen = open;
    // Fase F: al cerrar el chat el usuario deja de estar "en presencia" del
    // asistente — buen momento para reintentar los diferidos (cola QUEUE) que
    // el gate apartó mientras el chat estaba abierto. Antes solo se drenaban
    // en el heartbeat o al volver de una pausa, así que en sesiones largas con
    // la ventana abierta las señales de sensor expiraban por TTL sin entregarse.
    if (!open && typeof this._replayQueued === 'function') this._replayQueued();
  },

  setAutonomyMode(mode) {
    this._autonomyMode = AUTONOMY_MODES.includes(mode) ? mode : DEFAULT_AUTONOMY_MODE;
  },

  getAutonomyMode() {
    return this._autonomyMode;
  },

  /** Shadow mode: el gate y el audit corren, pero nada se envía (dry-run). */
  setShadowMode(on) {
    this._shadowMode = !!on;
  },

  getShadowMode() {
    return this._shadowMode;
  },

  setContextPreference(context, level) {
    if (!this._store?.setContextPreference) {
      return { ok: false, error: 'store_no_disponible' };
    }
    return this._store.setContextPreference(context, level);
  },

  onUserMessage(content = '') {
    this._recordUserTurn();
    this._graph?.captureActiveLearningAnswer?.({ content });
    this._captureProjectUpdate?.(content);
  },

  // ── Fase 5: registro de turnos del usuario ────────────────────────────────
  // Guarda el timestamp de cada mensaje del usuario en una ventana móvil de
  // 30 min. El gate lo usa para saber si la conversación está ACTIVA (≥ 3
  // turnos) y no interrumpir en mitad de un intercambio real.
  _recordUserTurn() {
    const now = Date.now();
    this._lastUserMsg = now;
    if (!Array.isArray(this._recentUserTurns)) this._recentUserTurns = [];
    this._recentUserTurns.push(now);
    const cutoff = now - CONVO_ACTIVE_WINDOW_MS;
    this._recentUserTurns = this._recentUserTurns.filter((t) => t >= cutoff);
  },

  start() {
    if (this._running) return;
    this._running = true;
    logger.info(
      'lifecycle',
      '[proactive] iniciado (eventos del OS en vivo + heartbeat cada 5 min)'
    );
    setTimeout(() => this._evaluateTimeBased(), 2 * 60 * 1000);
    this._timer = setInterval(() => this._evaluateTimeBased(), EVAL_INTERVAL_MS);
  },

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._bus.off('memory:turn-added', this._boundOnTurnAdded);
    this._bus.off('os:app-changed', this._boundOnAppChanged);
    this._bus.off('os:app-tick', this._boundOnAppTick);
    this._bus.off('os:idle-changed', this._boundOnIdleChanged);
    this._bus.off('behavior:evaluated', this._boundOnBehaviorEval);
    this._bus.off('git:redflag', this._boundOnGitRedflag);
    this._bus.off('system:warning', this._boundOnSystemWarn);
    this._bus.off('os:error-title', this._boundOnErrorTitle);
    this._bus.off('clipboard:copied', this._boundOnClipboard);
    this._bus.off('memory:upcoming-event', this._boundOnUpcoming);
    this._bus.off('lsp:error', this._boundOnLspError);
    this._bus.off('initiative:decision', this._boundOnDecision);
    this._bus.off('workspace:changed', this._boundOnWorkspaceChanged);
    this._running = false;
    logger.info('lifecycle', '[proactive] detenido');
  },

  // ── Listeners de eventos del OS (análisis en vivo, sin esperar timer) ──────

  _setupListeners() {
    this._boundOnTurnAdded = ({ role, content }) => {
      if (role === 'user') this.onUserMessage(content);
    };
    this._boundOnAppChanged = (p) => this._onAppChanged(p);
    this._boundOnAppTick = (p) => this._onAppTick(p);
    this._boundOnIdleChanged = (p) => this._onIdleChanged(p);
    this._boundOnBehaviorEval = (ctx) => {
      this._currentProactiveScore = ctx.proactiveScore ?? 0.5;
    };
    this._boundOnGitRedflag = (p) => this._onGitRedflag(p);
    this._boundOnSystemWarn = (p) => this._onSystemWarning(p);
    this._boundOnErrorTitle = (p) => this._onErrorTitle(p);
    this._boundOnClipboard = (p) => this._onClipboard(p);
    this._boundOnUpcoming = (p) => this._onUpcomingEvent(p);
    this._boundOnLspError = (p) => this._onLspError(p);
    this._boundOnDecision = (d) => this.handleDecision(d);
    this._boundOnWorkspaceChanged = (payload) => {
      this._lastProjectFocusKey = null;
      this._lastProjectFocusWrite = 0;
      this._onProjectWorkspaceChanged?.(payload).catch(() => {});
    };

    this._bus.on('memory:turn-added', this._boundOnTurnAdded);
    this._bus.on('os:app-changed', this._boundOnAppChanged);
    this._bus.on('os:app-tick', this._boundOnAppTick);
    this._bus.on('os:idle-changed', this._boundOnIdleChanged);
    this._bus.on('behavior:evaluated', this._boundOnBehaviorEval);
    this._bus.on('git:redflag', this._boundOnGitRedflag);
    this._bus.on('system:warning', this._boundOnSystemWarn);
    this._bus.on('os:error-title', this._boundOnErrorTitle);
    this._bus.on('clipboard:copied', this._boundOnClipboard);
    this._bus.on('memory:upcoming-event', this._boundOnUpcoming);
    this._bus.on('lsp:error', this._boundOnLspError);
    this._bus.on('initiative:decision', this._boundOnDecision);
    this._bus.on('workspace:changed', this._boundOnWorkspaceChanged);
  },
};
