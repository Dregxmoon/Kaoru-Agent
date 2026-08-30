// @ts-nocheck
/**
 * MCPManager.js — Cliente MCP (Model Context Protocol) para el asistente
 *
 * Otra fuente de herramientas para el asistente, EN PARALELO a OpenClaw, no en vez
 * de ella y sin depender de que esté corriendo: se conecta a servidores MCP
 * externos (locales vía stdio — el caso normal; `npx -y <paquete>` como
 * cualquier host de MCP) y expone sus tools al mismo pipeline de acciones
 * que ya usa OpenClaw (Planner → StructuredActionParser → aprobación).
 *
 * Si no hay ni un solo servidor MCP configurado, el asistente sigue funcionando
 * exactamente igual que antes — cero impacto. Si hay alguno conectado, se
 * suma como capacidad extra, tanto si OpenClaw/mock-openclaw está corriendo
 * como si no.
 *
 * Servidores configurados viven en config.json bajo `mcp.servers`:
 *   [{ id, name, command, args, env, enabled }]
 *
 * Cada tool de cada servidor conectado se identifica por (server, tool) —
 * el nombre del servidor sirve de namespace para evitar colisiones entre
 * servidores distintos que expongan una tool con el mismo nombre.
 *
 * Seguridad: la aprobación es CONDICIONAL (ver ActionParser.isHighImpact —
 * caso tool 'mcp'). Las llamadas con path dentro del workspace y sin señales
 * sensibles se ejecutan libres (igual que read/write/edit openclaw); piden
 * aprobación solo cuando apuntan FUERA del workspace (external_directory),
 * a rutas sensibles (.env, .ssh, keys...) o cuando la tool no expone path
 * identificable (server de terceros con comportamiento desconocido).
 */

'use strict';
const logger = require('../observability/Logger.js');

