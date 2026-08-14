// @ts-nocheck
// Live2D
const viewIndicator = document.getElementById('view-indicator');

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
  const oldCanvas = document.getElementById('live2d-chat-canvas');
  if (oldCanvas) oldCanvas.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'live2d-chat-canvas';
  container.appendChild(canvas);

  pixiApp = new PIXI.Application({
    view: canvas,
    width: container.clientWidth,
    height: container.clientHeight,
    backgroundAlpha: 0,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);
  const fileUrl = 'file:///' + _modelInfo.model3Path.replace(/\\/g, '/');

  try {
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
    startAutonomousView();
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

function applyView(view, animate = false) {
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
  const ts = cfg.crop ? H / cfg.f / B.height : Math.min((W * cfg.tw) / B.width, H / B.height);
  const S = ts * B.height;
  const cx = (cfg.crop && B.headCx != null ? B.headCx : B.x + B.width / 2) / cw;
  const ay = B.y / ch;
  const tx = W / 2,
    ty = H - S * cfg.f;
  viewIndicator.textContent = view.toUpperCase();
  viewIndicator.style.opacity = '.5';
  setTimeout(() => {
    viewIndicator.style.opacity = '0';
  }, 2000);
  if (!animate) {
    model.scale.set(ts);
    model.anchor.set(cx, ay);
    model.position.set(tx, ty);
    currentView = view;
    return;
  }
  const dur = 700,
    start = performance.now();
  const fs2 = model.scale.x,
    fx = model.x,
    fy = model.y;
  const fax = model.anchor.x,
    fay = model.anchor.y;
  const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
  const tick = (n) => {
    const t = Math.min((n - start) / dur, 1),
      e = ease(t);
    model.scale.set(fs2 + (ts - fs2) * e);
    model.anchor.set(fax + (cx - fax) * e, fay + (ay - fay) * e);
    model.position.set(fx + (tx - fx) * e, fy + (ty - fy) * e);
    if (t < 1) requestAnimationFrame(tick);
    else {
      currentView = view;
      triggerMotion();
    }
  };
  requestAnimationFrame(tick);
}

function triggerMotion() {
  try {
    const defs = model?.internalModel?.motionManager?.definitions;
    if (!defs || !Array.isArray(defs.Idle) || !defs.Idle.length) return;
    model.motion('Idle', Math.floor(Math.random() * defs.Idle.length));
  } catch (_) {}
}

function pickNextView() {
  const names = Object.keys(VIEW);
  const total = names.reduce((s, v) => s + VIEW_PERSONALITY.weights[v], 0);
  let r = Math.random() * total;
  for (const v of names) {
    r -= VIEW_PERSONALITY.weights[v];
    if (r <= 0) return v;
  }
  return names[names.length - 1];
}
function startAutonomousView() {
  if (viewMode !== 'random') return;
  const schedule = () => {
    const d = VIEW_PERSONALITY.duration[currentView];
    const wait = (d.min + Math.random() * (d.max - d.min)) * 1000;
    setTimeout(() => {
      if (viewMode !== 'random') {
        schedule();
        return;
      }
      const next = pickNextView();
      if (next && model && next !== currentView) applyView(next, true);
      schedule();
    }, wait);
  };
  setTimeout(schedule, 12000 + Math.random() * 8000);
}

window.addEventListener('resize', () => {
  if (!pixiApp || !model) return;
  const container = document.getElementById('model-canvas-container');
  pixiApp.renderer.resize(container.clientWidth, container.clientHeight);
  applyView(currentView, false);
});
