// @ts-nocheck
'use strict';

// Handlers IPC del sistema de permisos granulares (allow/ask/deny) y del PIN
// de bloqueo local de la app (§11.1). Expone la gestión de reglas al renderer
// del chat (panel de Permisos) y el ciclo de vida del PIN (lock de ventana).

const { ipcMain } = require('electron');
const crypto = require('crypto');

const PIN_KEY = 'app_pin_hash';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

// Sesión desbloqueada: se marca al validar el PIN y expira al pasar el timeout.
// Se guarda en memoria (no en config) — el hash vive en el Keychain.
let unlockedAt = 0;
let pinTimeoutMs = 0;

function _hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function _verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, nStr, saltB64, hashB64] = parts;
  const n = Number(nStr);
  if (!Number.isFinite(n) || n <= 0) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
    N: n,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return crypto.timingSafeEqual(actual, expected);
}

function _isLocked() {
  const stored = _getStoredPin();
  if (!stored) return false; // sin PIN configurado → siempre abierta
  if (unlockedAt === 0) return true; // nunca desbloqueada en esta sesión
  if (pinTimeoutMs <= 0) return false; // timeout ilimitado: se desbloquea 1 vez por sesión
  return Date.now() - unlockedAt > pinTimeoutMs;
}

function _getStoredPin() {
  try {
    const K = require('../infrastructure/keychain/KeychainManager.js');
    const v = K.getKey(PIN_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function register(ctx) {
  const { Core } = ctx;

  ipcMain.handle('permissions-list', () => {
    return Core.permissionsList();
  });

  ipcMain.handle('permissions-set', (e, rule) => {
    return Core.permissionsSetRule(rule || {});
  });

  ipcMain.handle('permissions-remove', (e, rule) => {
    return Core.permissionsRemoveRule(rule || {});
  });

  // ── PIN de bloqueo local (§11.1) ───────────────────────────────────────────
  // El hash vive en el Keychain (nunca en config.json); la sesión desbloqueada
  // y el timeout viven en memoria del main (no cruzan al renderer).

  ipcMain.handle('pin-status', () => {
    const cfg = typeof ctx.loadEffectiveConfig === 'function' ? ctx.loadEffectiveConfig() : {};
    pinTimeoutMs = Number(cfg?.agent?.pinTimeoutMs || 0);
    return { set: !!_getStoredPin(), locked: _isLocked() };
  });

  ipcMain.handle('pin-set', (e, pin) => {
    if (typeof pin !== 'string' || pin.length < 4 || pin.length > 64) {
      return { ok: false, error: 'El PIN debe tener entre 4 y 64 caracteres.' };
    }
    try {
      const K = require('../infrastructure/keychain/KeychainManager.js');
      const ok = K.setKey(PIN_KEY, _hashPin(pin));
      if (!ok) return { ok: false, error: 'No se pudo guardar en el llavero.' };
      unlockedAt = Date.now(); // quien lo setea queda desbloqueado
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('pin-check', (e, pin) => {
    if (typeof pin !== 'string') return { ok: false, error: 'PIN inválido' };
    const stored = _getStoredPin();
    if (!stored) return { ok: false, error: 'No hay PIN configurado.' };
    if (_verifyPin(pin, stored)) {
      unlockedAt = Date.now();
      return { ok: true };
    }
    return { ok: false, error: 'PIN incorrecto.' };
  });

  ipcMain.handle('pin-clear', () => {
    try {
      const K = require('../infrastructure/keychain/KeychainManager.js');
      K.deleteKey(PIN_KEY);
      unlockedAt = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { register };