const crypto = require('crypto');
const { minimalChildEnv } = require('../utils/childEnv.js');
const { wrapUntrusted } = require('../grounding/untrustedContent.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// Timeout generoso para la conexión inicial — la primera vez que corre un
// servidor vía npx, Node/npm puede tardar en descargarlo. Las llamadas a
// tools individuales usan el timeout default del SDK (no este).
const CONNECT_TIMEOUT_MS = 45 * 1000;

const REGISTRY_API = 'https://registry.modelcontextprotocol.io/v0/servers';
const REGISTRY_TIMEOUT_MS = 8 * 1000;

const CATEGORIES = [
  { id: 'code', name: 'Código', icon: '💻', description: 'Desarrollo, análisis, repositorios' },
  { id: 'data', name: 'Datos', icon: '📊', description: 'Bases de datos, APIs, análisis' },
  { id: 'web', name: 'Web', icon: '🌐', description: 'Navegación, scraping, APIs web' },
  { id: 'files', name: 'Archivos', icon: '📁', description: 'Sistema de archivos, almacenamiento' },
  {
    id: 'comm',
    name: 'Comunicación',
    icon: '💬',
    description: 'Slack, Discord, email, mensajería',
  },
  {
    id: 'cloud',
    name: 'Cloud/DevOps',
    icon: '☁️',
    description: 'AWS, GCP, Azure, Kubernetes, CI/CD',
  },
  { id: 'ai', name: 'IA/ML', icon: '🤖', description: 'Modelos, embeddings, entrenamiento' },
  {
    id: 'productivity',
    name: 'Productividad',
    icon: '⚡',
    description: 'Notion, Obsidian, calendarios, tareas',
  },
  { id: 'security', name: 'Seguridad', icon: '🔒', description: 'Escaneo, secretos, compliance' },
  { id: 'other', name: 'Otros', icon: '🔧', description: 'Utilidades varias' },
];

function _detectCategory(name, description, packages = []) {
  const text = `${name} ${description} ${JSON.stringify(packages)}`.toLowerCase();
  const rules = [
    {
      cat: 'code',
      keywords: [
        'github',
        'git',
        'code',
        'repo',
        'repository',
        'gitlab',
        'bitbucket',
        'analyze',
        'review',
        'lint',
        'refactor',
        'debug',
        'test',
        'coverage',
      ],
    },
    {
      cat: 'data',
      keywords: [
        'database',
        'sql',
        'postgres',
        'mysql',
        'sqlite',
        'mongodb',
        'redis',
        'analytics',
        'query',
        'data',
        'csv',
        'json',
        'api',
      ],
    },
    {
      cat: 'web',
      keywords: [
        'web',
        'browser',
        'scrape',
        'crawl',
        'fetch',
        'http',
        'html',
        'css',
        'dom',
        'playwright',
        'puppeteer',
        'search',
        'google',
      ],
    },
    {
      cat: 'files',
      keywords: [
        'filesystem',
        'file',
        'folder',
        'directory',
        'storage',
        's3',
        'dropbox',
        'drive',
        'ftp',
        'archive',
      ],
    },
    {
      cat: 'comm',
      keywords: [
        'slack',
        'discord',
        'email',
        'mail',
        'message',
        'chat',
        'notification',
        'webhook',
        'telegram',
        'whatsapp',
      ],
    },
    {
      cat: 'cloud',
      keywords: [
        'aws',
        'gcp',
        'azure',
        'cloud',
        'kubernetes',
        'k8s',
        'docker',
        'terraform',
        'ci/cd',
        'github actions',
        'gitlab ci',
        'deploy',
      ],
    },
    {
      cat: 'ai',
      keywords: [
        'llm',
        'model',
        'embedding',
        'vector',
        'openai',
        'anthropic',
        'huggingface',
        'ml',
        'training',
        'inference',
        'rag',
      ],
    },
    {
      cat: 'productivity',
      keywords: [
        'notion',
        'obsidian',
        'calendar',
        'task',
        'todo',
        'reminder',
        'note',
        'document',
        'wiki',
        'confluence',
        'jira',
        'linear',
      ],
    },
    {
      cat: 'security',
      keywords: [
        'security',
        'secret',
        'vulnerab',
        'scan',
        'audit',
        'compliance',
        'encryption',
        'key',
        'cert',
      ],
    },
  ];
  for (const r of rules) {
    if (r.keywords.some((k) => text.includes(k))) return r.cat;
  }
  return 'other';
}

function _extractAuthInfo(packages = []) {
  const auth = { needsAuth: false, type: 'none', envVars: [], oauth: null };
  for (const pkg of packages) {
    for (const env of pkg.environmentVariables || []) {
      const name = (env.name || '').toLowerCase();
      const desc = (env.description || '').toLowerCase();
      if (
        name.includes('token') ||
        name.includes('key') ||
        name.includes('secret') ||
        name.includes('auth') ||
        name.includes('password') ||
        desc.includes('token') ||
        desc.includes('api key') ||
        desc.includes('oauth')
      ) {
        auth.needsAuth = true;
        if (
          desc.includes('oauth') ||
          name.includes('oauth') ||
          name.includes('client_id') ||
          name.includes('client_secret')
        ) {
          auth.type = 'oauth';
          auth.oauth = { provider: _detectOAuthProvider(name, desc), description: env.description };
        } else {
          auth.type = 'api_key';
        }
        auth.envVars.push({
          name: env.name,
          description: env.description || '',
          required: env.isRequired,
        });
      }
    }
  }
  return auth;
}

function _detectOAuthProvider(envName, envDesc) {
  const text = `${envName} ${envDesc}`.toLowerCase();
  if (text.includes('github')) return 'github';
  if (text.includes('gitlab')) return 'gitlab';
  if (text.includes('google') || text.includes('gcp') || text.includes('gcloud')) return 'google';
  if (
    text.includes('microsoft') ||
    text.includes('azure') ||
    text.includes('outlook') ||
    text.includes('office365')
  )
    return 'microsoft';
  if (text.includes('slack')) return 'slack';
  if (text.includes('discord')) return 'discord';
  if (text.includes('notion')) return 'notion';
  if (text.includes('linear')) return 'linear';
  if (text.includes('jira') || text.includes('atlassian')) return 'atlassian';
  return 'generic';
}

const POPULAR_SERVERS = [
  {
    identifier: '@modelcontextprotocol/server-filesystem',
    reason: 'Acceso universal a archivos locales',
  },
  { identifier: '@modelcontextprotocol/server-github', reason: 'Issues, PRs, repos, código' },
  { identifier: '@modelcontextprotocol/server-gitlab', reason: 'GitLab issues, MRs, CI/CD' },
  {
    identifier: '@modelcontextprotocol/server-memory',
    reason: 'Memoria persistente entre sesiones',
  },
  {
    identifier: '@modelcontextprotocol/server-sequential-thinking',
    reason: 'Razonamiento estructurado paso a paso',
  },
  { identifier: '@modelcontextprotocol/server-everything', reason: 'Servidor de pruebas completo' },
  { identifier: '@modelcontextprotocol/server-brave-search', reason: 'Búsqueda web privada' },
  { identifier: '@modelcontextprotocol/server-fetch', reason: 'HTTP fetch y scraping simple' },
  { identifier: '@modelcontextprotocol/server-sqlite', reason: 'Bases de datos SQLite locales' },
  { identifier: '@modelcontextprotocol/server-postgres', reason: 'PostgreSQL remoto/locale' },
  { identifier: '@modelcontextprotocol/server-redis', reason: 'Cache y pub/sub Redis' },
  { identifier: '@modelcontextprotocol/server-slack', reason: 'Canales, mensajes, usuarios Slack' },
  { identifier: '@modelcontextprotocol/server-gdrive', reason: 'Google Drive archivos' },
  { identifier: '@modelcontextprotocol/server-gmail', reason: 'Gmail emails y etiquetas' },
  { identifier: '@modelcontextprotocol/server-google-calendar', reason: 'Google Calendar eventos' },
  { identifier: '@modelcontextprotocol/server-google-maps', reason: 'Google Maps places y rutas' },
  { identifier: '@modelcontextprotocol/server-notion', reason: 'Notion páginas, bases de datos' },
  { identifier: '@modelcontextprotocol/server-linear', reason: 'Linear issues y proyectos' },
  { identifier: '@modelcontextprotocol/server-jira', reason: 'Jira issues, sprints, boards' },
  { identifier: '@modelcontextprotocol/server-aws', reason: 'Recursos AWS (EC2, S3, Lambda...)' },
  { identifier: '@modelcontextprotocol/server-kubernetes', reason: 'Clústeres Kubernetes' },
  { identifier: '@modelcontextprotocol/server-docker', reason: 'Contenedores e imágenes Docker' },
];

// ── Auto-reconnect (mejora #5) ────────────────────────────────────────────────
// Si un servidor MCP se cae a mitad de sesión (el proceso hijo crashea, npx
// se cuelga, etc.), antes se quedaba "conectado" en el estado hasta el
// siguiente intento fallido de callTool() — sin aviso, sin reintento. Ahora
// el SDK avisa vía onclose/onerror y se reintenta solo, con backoff
// exponencial + jitter, hasta un tope — después de eso queda en 'error'
// visible en el panel, esperando que el usuario reconecte a mano.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1000;

// Sleep cancelable: disconnect() despierta el await con un evento, para que
// el timer de reconexión no mantenga vivo el event loop al cerrar la app.
function _cancellableSleep(ms, onCancel) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onCancel(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function _reconnectBackoff(attempt) {
  const base = RECONNECT_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s, 8s, 16s...
  const jitter = base * (0.7 + Math.random() * 0.6);
  return Math.round(jitter);
}

// Límite de confianza (P3): el resultado de una tool de un servidor MCP es
// contenido de terceros POR DEFINICIÓN (el servidor lo registra el usuario,
// pero sus respuestas no las escribió el agente). Se envuelve SIEMPRE, sin
// excepción, antes de que el resultado llegue al pipeline → contexto del LLM.
function _trustMCPResult(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (Array.isArray(out.content)) {
    let hasText = false;
    out.content = out.content.map((block) => {
      if (block && typeof block === 'object' && typeof block.text === 'string') {
        hasText = true;
        return { ...block, text: wrapUntrusted(block.text) };
      }
      return block;
    });
    // Si el servidor devolvió structuredContent pero ningún bloque de texto,
    // se materializa como texto no confiable para que nunca entre crudo.
    if (!hasText && out.structuredContent !== undefined && out.structuredContent !== null) {
      try {
        out.content = [
          { type: 'text', text: wrapUntrusted(JSON.stringify(out.structuredContent)) },
        ];
      } catch (_) {
        /* best-effort */
      }
    }
  }
  if (typeof out.text === 'string') out.text = wrapUntrusted(out.text);
  return out;
}

// ── Catálogo estático de respaldo ─────────────────────────────────────────────
// Se usa si la búsqueda en vivo contra el registro oficial falla (sin
// internet, el registro está caído, cambió de forma, etc). Un puñado de
// servidores MCP de referencia bien mantenidos por el propio equipo de MCP,
// para que "buscar en la biblioteca" nunca devuelva una lista vacía.
const FALLBACK_CATALOG = [
  {
    name: 'filesystem',
    description:
      'Leer/escribir/listar archivos en carpetas específicas del sistema — más allá del proyecto (necesita indicarle la carpeta permitida como argumento).',
    registryType: 'npm',
    identifier: '@modelcontextprotocol/server-filesystem',
    args: ['<ruta-permitida>'],
    requiredEnv: [],
  },
  {
    name: 'memory',
    description:
      'Memoria de grafo de conocimiento persistente entre sesiones (servidor de referencia oficial de Anthropic).',
    registryType: 'npm',
    identifier: '@modelcontextprotocol/server-memory',
    args: [],
    requiredEnv: [],
  },
  {
    name: 'sequential-thinking',
    description: 'Herramienta de razonamiento paso a paso estructurado para problemas complejos.',
    registryType: 'npm',
    identifier: '@modelcontextprotocol/server-sequential-thinking',
    args: [],
    requiredEnv: [],
  },
  {
    name: 'everything',
    description:
      'Servidor de referencia/pruebas con herramientas de ejemplo — útil para probar que la integración MCP en sí funciona, no para uso diario.',
    registryType: 'npm',
    identifier: '@modelcontextprotocol/server-everything',
    args: [],
    requiredEnv: [],
  },
];

// ── Conexión individual a un servidor ─────────────────────────────────────────

class MCPServerConnection {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.config = config; // { command, args, env }
    this.client = null;
    this.transport = null;
    this.status = 'disconnected'; // disconnected | connecting | connected | reconnecting | error
    this.error = null;
    this.tools = []; // [{ name, description, inputSchema }]
    this._cancelReconnect = null;

    this._intentionalDisconnect = false; // true si disconnect() lo pidió el usuario
    this._reconnectAttempts = 0;
    this._reconnectInProgress = false;
    this._onStatusChange = null; // callback del Manager, para _notify()
  }

  async connect() {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.status = 'connecting';
    this.error = null;
    this._intentionalDisconnect = false;

    try {
      // C1 (seguridad): NUNCA se pasa process.env a servidores MCP — son
      // terceros y podrían exfiltrar credenciales (GITHUB_TOKEN, API keys...).
      // Solo PATH/HOME + lo que el server declare explícitamente en su config.
      this.transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args || [],
        env: minimalChildEnv(this.config.env || {}),
      });
      this.client = new Client(
        { name: 'asistente-personal', version: '1.0.0' },
        { capabilities: {} }
      );

      // Auto-reconnect: el SDK avisa acá cuando el transporte se cierra por
      // CUALQUIER razón — incluyendo que nosotros mismos llamemos
      // client.close(). _intentionalDisconnect distingue "lo pedimos
      // nosotros" (no reconectar) de "se cayó solo" (sí reconectar).
      this.client.onclose = () => this._handleUnexpectedClose();
      this.client.onerror = (err) => {
        logger.warn('MCPManager', `[mcp] error en servidor "${this.name}":`, err.message);
      };

      await Promise.race([
        this.client.connect(this.transport),
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `timeout de conexión (${CONNECT_TIMEOUT_MS / 1000}s) — si es la primera vez, npx puede estar descargando el paquete`
                )
              ),
            CONNECT_TIMEOUT_MS
          )
        ),
      ]);

      const listed = await this.client.listTools();
      this.tools = listed.tools || [];
      this.status = 'connected';
      this._reconnectAttempts = 0; // conexión sana — resetea el presupuesto de reintentos
      logger.info(
        'MCPManager',
        `[mcp] conectado: "${this.name}" (${this.tools.length} tools: ${this.tools.map((t) => t.name).join(', ')})`
      );
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      logger.warn('MCPManager', `[mcp] error conectando a "${this.name}":`, e.message);
      try {
        await this.transport?.close();
      } catch (_) {
        /* best-effort */
      }
      this.client = null;
    }
    this._onStatusChange?.();
  }

  /** El transporte se cerró sin que nosotros lo pidiéramos — probable crash del proceso hijo. */
  _handleUnexpectedClose() {
    if (this._intentionalDisconnect) return; // fuimos nosotros — nada que hacer
    if (this.status === 'connecting' || this.status === 'reconnecting') return; // ya en proceso

    logger.warn('MCPManager', `[mcp] "${this.name}" se desconectó inesperadamente`);
    this.client = null;
    this._scheduleReconnect();
  }

  async _scheduleReconnect() {
    if (this._intentionalDisconnect) return;
    if (this._reconnectInProgress) return;

    this._reconnectInProgress = true;

    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status = 'error';
      this.error = `Se perdió la conexión y no se pudo recuperar tras ${MAX_RECONNECT_ATTEMPTS} intentos. Reconecta manualmente desde el panel.`;
      logger.warn('MCPManager', `[mcp] "${this.name}" agotó los intentos de reconexión`);
      this._reconnectInProgress = false;
      this._onStatusChange?.();
      return;
    }

    this._reconnectAttempts++;
    this.status = 'reconnecting';
    this._onStatusChange?.();

    const waitMs = _reconnectBackoff(this._reconnectAttempts - 1);
    logger.info(
      'MCPManager',
      `[mcp] "${this.name}" — reintentando en ${waitMs}ms (intento ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
    );
    await _cancellableSleep(waitMs, (cb) => {
      this._cancelReconnect = cb;
    });
    this._cancelReconnect = null;

    if (this._intentionalDisconnect) {
      this._reconnectInProgress = false;
      return;
    }
    this.status = 'disconnected'; // deja que connect() haga su cosa normal
    await this.connect();

    // Si connect() falló de nuevo, vuelve a intentar (connect() ya deja
    // status='error' en ese caso — desde ahí, reintentamos otra vez).
    this._reconnectInProgress = false;
    if (this.status === 'error' && !this._intentionalDisconnect) {
      this._scheduleReconnect();
    }
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    this._reconnectInProgress = false;
    if (this._cancelReconnect) {
      this._cancelReconnect();
      this._cancelReconnect = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch (_) {
        /* best-effort */
      }
    }
    this.client = null;
    this.transport = null;
    this.status = 'disconnected';
    this.tools = [];
  }

  async callTool(toolName, args) {
    if (this.status !== 'connected' || !this.client) {
      throw new Error(`Servidor MCP "${this.name}" no está conectado (estado: ${this.status})`);
    }
    const result = await this.client.callTool({ name: toolName, arguments: args || {} });
    // Límite de confianza: cualquier resultado de un servidor MCP externo se
    // envuelve como contenido no confiable antes de llegar al pipeline.
    return _trustMCPResult(result);
  }
}

// ── Manager ────────────────────────────────────────────────────────────────

class MCPManager {
  constructor() {
    this._connections = new Map(); // id -> MCPServerConnection
    this._onChange = null; // callback opcional, para avisar a la UI en vivo
  }

  setOnChange(cb) {
    this._onChange = cb;
  }

  _notify() {
    if (!this._onChange) return;
    try {
      this._onChange(this.listServers());
    } catch (_) {
      /* best-effort */
    }
  }

  /** Conecta todos los servidores marcados enabled:true de la config guardada. */
  async init(serverConfigs = []) {
    const enabled = serverConfigs.filter((s) => s.enabled !== false);
    if (!enabled.length) {
      logger.info(
        'MCPManager',
        '[mcp] sin servidores configurados — el asistente sigue igual que siempre'
      );
      return;
    }
    logger.info('MCPManager', `[mcp] conectando ${enabled.length} servidor(es) configurado(s)...`);
    for (const cfg of enabled) {
      await this._connectOne(cfg);
    }
  }

  async _connectOne(cfg) {
    let conn = this._connections.get(cfg.id);
    if (!conn) {
      conn = new MCPServerConnection(cfg);
      conn._onStatusChange = () => this._notify();
      this._connections.set(cfg.id, conn);
    } else {
      conn.config = cfg;
    }
    await conn.connect();
    this._notify();
    return conn;
  }

  async addServer(cfg) {
    const id = cfg.id || crypto.randomUUID();
    const full = { ...cfg, id, enabled: cfg.enabled !== false };
    await this._connectOne(full);
    return this.getServerStatus(id);
  }

  async removeServer(id) {
    const conn = this._connections.get(id);
    if (conn) {
      await conn.disconnect();
      this._connections.delete(id);
    }
    this._notify();
  }

  async toggleServer(id, enabled, cfg) {
    if (enabled) {
      await this._connectOne({ ...cfg, id });
    } else {
      const conn = this._connections.get(id);
      if (conn) await conn.disconnect();
    }
    this._notify();
  }

  async disconnectAll() {
    await Promise.all([...this._connections.values()].map((c) => c.disconnect()));
  }

  listServers() {
    return [...this._connections.values()].map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      error: c.error,
      toolCount: c.tools.length,
      tools: c.tools.map((t) => ({ name: t.name, description: t.description || '' })),
    }));
  }

  getServerStatus(id) {
    const c = this._connections.get(id);
    if (!c) return null;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      error: c.error,
      toolCount: c.tools.length,
      tools: c.tools.map((t) => ({ name: t.name, description: t.description || '' })),
    };
  }

  /** Todas las tools de servidores CONECTADOS — para inyectar en el system prompt. */
  listAllTools() {
    const out = [];
    for (const conn of this._connections.values()) {
      if (conn.status !== 'connected') continue;
      for (const t of conn.tools) {
        out.push({
          server: conn.name,
          serverId: conn.id,
          tool: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema,
        });
      }
    }
    return out;
  }

  hasConnectedServers() {
    return [...this._connections.values()].some((c) => c.status === 'connected');
  }

  /** serverRef puede ser el id o el name del servidor — acepta ambos por conveniencia. */
  async callTool(serverRef, toolName, args) {
    const conn = [...this._connections.values()].find(
      (c) => c.id === serverRef || c.name === serverRef
    );
    if (!conn) throw new Error(`Servidor MCP "${serverRef}" no encontrado o no conectado`);
    return conn.callTool(toolName, args);
  }

  /**
   * Busca en el registro oficial de MCP (registry.modelcontextprotocol.io).
   * Si falla (sin internet, registro caído, cambió de forma) cae al
   * catálogo estático — nunca devuelve una lista vacía por error de red.
   */
  async searchRegistry(query = '') {
    try {
      const url = query
        ? `${REGISTRY_API}?search=${encodeURIComponent(query)}&limit=20`
        : `${REGISTRY_API}?limit=20`;

      const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`registro respondió ${res.status}`);
      const data = await res.json();

      const normalized = this._normalizeRegistryResults(data.servers || []);
      // Si el registro respondió pero ninguno de los resultados trae un
      // paquete npm/stdio instalable de forma simple, mejor mostrar el
      // catálogo estático (que sí lo garantiza) en vez de una lista vacía.
      if (normalized.length) return normalized;
      throw new Error('sin resultados instalables vía npx en la respuesta del registro');
    } catch (e) {
      logger.warn(
        'MCPManager',
        '[mcp] registro en vivo no disponible, usando catálogo estático:',
        e.message
      );
      const q = query.toLowerCase().trim();
      const filtered = q
        ? FALLBACK_CATALOG.filter(
            (s) => s.name.includes(q) || s.description.toLowerCase().includes(q)
          )
        : FALLBACK_CATALOG;
      return filtered.map((s) => ({ ...s, source: 'static' }));
    }
  }

  _normalizeRegistryResults(servers) {
    const out = [];
    for (const entry of servers) {
      const s = entry.server;
      if (!s) continue;

      const meta = entry._meta?.['io.modelcontextprotocol.registry/official'];
      if (meta && meta.isLatest === false) continue;

      const pkg = (s.packages || []).find(
        (p) => p.registryType === 'npm' && (!p.transport || p.transport.type === 'stdio')
      );
      if (!pkg) continue;

      const category = _detectCategory(s.title || s.name, s.description, s.packages);
      const auth = _extractAuthInfo(s.packages);

      out.push({
        name: s.title || s.name,
        description: s.description || '',
        registryType: 'npm',
        identifier: pkg.identifier,
        version: pkg.version,
        args: (pkg.packageArguments || []).map((a) => a.default || a.valueHint || `<${a.name}>`),
        requiredEnv: (pkg.environmentVariables || [])
          .filter((e) => e.isRequired)
          .map((e) => ({ name: e.name, description: e.description || '' })),
        source: 'live',
        category,
        auth,
        repoUrl: s.repository?.url || '',
        homepage: s.homepage || '',
        tags: s.tags || [],
      });
    }
    return out;
  }

  async getFeaturedServers(limit = 12) {
    try {
      const url = `${REGISTRY_API}?limit=50`;
      const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`registro respondió ${res.status}`);
      const data = await res.json();
      const normalized = this._normalizeRegistryResults(data.servers || []);

      const popularMap = new Map(POPULAR_SERVERS.map((p) => [p.identifier, p.reason]));
      const featured = normalized
        .filter((s) => popularMap.has(s.identifier))
        .map((s) => ({ ...s, popularReason: popularMap.get(s.identifier) }))
        .slice(0, limit);

      if (featured.length < limit) {
        const remaining = normalized
          .filter((s) => !popularMap.has(s.identifier))
          .sort((a, b) => {
            const aPop = a.tags?.includes('popular') ? 1 : 0;
            const bPop = b.tags?.includes('popular') ? 1 : 0;
            return bPop - aPop;
          })
          .slice(0, limit - featured.length);
        featured.push(...remaining);
      }
      return featured.slice(0, limit);
    } catch (e) {
      logger.warn('MCPManager', '[mcp] featured fallback:', e.message);
      return FALLBACK_CATALOG.map((s) => ({
        ...s,
        source: 'static',
        category: _detectCategory(s.name, s.description),
        auth: { needsAuth: false, type: 'none', envVars: [] },
        popularReason: POPULAR_SERVERS.find((p) => p.identifier === s.identifier)?.reason || '',
      })).slice(0, limit);
    }
  }

  async searchRegistry(query = '', options = {}) {
    const { category, sort = 'relevance', limit = 20 } = options;
    try {
      const url = query
        ? `${REGISTRY_API}?search=${encodeURIComponent(query)}&limit=50`
        : `${REGISTRY_API}?limit=50`;

      const res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`registro respondió ${res.status}`);
      const data = await res.json();

      let normalized = this._normalizeRegistryResults(data.servers || []);

      if (category && category !== 'all') {
        normalized = normalized.filter((s) => s.category === category);
      }

      switch (sort) {
        case 'popular':
          normalized.sort((a, b) => {
            const aPop = POPULAR_SERVERS.find((p) => p.identifier === a.identifier) ? 1 : 0;
            const bPop = POPULAR_SERVERS.find((p) => p.identifier === b.identifier) ? 1 : 0;
            return bPop - aPop;
          });
          break;
        case 'name':
          normalized.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case 'relevance':
        default:
          break;
      }

      if (normalized.length) return normalized.slice(0, limit);
      throw new Error('sin resultados instalables vía npx');
    } catch (e) {
      logger.warn(
        'MCPManager',
        '[mcp] registro en vivo no disponible, usando catálogo estático:',
        e.message
      );
      let filtered = FALLBACK_CATALOG.filter(
        (s) =>
          !query ||
          s.name.includes(query.toLowerCase()) ||
          s.description.toLowerCase().includes(query.toLowerCase())
      );
      if (category && category !== 'all') {
        filtered = filtered.filter((s) => _detectCategory(s.name, s.description) === category);
      }
      return filtered
        .map((s) => ({
          ...s,
          source: 'static',
          category: _detectCategory(s.name, s.description),
          auth: { needsAuth: false, type: 'none', envVars: [] },
        }))
        .slice(0, limit);
    }
  }

  getCategories() {
    return CATEGORIES;
  }
}

let _instance = null;
function getMCPManager() {
  if (!_instance) _instance = new MCPManager();
  return _instance;
}

module.exports = { MCPManager, MCPServerConnection, getMCPManager };
