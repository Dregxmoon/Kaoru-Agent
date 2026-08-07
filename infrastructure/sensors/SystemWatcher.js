// @ts-nocheck
/**
 * SystemWatcher.js — vigila el estado del sistema y emite señales cuando algo
 * supera un umbral de riesgo:
 *
 *   system:warning
 *     - cpu_sustained   → CPU > 92%
 *     - memory          → RAM > 92%
 *     - disk            → disco > 92%
 *     - battery_low     → batería ≤ 15% sin cargar
 *     - battery_critical→ batería ≤ 8% sin cargar
 *
 * Diseño:
 *   - A diferencia de los redflags de git (estáticos), las advertencias de
 *     sistema se re-emiten en CADA poll mientras la condición persista: la
 *     batería baja no es un evento puntual, y si el usuario estaba idle/chat
 *     abierto cuando cruzó el umbral, la siguiente emisión lo alcanza. El
 *     cooldown por tipo del ProactiveEngine (1h) evita que el LLM sea
 *     consultado en exceso.
 *   - El probe es inyectable para tests; el default lee os.cpus/os.totalmem,
 *     fs.statfs y /sys/class/power_supply en Linux.
 *   - Nunca lanza: si un probe falla, se loggea y se reintenta el próximo poll.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const { getEventBus } = require('../../infrastructure/event-bus/EventBus.js');
const { BasePollingWatcher } = require('./BasePollingWatcher.js');

const CPU_WARN = 92;
const MEM_WARN = 92;
const DISK_WARN = 92;
const BATTERY_LOW = 15;
const BATTERY_CRITICAL = 8;
const DEFAULT_POLL_MS = 60 * 1000;

async function _defaultProbe() {
  let disk = 0;
  try {
    const st = await fs.promises.statfs('/');
    if (st.blocks > 0) disk = (1 - st.bfree / st.blocks) * 100;
  } catch (_) {}

  let battery = null;
  if (process.platform === 'linux') {
    try {
      const dirs = fs.readdirSync('/sys/class/power_supply').filter((d) => /^BAT/i.test(d));
      for (const d of dirs) {
        const base = path.join('/sys/class/power_supply', d);
        const level = parseInt(fs.readFileSync(path.join(base, 'capacity'), 'utf-8'), 10);
        const status = fs.readFileSync(path.join(base, 'status'), 'utf-8').trim();
        if (!isNaN(level)) {
          battery = { level, charging: status === 'Charging' };
          break;
        }
      }
    } catch (_) {}
  }

  return {
    cpu: _cpuPercent(),
    mem: _memPercent(),
    disk,
    battery,
  };
}

function _cpuPercent() {
  const cpus = os.cpus();
  let idle = 0,
    total = 0;
  for (const c of cpus) {
    for (const t of Object.keys(c.times)) total += c.times[t];
    idle += c.times.idle;
  }
  return total === 0 ? 0 : (1 - idle / total) * 100;
}

function _memPercent() {
  const total = os.totalmem();
  return total === 0 ? 0 : (1 - os.freemem() / total) * 100;
}

class SystemWatcher extends BasePollingWatcher {
  constructor({ pollMs = DEFAULT_POLL_MS, probe = _defaultProbe, bus = getEventBus() } = {}) {
    super({ pollMs, bus });
    this._probe = probe;
    this._warned = {}; // kind → { active, value }
    this._last = null;
  }

  async _scan() {
    const s = await this._probe();
    this._last = s;
    this._tick(s);
  }

  _tick(s) {
    this._warnWhileActive(
      'cpu_sustained',
      s.cpu > CPU_WARN,
      `La CPU lleva al ${Math.round(s.cpu)}% — algo está comiendo recursos.`
    );
    this._warnWhileActive(
      'memory',
      s.mem > MEM_WARN,
      `La RAM está al ${Math.round(s.mem)}% — la máquina puede empezar a ir lenta.`
    );
    this._warnWhileActive(
      'disk',
      s.disk > DISK_WARN,
      `El disco está al ${Math.round(s.disk)}% — conviene liberar espacio.`
    );

    if (s.battery) {
      this._warnWhileActive(
        'battery_low',
        s.battery.level <= BATTERY_LOW && !s.battery.charging,
        `La batería está al ${Math.round(s.battery.level)}% y no está cargando.`
      );
      this._warnWhileActive(
        'battery_critical',
        s.battery.level <= BATTERY_CRITICAL && !s.battery.charging,
        `Batería crítica: ${Math.round(s.battery.level)}% sin cargar — hay que conectar el cargador.`
      );
    }
  }

  _warnWhileActive(kind, active, message) {
    const prev = this._warned[kind]?.active;
    if (active) {
      if (!prev) this._warned[kind] = { active: true, at: Date.now() };
      // Re-emitir en CADA poll mientras la condición persista: si el usuario
      // estaba idle o con el chat abierto cuando cruzó el umbral, la siguiente
      // emisión lo alcanza al volver. El cooldown por tipo del ProactiveEngine
      // evita que el LLM se consulte en exceso.
      this._bus.emit('system:warning', { kind, message });
    } else if (prev) {
      this._warned[kind] = { active: false, at: Date.now() };
    }
  }

  getStats() {
    return {
      running: this._running,
      last: this._last,
      warned: Object.fromEntries(
        Object.entries(this._warned)
          .filter(([, v]) => v.active)
          .map(([k, v]) => [k, v.at])
      ),
      lastError: this._lastError,
    };
  }
}

module.exports = {
  SystemWatcher,
  CPU_WARN,
  MEM_WARN,
  DISK_WARN,
  BATTERY_LOW,
  BATTERY_CRITICAL,
};
