'use strict';

// GestureEngine — orquesta la reproducción de gestos sobre una instancia
// Live2D ya cargada (overlay o mini-avatar del chat). Une ModelAugmenter
// (qué gestos tiene el modelo) + GestureHeuristic (qué gesto para un mood)
// con el ciclo de vida de reproducción:
//
//   normalize → resolve → apply (model.expression / model.motion) → revert
//
// Prioridades (MotionPriority del SDK): auto → NORMAL(2), force → FORCE(3).
// Cooldowns: mismo mood dentro de `cooldownMs` → se ignora; cualquier gesto
// dentro de `minIntervalMs` → se ignora (ambos se saltan con force).

const ModelAugmenter  = require('./ModelAugmenter.js');
const GestureHeuristic = require('./GestureHeuristic.js');
const Lexicon          = require('./GestureLexicon.js');

const DEFAULTS = {
  enabled: true,
  cooldownMs: 15000,
  minIntervalMs: 2500,
  durationMs: 6000,
  ambient: false,
  ambientIntervalMs: 60000,
  forcedMoodFallback: 'default',
  mappings: {},
};

class GestureEngine {
  constructor(options = {}) {
    this._config = { ...DEFAULTS, ...(options.config || {}) };
    this._model = null;
    this._model3Path = null;
    this._gestures = { modelName: '', expressions: [], motions: [] };
    this._mappings = this._config.mappings || {};
    this._lastPlayAt = 0;
    this._lastMood = null;
    this._lastMoodAt = 0;
    this._revertTimer = null;
    this._ambientTimer = null;
    this._onPlay = typeof options.onPlay === 'function' ? options.onPlay : null;
    this._enabled = this._config.enabled !== false;
    this._stats = { plays: 0, byMood: {}, skipped: {}, errors: 0 };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (!this._enabled) { this.stopAmbient(); this.flush(); }
  }

  get gestures() { return this._gestures; }

  attach(model, { model3Path, gestures, mappings } = {}) {
    this._model = model || null;
    if (model3Path) this._model3Path = model3Path;
    if (gestures) this._gestures = gestures;
    else if (model3Path) this._gestures = ModelAugmenter.listGestures(model3Path);
    if (mappings) this._mappings = mappings;
    return this;
  }

  detach() {
    this.flush();
    this.stopAmbient();
    this._model = null;
    return this;
  }

  async play(mood, { priority = 'auto', duration } = {}, _forcedFallback = false) {
    if (!this._enabled) return { ok: false, reason: 'disabled' };
    if (!this._model) return { ok: false, reason: 'sin modelo' };

    const m = Lexicon.normalizeToken(mood);
    if (!m) return { ok: false, reason: 'mood vacío' };

    const now = Date.now();
    const forced = priority === 'force' || priority === 'forced';
    if (!forced) {
      if (now - this._lastPlayAt < this._config.minIntervalMs) {
        this._skip('min-interval');
        return { ok: false, reason: 'min-interval' };
      }
      if (m === this._lastMood && now - this._lastMoodAt < this._config.cooldownMs) {
        this._skip('cooldown');
        return { ok: false, reason: 'cooldown' };
      }
    }

    const resolved = GestureHeuristic.resolveMood(m, this._gestures, { mappings: this._mappings });
    if (!resolved.ok || !resolved.gesture) {
      if (forced && !_forcedFallback && this._config.forcedMoodFallback && Lexicon.hasMood(this._config.forcedMoodFallback)) {
        return this.play(this._config.forcedMoodFallback, { priority: 'force' }, true);
      }
      this._skip('sin-coincidencia');
      return resolved;
    }

    const applied = await this._applyGesture(resolved.gesture, forced ? 3 : 2, duration);
    if (!applied) {
      this._stats.errors++;
      return { ok: false, reason: 'sdk-rechazo', gesture: resolved.gesture.name };
    }

    this._lastPlayAt = now;
    this._lastMood = m;
    this._lastMoodAt = now;
    this._stats.plays++;
    this._stats.byMood[m] = (this._stats.byMood[m] || 0) + 1;
    if (this._onPlay) {
      try {
        this._onPlay({ mood: m, gesture: resolved.gesture, source: resolved.source, forced });
      } catch {}
    }
    return { ok: true, gesture: resolved.gesture, source: resolved.source };
  }

  async setEmotion(mood) {
    return this.play(mood, { priority: 'auto' });
  }

