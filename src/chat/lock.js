// @ts-nocheck
// Bloqueo con PIN (§11.1): al cargar (o al volver a la ventana) consulta
// pin-status; si la app está bloqueada muestra un overlay que tapa todo hasta
// validar el PIN vía IPC (el hash vive en el llavero, verificado en main).

const lockOverlay = document.getElementById('app-lock');
const lockInput = document.getElementById('app-lock-input');
const lockStatus = document.getElementById('app-lock-status');
let _lockShown = false;

function showLock() {
  if (_lockShown) return;
  _lockShown = true;
  lockOverlay.classList.add('visible');
  lockStatus.textContent = '';
  lockInput.value = '';
  lockInput.focus();
}

function hideLock() {
  _lockShown = false;
  lockOverlay.classList.remove('visible');
}

async function _checkLock() {
  try {
    const st = await window.assistant.invoke('pin-status');
    if (st && st.set && st.locked) {
      showLock();
    } else {
      hideLock();
    }
  } catch (_) {
    // sin acceso al estado: no bloquear por un fallo de IPC
    hideLock();
  }
}

async function _submitPin() {
  const pin = lockInput.value;
  if (!pin) return;
  lockStatus.textContent = '';
  try {
    const res = await window.assistant.invoke('pin-check', pin);
    if (res && res.ok) {
      hideLock();
      lockInput.value = '';
      return;
    }
    lockStatus.textContent = (res && res.error) || 'PIN incorrecto.';
    lockStatus.style.color = '#ef4444';
    lockInput.select();
  } catch (e) {
    lockStatus.textContent = (e && e.message) || 'Error al validar el PIN.';
    lockStatus.style.color = '#ef4444';
  }
}

async function _onFocus() {
  if (!document.hidden) await _checkLock();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('app-lock-btn').addEventListener('click', _submitPin);
    lockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _submitPin();
    });
    document.addEventListener('visibilitychange', _onFocus);
    window.addEventListener('focus', _onFocus);
    _checkLock();
  });
} else {
  document.getElementById('app-lock-btn').addEventListener('click', _submitPin);
  lockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _submitPin();
  });
  document.addEventListener('visibilitychange', _onFocus);
  window.addEventListener('focus', _onFocus);
  _checkLock();
}
