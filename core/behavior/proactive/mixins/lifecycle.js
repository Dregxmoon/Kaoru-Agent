// @ts-nocheck
const logger = require('../../../observability/Logger.js');
// lifecycle.js — ciclo de vida del ProactiveEngine: arranque/parada,
// setters públicos y registro de listeners del bus.

const { EVAL_INTERVAL_MS, AUTONOMY_MODES, DEFAULT_AUTONOMY_MODE } = require('../config.js');

module.exports = {
  setOSSensor(osSensor) {
    this._osSensor = osSensor;
  },

  setChatOpen(open) {
    this._chatOpen = open;
  },

  setAutonomyMode(mode) {
    this._autonomyMode = AUTONOMY_MODES.includes(mode) ? mode : DEFAULT_AUTONOMY_MODE;
  },

  getAutonomyMode() {
    return this._autonomyMode;
  },

  onUserMessage() {
    this._lastUserMsg = Date.now();
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
    this._running = false;
    logger.info('lifecycle', '[proactive] detenido');
  },

  // ── Listeners de eventos del OS (análisis en vivo, sin esperar timer) ──────

  _setupListeners() {
    this._boundOnTurnAdded = ({ role }) => {
      if (role === 'user') this._lastUserMsg = Date.now();
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
  },
};
