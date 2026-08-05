'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Harness para el benchmark de tareas reales (§8 del roadmap).
 *
 * Levanta un servidor OpenClaw aislado (sin auth) apuntando al workspace de
 * la tarea, inicializa Core de forma standalone y ejecuta Core.runAgent()
 * en evalMode (toda tool de alto impacto se auto-aprueba).
 *
 * Uso (desde benchmarks/run.js):
 *   const h = require('./lib/harness');
 *   const agent = h.spawn();
 *   const res = await agent.run(prompt);
 *   await agent.close();
 */

const OPENCLAW_PORT = 18789;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Harness {
  /**
   * @param {object} opts
   * @param {string} opts.workspace - directorio git de la tarea
   * @param {string} [opts.llmKey] - API key de Groq (default: env LLM_KEY_GROQ)
   * @param {number} [opts.maxIterations]
   * @param {string} [opts.mode] - 'fast' | 'smart'
   */
  constructor(opts = {}) {
    this.workspace = opts.workspace;
    this.llmKey = opts.llmKey || process.env.LLM_KEY_GROQ;
    this.maxIterations = opts.maxIterations || 10;
    this.mode = opts.mode || 'fast';
    this._server = null;
    this._pid = null;
  }

  async start() {
    // 1) Servidor OpenClaw aislado sin auth, con el workspace como path permitido.
    await this._startOpenClaw();

    // 2) Cargar Core (standalone, sin app de Electron).
    const Core = require(path.join(ROOT, 'core', 'Core.js'));
    const LLMProvider = require(path.join(ROOT, 'core', 'llm', 'LLMProvider.js'));

    // Configurar la key ANTES de init (init lee config solo si hay _configPath,
    // que en standalone es null → configurar manualmente).
    if (this.llmKey) {
      LLMProvider.configure({
        llm: {
          providers: { groq: { apiKey: this.llmKey } },
          // Fase J: en corridas del benchmark el TPM de Groq se agota seguido
          // (429 con "try again in X"). La cola serializa y espera el cooldown
          // con presupuesto largo para que la corrida no muera a mitad de camino.
          queue: { enabled: true, concurrency: 1, maxWaitMs: 15 * 60 * 1000, priority: 0 },
        },
      });
    }
    process.env.ASISTENTE_WORKSPACE = this.workspace;

    Core.init(null);

    // Esperar a que OpenClaw esté disponible para el bridge.
    const bridge = Core.getBridge();
    for (let i = 0; i < 20; i++) {
      if (await bridge.isAvailable()) break;
      await sleep(500);
    }
    if (!(await bridge.isAvailable())) {
      console.warn('[harness] OpenClaw no disponible para el bridge');
    }

    this._core = Core;
    return this;
  }

  async _startOpenClaw() {
    const serverPath = path.join(ROOT, 'openclaw-server.js');
    // Key compartida: el server es fail-closed (no arranca sin API_KEY) y el
    // bridge lee process.env.OPENCLAW_API_KEY en cada request. Generamos una
    // key única y la exponemos al proceso del runner antes de cargar Core.
    const apiKey = require('crypto').randomBytes(32).toString('hex');
    process.env.OPENCLAW_API_KEY = apiKey;
    this._apiKey = apiKey;

    this._server = fork(serverPath, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        OPENCLAW_API_KEY: apiKey,
        OPENCLAW_ALLOWED_PATH: this.workspace,
      },
    });
    this._pid = this._server.pid;
    this._server.stdout?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.log('[openclaw-server]', msg);
    });
    this._server.stderr?.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.error('[openclaw-server]', msg);
    });

    // Esperar /health 200.
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${OPENCLAW_PORT}/health`);
        if (res.ok) return;
      } catch {}
      await sleep(500);
    }
    throw new Error('openclaw-server no respondió /health a tiempo');
  }

  async run(prompt, extra = {}) {
    if (!this._core) throw new Error('Harness no iniciado: llamá start()');
    const t0 = Date.now();
    const result = await this._core.runAgent(prompt, {
      evalMode: true,
      mode: this.mode,
      maxIterations: this.maxIterations,
      ...extra,
    });
    return {
      ...result,
      elapsedMs: Date.now() - t0,
    };
  }

  async close() {
    try {
      this._core?.shutdown?.();
    } catch {}
    if (this._server) {
      try {
        this._server.kill('SIGTERM');
      } catch {}
      this._server = null;
    }
    if (this._apiKey && process.env.OPENCLAW_API_KEY === this._apiKey) {
      delete process.env.OPENCLAW_API_KEY;
    }
  }
}

async function create(opts) {
  const h = new Harness(opts);
  await h.start();
  return h;
}

module.exports = { Harness, create };
