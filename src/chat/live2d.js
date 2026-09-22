// @ts-nocheck
// Live2D
let _modelResizeFrame = 0;
let _modelResizeObserver = null;
let _avatarPresenceTimer = 0;
let _avatarOverflowTimer = 0;

/**
 * Hace que el avatar invada ligeramente el área del chat sin mover el layout.
 * Las clases solo transforman la capa visual; PIXI conserva su canvas y sus
 * coordenadas internas.
 */
function animateAvatarPresence(mode = 'peek') {
  const container = document.getElementById('model-canvas-container');
  const panel = document.getElementById('model-panel');
  if (!container) return;
  const allowed = new Set(['peek', 'working', 'react', 'celebrate']);
  const next = allowed.has(mode) ? mode : 'peek';
  clearTimeout(_avatarPresenceTimer);
  clearTimeout(_avatarOverflowTimer);
  container.classList.remove('avatar-peek', 'avatar-working', 'avatar-react', 'avatar-celebrate');
  container.classList.remove('avatar-protruding');
  if (panel) panel.classList.remove('avatar-overflow-active');
  // Reinicia la animación aunque el mismo estado ocurra dos veces seguidas.
  void container.offsetWidth;
  container.classList.add(`avatar-${next}`);
  if (panel) panel.classList.add('avatar-overflow-active');
  container.classList.add('avatar-protruding');
  _avatarPresenceTimer = setTimeout(
    () => {
      container.classList.remove(`avatar-${next}`);
      container.classList.remove('avatar-protruding');
      _avatarOverflowTimer = setTimeout(() => {
        if (panel) panel.classList.remove('avatar-overflow-active');
      }, 340);
    },
    next === 'working' ? 1500 : 1050
  );
}
window.animateAvatarPresence = animateAvatarPresence;