  async _applyGesture(gesture, priority, duration) {
    const model = this._model;
    const isMotion = gesture.kind === 'motion' || gesture.type === 'motion';

    if (isMotion) {
      if (typeof model.motion !== 'function') return false;
      try {
        await model.motion(gesture.group, gesture.index, priority);
      } catch (e) {
        return false;
      }
      this._scheduleRevert(gesture, duration);
      return true;
    }

    if (typeof model.expression !== 'function') return false;
    try {
      await model.expression(gesture.name);
    } catch (e) {
      return false;
    }
    this._scheduleRevert(gesture, duration);
    return true;
  }

  _scheduleRevert(gesture, duration) {
    if (this._revertTimer) { clearTimeout(this._revertTimer); this._revertTimer = null; }
    const isMotion = !!(gesture && (gesture.kind === 'motion' || gesture.type === 'motion'));
    const dur = typeof duration === 'number'
      ? duration
      : (typeof this._config.durationMs === 'number' ? this._config.durationMs : DEFAULTS.durationMs);
    this._revertTimer = setTimeout(() => {
      this._revertTimer = null;
      this._resetPose(isMotion);
    }, dur);
  }

  // Volver a la pose neutra ya mismo. Algunos motion3 traen "Loop":true (p. ej.
  // zhaoxiang/zhaiyan de March 7th) y nunca terminan; si no hay grupo "Idle" el
  // SDK no restaura la pose, así que el gesto quedaría activo para siempre. Se
  // corta la motion en curso, se revierte la expresión y se restauran TODOS los
  // parámetros a su valor por defecto del moc3 (la pose de carga del modelo).
  _resetPose(wasMotion = true) {
    const model = this._model;
    if (!model || !model.internalModel) return;
    const im = model.internalModel;
    const mm = im.motionManager;
    if (mm) {
      if (wasMotion && typeof mm.stopAllMotions === 'function') {
        try { mm.stopAllMotions(); } catch {}
      }
      if (mm.expressionManager && typeof mm.expressionManager.resetExpression === 'function') {
        try { mm.expressionManager.resetExpression(); } catch {}
      }
    }
    // La API de parámetros vive en im.coreModel (wrapper del Live2DCubismCore),
    // no en im: getParameterCount/getParameterDefaultValue/setParameterValueByIndex.
    // Restaurar todos a su default del moc3 devuelve la pose neutra de carga.
    const cm = im.coreModel;
    if (!cm || typeof cm.getParameterCount !== 'function' ||
        typeof cm.setParameterValueByIndex !== 'function' ||
        typeof cm.getParameterDefaultValue !== 'function') return;
    try {
      const n = cm.getParameterCount();
      for (let i = 0; i < n; i++) {
        cm.setParameterValueByIndex(i, cm.getParameterDefaultValue(i), 1);
      }
    } catch {}
  }

  // Revertir a neutro ya mismo (p. ej. al cambiar de modelo).
  flush() {
    if (this._revertTimer) { clearTimeout(this._revertTimer); this._revertTimer = null; }
    this._resetPose(true);
  }

  // Mapeo declarativo de eventos del flujo del asistente → moods.
  onEvent(type, payload = {}) {
    const map = {
      'initiative': 'excited',
      'plan:started': 'think',
      'plan:finished': 'happy',
      'proposal-result': payload.ok ? 'happy' : 'sad',
      'command_ok': 'happy',
      'command_error': 'sad',
      'agent-progress': payload.status === 'ok' ? 'excited' : 'think',
      'workspace:changed': 'think',
      'openclaw:available': payload && payload.available === false ? 'sad' : 'default',
    };
    const mood = map[type];
    if (mood) this.setEmotion(mood);
  }

  // Análisis de emociones en mensajes del usuario (pasa el detector del renderer).
  onChat(role, text, analyzer) {
    if (role !== 'user' || !text || typeof analyzer !== 'function') return;
    let mood;
    try { mood = analyzer(text); } catch {}
    if (mood) this.setEmotion(mood);
  }

  startAmbient() {
    this.stopAmbient();
    if (!this._config.ambient) return;
    const interval = this._config.ambientIntervalMs || DEFAULTS.ambientIntervalMs;
    this._ambientTimer = setInterval(() => {
      if (!this._enabled || !this._model) return;
      const moods = ['happy', 'think', 'surprised', 'tired', 'default'];
      this.setEmotion(moods[Math.floor(Math.random() * moods.length)]);
    }, interval);
  }

  stopAmbient() {
    if (this._ambientTimer) { clearInterval(this._ambientTimer); this._ambientTimer = null; }
  }

  getStats() { return this._stats; }

  _skip(reason) {
    this._stats.skipped[reason] = (this._stats.skipped[reason] || 0) + 1;
  }
}

module.exports = GestureEngine;
