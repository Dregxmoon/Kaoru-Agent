// @ts-check
'use strict';

const crypto = require('crypto');
const { LinuxAtSpiAdapter } = require('./adapters/LinuxAtSpiAdapter.js');
const { WindowsUIAutomationAdapter } = require('./adapters/WindowsUIAutomationAdapter.js');

const OBSERVATION_TTL_MS = 60_000;
const MAX_OBSERVATIONS = 12;
const MUTATING_ACTIONS = new Set(['focus', 'click', 'type', 'press', 'select', 'scroll', 'close']);

/** @typedef {{snapshot(input?: Record<string, unknown>): Promise<Record<string, any>>, execute(action: string, target: Record<string, unknown>, input?: Record<string, unknown>): Promise<Record<string, any>>, health(): Promise<Record<string, any>>, platform?: string}} AutomationAdapter */
/** @typedef {{id: string, createdAt: number, application: string, nodes: Array<Record<string, any>>, refs: Map<string, Record<string, any>>}} Observation */

/** @param {unknown} value @param {number} [max] */
function _safeText(value, max = 300) {
  return String(value || '')
    .replace(/\p{Cc}/gu, ' ')
    .trim()
    .slice(0, max);
}

/** @param {unknown} left @param {unknown} right */
function _sameApplication(left, right) {
  return (
    _safeText(left, 120).normalize('NFKC').toLocaleLowerCase() ===
    _safeText(right, 120).normalize('NFKC').toLocaleLowerCase()
  );
}

/** @param {NodeJS.Platform} platform @returns {AutomationAdapter|null} */
function _makeAdapter(platform) {
  if (platform === 'linux') return new LinuxAtSpiAdapter();
  if (platform === 'win32') return new WindowsUIAutomationAdapter();
  return null;
}

class DesktopAutomation {
  /** @param {{platform?: NodeJS.Platform, adapter?: AutomationAdapter|null, now?: () => number, captureSources?: ((options: any) => Promise<any[]>)|null, getDisplays?: (() => any[])|null, toScreenPoint?: ((point: {x:number,y:number}) => {x:number,y:number})|null}} [options] */
  constructor(options = {}) {
    this._platform = options.platform || process.platform;
    this._adapter = options.adapter === undefined ? _makeAdapter(this._platform) : options.adapter;
    this._now = options.now || Date.now;
    this._captureSources = options.captureSources || null;
    this._getDisplays = options.getDisplays || null;
    this._toScreenPoint = options.toScreenPoint || null;
    /** @type {Map<string, {createdAt: number, bounds: {x: number,y: number,width: number,height: number}, imageSize: {width: number,height: number}}>} */
    this._captures = new Map();
    this._latestCaptureId = '';
    /** @type {Map<string, Observation>} */
    this._observations = new Map();
    this._latestObservationId = '';
  }

  async health() {
    if (!this._adapter) {
      return { ok: false, platform: this._platform, error: 'Plataforma no compatible' };
    }
    return this._adapter.health();
  }

  /** @param {{application?: unknown, maxDepth?: unknown, maxNodes?: unknown}} [input] */
  async snapshot(input = {}) {
    if (!this._adapter) throw new Error(`Automatización no compatible con ${this._platform}`);
    const application = _safeText(input.application, 120);
    const maxDepth = Math.min(10, Math.max(1, Number(input.maxDepth) || 6));
    const maxNodes = Math.min(500, Math.max(10, Number(input.maxNodes) || 250));
    const raw = await this._adapter.snapshot({ application, maxDepth, maxNodes });
    if (!raw.ok) throw new Error(_safeText(raw.error, 500) || 'No se pudo observar el escritorio');
    const observationId = crypto.randomUUID();
    /** @type {Map<string, Record<string, any>>} */
    const refs = new Map();
    const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
      .slice(0, maxNodes)
      .map((node, index) => {
        const ref = `ui-${index + 1}`;
        const target = {
          path: _safeText(node.path, 160),
          processId: Number(node.processId) || 0,
          application: _safeText(node.application, 120),
          window: _safeText(node.window, 200),
          automationId: _safeText(node.automationId, 200),
          name: _safeText(node.name, 300),
          role: _safeText(node.role, 80),
        };
        refs.set(ref, target);
        return {
          ref,
          application: target.application || undefined,
          window: target.window || undefined,
          name: target.name,
          role: target.role,
          processId: target.processId || undefined,
          states: Array.isArray(node.states) ? node.states.slice(0, 20).map(_safeText) : undefined,
          enabled: typeof node.enabled === 'boolean' ? node.enabled : undefined,
          focused: typeof node.focused === 'boolean' ? node.focused : undefined,
          bounds: node.bounds || undefined,
          depth: Number(node.depth) || 0,
        };
      });
    /** @type {Observation} */
    const observation = {
      id: observationId,
      createdAt: this._now(),
      application,
      nodes,
      refs,
    };
    this._observations.set(observationId, observation);
    this._latestObservationId = observationId;
    while (this._observations.size > MAX_OBSERVATIONS) {
      const oldest = this._observations.keys().next().value;
      if (typeof oldest === 'string') this._observations.delete(oldest);
      else break;
    }
    return {
      kind: 'desktop_snapshot',
      platform: this._platform,
      backend: raw.backend || (this._platform === 'linux' ? 'at-spi2' : 'windows-ui-automation'),
      observationId,
      createdAt: observation.createdAt,
      truncated: Boolean(raw.truncated),
      nodes,
    };
  }