async function loadModel() {
  await loadLLMConfig();
  updateLlmHint();
  checkOpenClaw();

  if (!_modelInfo) _modelInfo = await ipcRenderer.invoke('get-model-info').catch(() => null);
  if (!_modelInfo || !_modelInfo.model3Path) {
    console.error('[chat] no hay modelo Live2D configurado — el panel quedará vacío');
    _showModelError('No hay modelo Live2D disponible. Configúralo con /cambio-modelo.');
    return;
  }
  if (!(await assistant.existsSync(_modelInfo.model3Path))) {
    console.error('Modelo no encontrado:', _modelInfo.model3Path);
    _showModelError('Modelo no encontrado: ' + _modelInfo.model3Path);
    return;
  }

  const container = document.getElementById('model-canvas-container');
  const initialWidth = Math.max(1, container.clientWidth);
  const initialHeight = Math.max(1, container.clientHeight);
  const oldCanvas = document.getElementById('live2d-chat-canvas');
  if (oldCanvas) oldCanvas.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'live2d-chat-canvas';
  container.appendChild(canvas);

  pixiApp = new PIXI.Application({
    view: canvas,
    width: initialWidth,
    height: initialHeight,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  const fileUrl = 'file:///' + _modelInfo.model3Path.replace(/\\/g, '/');

  try {
    if (!window.Live2DCubismCore || !PIXI.live2d || !PIXI.live2d.Live2DModel)
      throw new Error('Falta el runtime Live2D Cubism en la instalación');
    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
    // Se inyectan expresiones/motions no referenciadas en el model3.json (ver
    // core/behavior/ModelAugmenter.js) para que el mini-avatar pueda animar.
    const augmented = await ModelAugmenter.augmentModel(_modelInfo.model3Path);
    model = await PIXI.live2d.Live2DModel.from(augmented.settings || fileUrl);
    modelNativeW = model.width;
    modelNativeH = model.height;
    modelBounds = computeContentBounds(model) || {
      x: 0,
      y: 0,
      width: modelNativeW || 1,
      height: modelNativeH || 1,
    };
    pixiApp.stage.addChild(model);

    const engine = await initGestureEngine();
    engine.attach(model, {
      model3Path: _modelInfo.model3Path,
      gestures: augmented.gestures,
      mappings: (chatGestureConfig || {}).mappings,
    });
    engine.startAmbient();

    _hideModelError();
    ipcRenderer
      .invoke('views-get')
      .then((s) => {
        if (s && s.mode) {
          viewMode = s.mode;
          if (viewMode !== 'random' && VIEW[viewMode]) currentView = viewMode;
          if (model) applyView(currentView, false);
          _refreshViewButtons();
        }
      })
      .catch(() => {});
    applyView('head', false);
    setTimeout(triggerMotion, 600);
    clearInterval(_motionTimer);
    _motionTimer = setInterval(triggerMotion, 8000);
    _observeModelContainer(container);
  } catch (e) {
    console.error('model error:', e);
    _showModelError('No se pudo cargar el modelo Live2D: ' + ((e && e.message) || e));
  }
}

function _showModelError(msg) {
  const el = document.getElementById('model-load-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
}

function _hideModelError() {
  const el = document.getElementById('model-load-error');
  if (el) el.classList.remove('visible');
}

async function reloadModel() {
  if (chatGestureEngine) chatGestureEngine.detach();
  if (pixiApp) {
    try {
      pixiApp.destroy(false, { children: true, texture: true, baseTexture: true });
    } catch (e) {
      console.error('error limpiando modelo:', e);
    }
    pixiApp = null;
    model = null;
  }
  await loadModel();
}

function applyView(view) {
  if (!model || !pixiApp) {
    currentView = view;
    return;
  }
  if (!VIEW[view]) return;
  const cfg = VIEW[view];
  const W = pixiApp.screen.width,
    H = pixiApp.screen.height;
  const B = modelBounds || { x: 0, y: 0, width: modelNativeW || 1, height: modelNativeH || 1 };
  const cw = modelNativeW || B.width;
  const ch = modelNativeH || B.height;
  if (![W, H, B.width, B.height, cw, ch].every((n) => Number.isFinite(n) && n > 0)) return;
  const ts = cfg.crop ? H / cfg.f / B.height : Math.min((W * cfg.tw) / B.width, H / B.height);
  if (!Number.isFinite(ts) || ts <= 0) return;
  const S = ts * B.height;
  const cx = (cfg.crop && B.headCx != null ? B.headCx : B.x + B.width / 2) / cw;
  const ay = B.y / ch;
  const tx = W / 2,
    ty = H - S * cfg.f;
  model.scale.set(ts);
  model.anchor.set(cx, ay);
  model.position.set(tx, ty);
  currentView = view;
}

function triggerMotion() {
  try {
    const defs = model?.internalModel?.motionManager?.definitions;
    if (!defs || !Array.isArray(defs.Idle) || !defs.Idle.length) return;
    model.motion('Idle', Math.floor(Math.random() * defs.Idle.length));
    if (Math.random() < 0.35) animateAvatarPresence('peek');
  } catch (_) {}
}

function _resizeModelToContainer(container) {
  if (!pixiApp || !model || !container) return;
  const width = Math.round(container.clientWidth);
  const height = Math.round(container.clientHeight);
  // Al minimizar u ocultar un panel Chromium informa 0x0. Redimensionar PIXI
  // con ese valor destruye la proyección útil y el modelo vuelve recortado.
  if (width < 2 || height < 2) return;
  if (Math.round(pixiApp.screen.width) === width && Math.round(pixiApp.screen.height) === height) {
    return;
  }
  pixiApp.renderer.resize(width, height);
  applyView(currentView, false);
}

function _scheduleModelResize(container) {
  if (_modelResizeFrame) cancelAnimationFrame(_modelResizeFrame);
  _modelResizeFrame = requestAnimationFrame(() => {
    _modelResizeFrame = 0;
    _resizeModelToContainer(container);
  });
}

function _observeModelContainer(container) {
  if (_modelResizeObserver) _modelResizeObserver.disconnect();
  if (typeof ResizeObserver === 'function') {
    _modelResizeObserver = new ResizeObserver(() => _scheduleModelResize(container));
    _modelResizeObserver.observe(container);
  }
}

window.addEventListener(
  'resize',
  () => _scheduleModelResize(document.getElementById('model-canvas-container')),
  { passive: true }
);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) _scheduleModelResize(document.getElementById('model-canvas-container'));
});