  /** @param {{application?: unknown}} [input] */
  async listWindows(input = {}) {
    const snapshot = await this.snapshot({
      application: input.application,
      maxDepth: 1,
      maxNodes: 150,
    });
    return {
      ...snapshot,
      kind: 'window_list',
      nodes: snapshot.nodes.filter((node) => node.depth === 0),
    };
  }

  /** @param {{sourceId?: unknown, sourceName?: unknown, width?: unknown, height?: unknown}} [input] */
  async screenshot(input = {}) {
    let captureSources = this._captureSources;
    let getDisplays = this._getDisplays;
    let toScreenPoint = this._toScreenPoint;
    if (!captureSources) {
      const electron = require('electron');
      if (!electron?.desktopCapturer?.getSources) {
        throw new Error('La captura de escritorio requiere el runtime Electron');
      }
      captureSources = electron.desktopCapturer.getSources.bind(electron.desktopCapturer);
      getDisplays = electron.screen?.getAllDisplays?.bind(electron.screen) || null;
      toScreenPoint = electron.screen?.dipToScreenPoint?.bind(electron.screen) || null;
    }
    if (!captureSources) throw new Error('La captura de escritorio no está disponible');
    const width = Math.min(1920, Math.max(320, Number(input.width) || 1280));
    const height = Math.min(1080, Math.max(240, Number(input.height) || 720));
    const sources = await captureSources({
      types: ['window', 'screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false,
    });
    const sourceId = _safeText(input.sourceId, 200);
    const sourceName = _safeText(input.sourceName, 200).toLowerCase();
    const source = sources.find((candidate) => {
      if (sourceId) return candidate.id === sourceId;
      if (sourceName)
        return String(candidate.name || '')
          .toLowerCase()
          .includes(sourceName);
      return String(candidate.id || '').startsWith('screen:');
    });
    if (!source?.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error('No se encontró una pantalla o ventana capturable');
    }
    const image = source.thumbnail.toJPEG(60);
    const imageSize = source.thumbnail.getSize ? source.thumbnail.getSize() : { width, height };
    if (!imageSize.width || !imageSize.height)
      throw new Error('La captura no tiene dimensiones válidas');
    const displays = getDisplays ? getDisplays() : [];
    const display = displays.find(
      (candidate) => String(candidate.id) === String(source.display_id)
    );
    let bounds = display?.bounds || {
      x: 0,
      y: 0,
      width: imageSize.width,
      height: imageSize.height,
    };
    if (toScreenPoint && display?.bounds) {
      const start = toScreenPoint({ x: bounds.x, y: bounds.y });
      const end = toScreenPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      bounds = { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
    }
    const captureId = crypto.randomUUID();
    this._captures.clear();
    this._captures.set(captureId, { createdAt: this._now(), bounds, imageSize });
    this._latestCaptureId = captureId;
    return {
      kind: 'desktop_screenshot',
      platform: this._platform,
      sourceId: String(source.id || ''),
      sourceName: _safeText(source.name, 200),
      captureId,
      imageSize,
      coordinateSpace: bounds,
      mimeType: 'image/jpeg',
      byteLength: image.length,
      dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
    };
  }

  /** @param {{captureId?: unknown, x?: unknown, y?: unknown}} input */
  async pointerClick(input) {
    if (!this._adapter) throw new Error(`Automatización no compatible con ${this._platform}`);
    const captureId = _safeText(input.captureId, 80);
    const capture = this._captures.get(captureId);
    if (!capture || captureId !== this._latestCaptureId) {
      throw new Error('Captura ausente u obsoleta; ejecuta desktop_screenshot nuevamente');
    }
    if (this._now() - capture.createdAt > 30_000) {
      this._captures.delete(captureId);
      throw new Error('La captura expiró; ejecuta desktop_screenshot nuevamente');
    }
    const x = Number(input.x);
    const y = Number(input.y);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > capture.imageSize.width ||
      y > capture.imageSize.height
    ) {
      throw new Error('Coordenadas fuera de la captura');
    }
    const screenX = Math.round(
      capture.bounds.x + (x / capture.imageSize.width) * capture.bounds.width
    );
    const screenY = Math.round(
      capture.bounds.y + (y / capture.imageSize.height) * capture.bounds.height
    );
    const result = await this._adapter.execute('pointer_click', {}, { x: screenX, y: screenY });
    if (!result.ok) throw new Error(_safeText(result.error, 500) || 'El clic fue rechazado');
    this._captures.delete(captureId);
    this._latestCaptureId = '';
    return {
      kind: 'desktop_action',
      platform: this._platform,
      action: 'pointer_click',
      executed: true,
      actionVerified: true,
      intentVerified: false,
      status: 'executed_unverified',
      screenPoint: { x: screenX, y: screenY },
      requiresObservation: true,
    };
  }

  /** @param {{application?: unknown, timeout?: unknown}} [input] */
  async waitForWindow(input = {}) {
    const application = _safeText(input.application, 120);
    const normalized = application.toLowerCase();
    const aliases = new Set(
      [
        normalized,
        normalized === 'code' ? 'visual studio code' : '',
        normalized === 'chrome' ? 'google chrome' : '',
        normalized === 'edge' ? 'microsoft edge' : '',
        normalized === 'brave' ? 'brave browser' : '',
      ].filter(Boolean)
    );
    const timeout = Math.min(15_000, Math.max(500, Number(input.timeout) || 8000));
    const deadline = this._now() + timeout;
    let lastError = '';
    do {
      try {
        const observed = await this.listWindows({});
        const matched = observed.nodes.find((node) => {
          const haystack = [node.application, node.window, node.name]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return [...aliases].some((alias) => haystack.includes(alias));
        });
        if (matched) {
          return {
            verified: true,
            observationId: observed.observationId,
            window: matched,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (this._now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    } while (this._now() < deadline);
    return {
      verified: false,
      reason:
        lastError || `No apareció una ventana accesible para ${application || 'la aplicación'}`,
    };
  }

  /** @param {{observationId?: unknown, ref?: unknown}} input */
  getState(input) {
    const { observation, ref, target } = this._resolveObservedTarget(input);
    const node = observation.nodes.find((candidate) => candidate.ref === ref);
    if (!node) throw new Error('La referencia ya no está disponible en esta observación');
    return {
      kind: 'ui_state',
      platform: this._platform,
      observationId: observation.id,
      createdAt: observation.createdAt,
      target: { ...target },
      node: { ...node },
      verified: true,
    };
  }

  /**
   * Identidad de aplicación de una referencia reciente. La concesión de una
   * misión usa este valor antes de permitir una acción semántica de UI.
   * @param {{observationId?:unknown,ref?:unknown}} input
   */
  observedApplication(input) {
    const { target } = this._resolveObservedTarget(input);
    return String(target.application || '');
  }

  /** @param {{application?: unknown, expected?: unknown, timeout?: unknown}} input */
  async waitFor(input) {
    const application = _safeText(input.application, 120);
    const expected =
      input.expected && typeof input.expected === 'object' && !Array.isArray(input.expected)
        ? /** @type {Record<string, unknown>} */ (input.expected)
        : null;
    if (!expected) throw new Error('ui_wait requiere una postcondición expected');
    // timeout=0 realiza una sola observación; la misión lo usa antes de actuar.
    const timeout =
      input.timeout === 0 ? 0 : Math.min(30_000, Math.max(250, Number(input.timeout) || 8000));
    const deadline = this._now() + timeout;
    let lastEvidence = '';
    do {
      try {
        const verification = await this._verifyExpected(application, expected);
        lastEvidence = verification.evidence;
        if (verification.verified) {
          return {
            kind: 'ui_wait',
            platform: this._platform,
            verified: true,
            status: 'completed',
            evidence: verification.evidence,
            observationId: this._latestObservationId,
          };
        }
      } catch (error) {
        lastEvidence = error instanceof Error ? error.message : String(error);
      }
      if (this._now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (this._now() < deadline);
    return {
      kind: 'ui_wait',
      platform: this._platform,
      verified: false,
      status: 'timeout',
      evidence: lastEvidence || 'La postcondición no apareció antes del timeout',
    };
  }

  /** @param {{observationId?: unknown, ref?: unknown}} input */
  _resolveObservedTarget(input) {
    const observationId = _safeText(input.observationId, 80);
    const ref = _safeText(input.ref, 80);
    const observation = this._observations.get(observationId);
    if (!observation || observationId !== this._latestObservationId) {
      throw new Error('Observación ausente u obsoleta; ejecuta desktop_snapshot nuevamente');
    }
    if (this._now() - observation.createdAt > OBSERVATION_TTL_MS) {
      this._observations.delete(observationId);
      throw new Error('La observación expiró; ejecuta desktop_snapshot nuevamente');
    }
    const target = observation.refs.get(ref);
    if (!target) throw new Error('Referencia UI inválida para esta observación');
    return { observation, ref, target };
  }

  /**
   * @param {string} action
   * @param {{observationId?: unknown, ref?: unknown, value?: unknown, key?: unknown, direction?: unknown, amount?: unknown, expected?: unknown}} input
   */
  async execute(action, input) {
    if (!this._adapter) throw new Error(`Automatización no compatible con ${this._platform}`);
    if (!MUTATING_ACTIONS.has(action))
      throw new Error(`Acción de escritorio desconocida: ${action}`);
    const { observation, ref, target } = this._resolveObservedTarget(input);

    const value = action === 'type' ? String(input.value ?? '') : '';
    if (value.length > 4000) throw new Error('Texto demasiado largo');
    const key = action === 'press' ? _safeText(input.key, 40) : '';
    if (action === 'press' && !/^[A-Za-z0-9+_{}()-]{1,40}$/.test(key)) {
      throw new Error('Tecla no permitida');
    }
    const direction = action === 'scroll' ? _safeText(input.direction, 10).toLowerCase() : '';
    if (action === 'scroll' && !['up', 'down', 'left', 'right'].includes(direction)) {
      throw new Error('Dirección de desplazamiento no permitida');
    }
    const amount = action === 'scroll' ? Math.min(10, Math.max(1, Number(input.amount) || 1)) : 0;
    const result = await this._adapter.execute(action, target, { value, key, direction, amount });
    if (!result.ok) {
      const suffix = result.stale ? '; vuelve a observar antes de continuar' : '';
      throw new Error((_safeText(result.error, 500) || 'La acción fue rechazada') + suffix);
    }

    const expected =
      input.expected && typeof input.expected === 'object' && !Array.isArray(input.expected)
        ? /** @type {Record<string, unknown>} */ (input.expected)
        : null;
    const verification = await this._verifyExpected(observation.application, expected);
    return {
      kind: 'desktop_action',
      platform: this._platform,
      action,
      ref,
      executed: Boolean(result.executed),
      actionVerified: Boolean(result.executed),
      intentVerified: verification.verified,
      status: verification.verified ? 'completed' : 'executed_unverified',
      evidence: result.evidence || null,
      verification: verification.evidence,
      requiresObservation: true,
    };
  }

  /** @param {string} application @param {Record<string, unknown>|null} expected */
  async _verifyExpected(application, expected) {
    if (!expected) return { verified: false, evidence: 'No se declaró una postcondición' };
    const snapshot = await this.snapshot({ application, maxDepth: 8, maxNodes: 400 });
    const scopedNodes = application
      ? snapshot.nodes.filter((node) => _sameApplication(node.application, application))
      : snapshot.nodes;
    const name = _safeText(expected.name, 300).toLowerCase();
    const exactName = expected.exactName === true;
    const role = _safeText(expected.role, 80).toLowerCase();
    const state = _safeText(expected.state, 80).toLowerCase();
    const absent = expected.absent === true;
    const matched = scopedNodes.find((node) => {
      if (name) {
        const observedName = _safeText(node.name, 300).toLowerCase();
        if (exactName ? observedName !== name : !observedName.includes(name)) return false;
      }
      if (role && String(node.role || '').toLowerCase() !== role) return false;
      if (
        state &&
        !(node.states || []).includes(state) &&
        !(state === 'focused' && node.focused === true)
      )
        return false;
      return Boolean(name || role || state);
    });
    const verified = absent ? scopedNodes.length > 0 && !matched : Boolean(matched);
    return {
      verified,
      evidence: verified
        ? absent
          ? 'El elemento esperado ya no está presente'
          : `Postcondición observada en ${matched?.ref || 'la interfaz'}`
        : 'La postcondición todavía no aparece en la interfaz',
    };
  }
}

/** @type {DesktopAutomation|null} */
let _instance = null;
function getDesktopAutomation() {
  if (!_instance) _instance = new DesktopAutomation();
  return _instance;
}

module.exports = {
  DesktopAutomation,
  getDesktopAutomation,
  MUTATING_ACTIONS,
  OBSERVATION_TTL_MS,
};
