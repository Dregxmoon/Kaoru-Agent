'use strict';

const path = require('path');
const fs = require('fs');
const { getOpenClawBridge } = require('./OpenClawBridge.js');
const { getStructuredActionParser } = require('./StructuredActionParser.js');
const AP = require('./ActionParser.js');
const LLMProvider = require('../llm/LLMProvider.js');
const { getToolRegistry } = require('../task/ToolRegistry.js');
const { getGitManager } = require('../git/GitManager.js');
const { getGitHubManager } = require('../github/GitHubManager.js');

const VALID_MODES = new Set(['smart', 'fast', 'task', 'conversational']);

// Tools LSP que se despachan al LSPManager (no al puente OpenClaw).
const LSP_TOOLS = new Set(['get_diagnostics', 'go_to_definition', 'find_references', 'get_symbols', 'hover', 'rename', 'code_actions']);

// Tools Git nativas (§10) que se despachan al GitManager.
const GIT_TOOLS = new Set(['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit', 'git_stash', 'git_merge', 'git_rebase', 'git_push']);

// Tools GitHub nativas (§10) que se despachan al GitHubManager.
const GITHUB_TOOLS = new Set([
  'github_repo_info', 'github_issue_list', 'github_issue_create', 'github_issue_comment',
  'github_issue_close', 'github_pr_list', 'github_pr_create', 'github_pr_review', 'github_actions_status',
]);

// Tool de subagentes (§11): se despacha en proceso lanzando un AgentLoop anidado.
const SUBAGENT_TOOLS = new Set(['subagent', 'task']);

// Máxima profundidad de subagentes anidados (previene recursión infinita).
const MAX_SUBAGENT_DEPTH = 2;

const SUBAGENT_SYSTEM = `Eres un subagente especializado que recibe una sub-tarea concreta y autocontenida.
Trabaja de forma autónoma y enfócate SOLO en la sub-tarea asignada. Usa las herramientas disponibles
(grep, glob, read, exec, web_search, browser) para investigar o modificar archivos si hace falta.

Al terminar, responde con un resumen CONCISO del resultado (máximo 200 palabras): qué hiciste, qué
encontraste o qué cambiaste, y cualquier detalle que el agente principal deba conocer. No hagas
preguntas ni pidas aprobación: tu única salida es el resumen final.`;

// Tools que mutan archivos: tras su ejecución se pide feedback LSP al server.
const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'create_file', 'edit_file']);

const MAX_ITERATIONS = 25;
const RESULT_TRUNCATE_LIMIT = 800;

// G.1: compactación de contexto. Cuando la historia de iteraciones crece, los
// turnos viejos se condensan en un resumen determinista (no se re-envía todo
// el historial crudo a cada turno): el objetivo + lista de acciones ejecutadas.
const COMPACT_MIN_TURNS   = 14;   // tuplas de historial que disparan compactación
const COMPACT_KEEP_TAIL   = 8;    // turnos recientes que se conservan íntegros

const AGENT_LOOP_SYSTEM = `
# MODO AGENTE — BUCLE DE EJECUCIÓN

Estás operando en un bucle agente: puedes solicitar una herramienta por vez
y recibirás el resultado real antes de decidir el siguiente paso.

## Cómo solicitar una herramienta

Usa este formato EXACTO dentro de tu respuesta:

\`\`\`action
ACCIÓN: <nombre> | ARCHIVO/COMANDO/QUERY/URL: <valor>
\`\`\`

Para write/edit incluye el contenido completo en CONTENIDO: (puede ser multilínea).
Ejemplo:
\`\`\`action
ACCIÓN: write | ARCHIVO: docs/README.md
CONTENIDO: # Demo

Todo el contenido del archivo, en varias líneas si hace falta.
\`\`\`

Ejemplos:
\`\`\`action
ACCIÓN: read_file | ARCHIVO: src/main.js
\`\`\`

\`\`\`action
ACCIÓN: run_command | COMANDO: git status
\`\`\`

\`\`\`action
ACCIÓN: web_search | QUERY: cómo instalar node
\`\`\`

\`\`\`action
ACCIÓN: mcp_call | SERVIDOR: filesystem | HERRAMIENTA: list_directory | PARAMS: {"path": "."}
\`\`\`

Puedes incluir el bloque \`\`\`action en cualquier parte de tu respuesta.
El resto del texto se mostrará al usuario.

## Reglas

1. SOLICITA UNA HERRAMIENTA POR VEZ. Espera el resultado antes de pedir la siguiente.
2. NO inventes resultados de comandos ni herramientas. Todo lo que ejecutes
   devolverá un resultado real que verás en el siguiente turno.
3. Si la tarea está completa o no necesitas más herramientas, responde
   normalmente sin el bloque \`\`\`action — el bucle terminará.
4. Si una herramienta falla, decide si puedes continuar con otra estrategia
   o si la tarea no se puede completar y responde informando el error.
5. NUNCA ejecutes acciones destructivas sin antes informar al usuario qué
   vas a hacer y por qué.
6. USA HERRAMIENTAS SOLO CUANDO LA TAREA LO REQUIERA. Saludos, preguntas
   sobre ti mismo ("quién eres", tu identidad, tu personalidad), preguntas de
   conversación y dudas que ya puedes responder con lo que sabes se contestan
   DIRECTAMENTE, sin llamar ninguna herramienta. browser y web_search son
   SOLO para información externa actual que no puedes conocer (noticias,
   datos en vivo, páginas web). NO busques en internet cosas que ya sabes,
   como tu propia identidad — eso desperdicia recursos y el rate-limit.
`;

const MODE_ALIAS = {
  task: 'smart',
  conversational: 'fast',
};

class AgentLoop {
  constructor(opts = {}) {
    this.maxIterations = opts.maxIterations || MAX_ITERATIONS;
    this._bridge = opts.bridge || getOpenClawBridge();
    this._toolRegistry = getToolRegistry();
    this._llm = opts.llm || null;
    this._lsp = opts.lsp || null;
    this._git = opts.git || getGitManager();
    this._github = opts.github || getGitHubManager();
    this._graph = opts.graph || null;
    this._compactionPersisted = false;
    const rawMode = opts.mode || 'smart';
    if (!VALID_MODES.has(rawMode)) {
      console.warn(`[agent-loop] modo "${rawMode}" no reconocido, usando "smart"`);
      this._mode = 'smart';
    } else {
      this._mode = MODE_ALIAS[rawMode] || rawMode;
    }
  }

  _getLLM() {
    if (this._llm) return this._llm;
    if (!this._llmRef) {
      this._llmRef = LLMProvider.completeTask.bind(LLMProvider);
    }
    return this._llmRef;
  }

  async run(userMessage, systemPrompt, messages, opts = {}) {
    const taskIntent = opts.taskIntent || null;
    this._currentTaskIntent = taskIntent;
    const domain = taskIntent?.domain || null;
    const llm = opts.llm || this._llm || this._getLLM();
    const parser = getStructuredActionParser(AP.PROJECT_CWD);

    // ── Tool resolution (Fase 5): Skill > MCP > OpenClaw ────────────
    let tools = opts.tools || null;
    let toolCatalog = this._toolRegistry.serializeToPrompt(domain);
    const toolResolver = opts.toolResolver || null;

    if (toolResolver) {
      try {
        const resolved = await toolResolver.resolveToolset({
          userMessage,
          domain: taskIntent,
          toolRegistry: this._toolRegistry,
          skillManager: opts.skillManager || null,
          mcpManager: opts.mcpManager || null,
          db: opts.skillDb || null,
          matchedSkills: opts.matchedSkills || null,
        });
        if (resolved.nativeToolSchemas) tools = resolved.nativeToolSchemas;
        if (resolved.promptCatalog) toolCatalog = resolved.promptCatalog;
        if (resolved.excluded.length > 0) {
          console.log(`[agent-loop] precedencia: ${resolved.precedence}, herramientas excluidas: ${resolved.excluded.map(e => `${e.source}/${e.tool}`).join(', ')}`);
        }
        console.log(`[agent-loop] precedencia de herramientas: ${resolved.precedence}${resolved.matchedSkills.length > 0 ? ` (skills: ${resolved.matchedSkills.map(s => s.name).join(', ')})` : ''}`);
      } catch (e) {
        console.warn(`[agent-loop] error en resolución de herramientas: ${e.message}`);
      }
    }

    let agentPrompt = systemPrompt.replace(/\n+$/, '') + '\n\n' +
      AGENT_LOOP_SYSTEM.trim() +
      (toolCatalog ? '\n\n' + toolCatalog : '');

    // ── Memoria semántica (§12): contexto relevante de sesiones anteriores ──
    // Se inyecta al prompt (no a la historia) para reconstruir contexto en
    // tareas largas o retomadas sin inflar el tamaño del mensaje.
    if (this._graph) {
      try {
        const memoryContext = await this._recallMemory(userMessage);
        if (memoryContext) {
          agentPrompt += '\n\n' + memoryContext;
        }
      } catch (e) {
        console.warn(`[agent-loop] recall de memoria falló: ${e.message}`);
      }
    }

    // ── Skill injection ────────────────────────────────────────────────
    const skillManager = opts.skillManager || null;
    if (skillManager && typeof skillManager.buildInjection === 'function') {
      try {
        const skillBlock = await skillManager.buildInjection(userMessage, opts.skillDb || null);
        if (skillBlock) {
          agentPrompt = agentPrompt + '\n\n' + skillBlock;
          console.log(`[agent-loop] skills activas inyectadas en el prompt`);
        }
      } catch (e) {
        console.warn(`[agent-loop] error inyectando skills: ${e.message}`);
      }
    }

    const iterationHistory = [...(messages || [])];
    let lastToolResult = null;
    const toolResults = [];
    let lastResponseText = null; // guarda último output del LLM para max_iterations

    for (let i = 0; i < this.maxIterations; i++) {
      const _itStart = Date.now();
      const currentUserMsg = i === 0
        ? userMessage
        : this._buildToolResultMessage(lastToolResult);

      const llmMessages = this._buildLLMMessages(iterationHistory, currentUserMsg, userMessage, toolResults, i);

      // ── Llamada al LLM: intenta tool-calling nativo primero ────────────
      let responseText = null;
      let toolCalls = null;

      if (tools && llm === this._getLLM()) {
        try {
          const tcResult = await LLMProvider.completeWithTools(llmMessages, agentPrompt, tools, this._mode);
          responseText = tcResult.content;
          toolCalls = tcResult.toolCalls;
        } catch (e) {
          console.warn('[agent-loop] tool-calling nativo falló, usando fallback texto:', e.message);
          try {
            const fallback = await llm(llmMessages, agentPrompt);
            responseText = typeof fallback === 'string' ? fallback : (fallback?.content || '');
          } catch (e2) {
            return {
              response: `Error en tool-calling y fallback textual: ${e2.message}`,
              iterations: i + 1,
              toolResults,
              error: 'llm_failure',
            };
          }
        }
      } else {
        try {
          const raw = await llm(llmMessages, agentPrompt);
          responseText = typeof raw === 'string' ? raw : (raw?.content || '');
        } catch (e) {
          return {
            response: `Error en LLM: ${e.message}`,
            iterations: i + 1,
            toolResults,
            error: 'llm_failure',
          };
        }
      }

      const hasNativeToolCalls = toolCalls && toolCalls.length > 0;
      if (process.env.DEBUG) console.log(`[agent-loop-timing] iter ${i}: LLM ${Date.now() - _itStart}ms, toolCalls=${hasNativeToolCalls ? toolCalls.length : 0}`);
      if (!responseText || !responseText.trim()) {
        // Tool-calling nativo devuelve content vacío cuando el modelo SOLO llama
        // una herramienta — no es un "no respondió", hay que ejecutar la llamada.
        if (!hasNativeToolCalls) {
          return {
            response: 'El modelo no respondió.',
            iterations: i + 1,
            toolResults,
            error: 'empty_response',
          };
        }
        responseText = '';
      }

      lastResponseText = responseText;

      // ── Extraer acciones ───────────────────────────────────────────
      let actions = [];
      if (toolCalls && toolCalls.length > 0) {
        actions = toolCalls.map(tc => ({
          tool: tc.tool,
          params: tc.params,
          description: `${tc.tool}: ${JSON.stringify(tc.params).slice(0, 100)}`,
          source: 'native_tool_call',
        }));
      } else {
        // Contexto = mensaje actual (el prompt original en i=0, el resultado de la
        // herramienta en iteraciones siguientes). Re-usar el prompt original en i>0
        // hace que ActionParser legacy re-detecte el MISMO edit ("edita X") y lo
        // re-ejecute → loop infinito.
        actions = parser.parse(responseText, currentUserMsg, taskIntent);
      }

      if (actions.length === 0) {
        return {
          response: responseText,
          iterations: i + 1,
          toolResults,
          error: null,
        };
      }

      // Normalizar nombres de tool legacy → modernos
      const LEGACY_TO_TOOL = {
        create_file: 'write',
        edit_file: 'edit',
      };
      for (const a of actions) {
        const modern = LEGACY_TO_TOOL[a.tool];
        if (modern) {
          a.tool = modern;
          if (modern === 'write' && a.params.instruction && !a.params.content) {
            a.params.content = a.params.instruction;
            delete a.params.instruction;
          }
          // edit_file → edit: remapear instruction a content para schema LLM
          if (modern === 'edit' && a.params.instruction) {
            a.params.content = a.params.instruction;
            delete a.params.instruction;
          }
        }
      }

      const action = actions[0];
      const requiresApproval = AP.isHighImpact(action.tool, action.params);

      if (requiresApproval && opts.onApprovalNeeded) {
        const approved = await opts.onApprovalNeeded(action);
        if (!approved) {
          iterationHistory.push(
            { role: 'assistant', content: responseText },
            { role: 'user', content: `[Herramienta "${action.tool}" cancelada por el usuario — continúa sin ella o busca otra estrategia]` }
          );
          lastToolResult = { ok: false, error: 'cancelada_por_usuario', tool: action.tool };
          continue;
        }
      } else if (requiresApproval && !opts.onApprovalNeeded) {
        iterationHistory.push(
          { role: 'assistant', content: responseText },
          { role: 'user', content: `[Herramienta "${action.tool}" requiere aprobación pero no hay handler — BLOQUEADA. Continúa sin ella o informa que no puedes ejecutarla.]` }
        );
        lastToolResult = { ok: false, error: 'sin_handler_aprobacion', tool: action.tool };
        continue;
      }

      iterationHistory.push({ role: 'assistant', content: responseText });

      let result;
      try {
        if (GIT_TOOLS.has(action.tool)) {
          result = await this._executeGitTool(action);
        } else if (GITHUB_TOOLS.has(action.tool)) {
          result = await this._executeGitHubTool(action);
        } else if (LSP_TOOLS.has(action.tool)) {
          result = await this._executeLSPTool(action);
        } else if (SUBAGENT_TOOLS.has(action.tool)) {
          result = await this._executeSubagent(action);
        } else {
          result = await this._bridge.execute(action.tool, action.params);
        }
      } catch (e) {
        result = { ok: false, error: e.message, result: null, tool: action.tool, elapsed: 0 };
      }

      result._action = action;
      toolResults.push(result);
      lastToolResult = result;
      if (process.env.DEBUG) console.log(`[agent-loop-timing] iter ${i}: tool=${action.tool} ${Date.now() - _itStart}ms`);

      if (opts.onProgress) {
        opts.onProgress({ iteration: i + 1, tool: action.tool, params: action.params, status: result.ok ? 'ok' : 'error', result: result.ok ? result.result : null, error: result.ok ? null : result.error });
      }

      // ── LSP.1: feedback de diagnósticos tras editar (patrón opencode) ──
      // Cuando una tool que muta archivos tuvo éxito, se sincroniza el cambio
      // en el LSP y se espera el push fresco de diagnósticos; si aparecen
      // errores, se anexan al resumen que ve el LLM en el siguiente turno.
      let lspFeedback = null;
      if (result.ok && EDIT_TOOLS.has(action.tool)) {
        lspFeedback = await this._lspFeedbackForEdit(result, action);
        if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
          result.lspDiagnostics = lspFeedback.diagnostics;
        }
      }

      let resultSummary;
      if (result.ok) {
        resultSummary = this._summarizeResult(result, action);
        if (lspFeedback && lspFeedback.diagnostics && lspFeedback.diagnostics.length > 0) {
          resultSummary += '\n\n' + this._formatDiagnostics(lspFeedback.filePath, lspFeedback.diagnostics);
        }
      } else {
        resultSummary = `[ERROR en ${action.tool}]: ${result.error || 'desconocido'}`;
      }

      console.log(`[agent-loop] iteración ${i + 1}: ${action.tool} → ${result.ok ? 'OK' : 'FALLÓ'}`);
      iterationHistory.push({ role: 'user', content: resultSummary });
    }

    const finalResponse = 'He alcanzado el límite de iteraciones sin completar la tarea. ' +
      'Puedes pedirme que continúe o reformular la instrucción.';

    return {
      response: lastResponseText || finalResponse,
      iterations: this.maxIterations,
      toolResults,
      truncated: true,
      error: 'max_iterations_reached',
    };
  }

  /**
   * LSP.1: tras una edición exitosa, sincroniza el archivo en el LSP y espera
   * el push fresco de diagnósticos (patrón opencode). Devuelve null si no hay
   * LSP activo o la extensión no está soportada (feedback opcional, nunca rompe).
   */
  async _lspFeedbackForEdit(result, action) {
    const params = action.params || {};
    const filePath = params.path || params.filePath;
    if (!filePath || !this._lsp || !this._lsp.isRunning) return null;
    if (typeof this._lsp.supportsFile !== 'function' || !this._lsp.supportsFile(filePath)) return null;
    try {
      const abs = path.resolve(filePath);
      if (!fs.existsSync(abs)) return null;
      const content = fs.readFileSync(abs, 'utf-8');
      await this._lsp.changeDocument(abs, content);
      const diagnostics = await this._lsp.waitForDiagnostics(abs);
      return { filePath: abs, diagnostics: Array.isArray(diagnostics) ? diagnostics : [] };
    } catch (e) {
      console.warn(`[agent-loop] feedback LSP post-edit falló: ${e.message}`);
      return null;
    }
  }

  /** Formatea diagnósticos del LSP para el resumen del turno. */
  _formatDiagnostics(filePath, diagnostics) {
    const errors = diagnostics.filter((d) => d.severity === 1).length;
    const warnings = diagnostics.filter((d) => d.severity === 2).length;
    const shown = diagnostics.slice(0, 10).map((d) => {
      const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
      const line = d.range?.start?.line ?? '?';
      const char = d.range?.start?.character ?? '?';
      return `  - [${sev}] ${line}:${char} ${d.message}${d.code ? ` (${d.code})` : ''}`;
    });
    const count = diagnostics.length;
    const tail = count > 10 ? `\n  ... y ${count - 10} más` : '';
    return `[Diagnósticos LSP de ${filePath} tras la edición: ${count} (${errors} errores, ${warnings} warnings)]\n${shown.join('\n')}${tail}`;
  }

  /**
   * Despacho de tools LSP al LSPManager (get_diagnostics, get_symbols,
   * go_to_definition, find_references, hover, rename, code_actions). Devuelve
   * el mismo shape que el bridge ({ok, result, error, elapsed, tool}) para el
   * resto del loop.
   *
   * Casos informativos en vez de degradación silenciosa:
   *   - LSP no inicializado / ningún server activo → error claro.
   *   - Lenguaje no soportado por los servers activos → error explícito
   *     (en vez de caer al primario y devolver [] del server equivocado).
   */
  async _executeLSPTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const raw = params.raw || {};
    const filePath = params.filePath || params.path || params.ARCHIVO || raw.ARCHIVO || raw.filePath;
    const okShape = (result) => ({ ok: true, result, error: null, tool: action.tool, elapsed: Date.now() - t0 });
    const failShape = (error) => ({ ok: false, result: null, error, tool: action.tool, elapsed: Date.now() - t0 });

    if (!this._lsp) {
      return failShape('LSP no disponible — el LSPManager no está inicializado.');
    }
    if (!this._lsp.isRunning) {
      return failShape('LSP no activo — ningún servidor LSP corriendo para este workspace.');
    }
    if (!filePath) {
      return failShape(`Falta el archivo (filePath) para la tool ${action.tool}.`);
    }
    if (!this._lsp.supportsFile(filePath)) {
      const langs = this._lsp.activeLanguages && this._lsp.activeLanguages.length
        ? this._lsp.activeLanguages.join(', ')
        : 'ninguno';
      return failShape(`El archivo ${filePath} no está soportado por el LSP activo. Servidores activos: ${langs}.`);
    }

    try {
      switch (action.tool) {
        case 'get_diagnostics':
          return okShape(await this._lsp.getDiagnostics(filePath));
        case 'get_symbols':
          return okShape(await this._lsp.getDocumentSymbols(filePath));
        case 'go_to_definition':
          return okShape(await this._lsp.goToDefinition(filePath, params.line, params.character));
        case 'find_references':
          return okShape(await this._lsp.findReferences(filePath, params.line, params.character));
        case 'hover':
          return okShape(await this._lsp.hover(filePath, params.line, params.character));
        case 'rename':
          return okShape(await this._lsp.rename(filePath, params.line, params.character, params.newName));
        case 'code_actions':
          return okShape(await this._lsp.codeActions(filePath, params.line, params.character, params.context));
        default:
          return failShape(`Tool LSP desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  async _executeGitTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    // Default de cwd: parámetro explícito → workspace de la app → raíz del proceso.
    const cwd = params.cwd || params.CWD || process.env.ASISTENTE_WORKSPACE || AP.PROJECT_CWD;
    const okShape = (result) => ({ ok: true, result, error: null, tool: action.tool, elapsed: Date.now() - t0 });
    const failShape = (error) => ({ ok: false, result: null, error, tool: action.tool, elapsed: Date.now() - t0 });

    if (!this._git) {
      return failShape('Git no disponible — el GitManager no está inicializado.');
    }
    try {
      switch (action.tool) {
        case 'git_status':
          return okShape(await this._git.status(cwd));
        case 'git_diff':
          return okShape(await this._git.diff(cwd, { file: params.file, staged: params.staged }));
        case 'git_log':
          return okShape(await this._git.log(cwd, { count: params.count, file: params.file }));
        case 'git_branch':
          return okShape(await this._git.branch(cwd));
        case 'git_commit':
          return okShape(await this._git.commit(cwd, { message: params.message }));
        case 'git_stash':
          return okShape(await this._git.stash(cwd, { action: params.action, message: params.message }));
        case 'git_merge':
          return okShape(await this._git.merge(cwd, { branch: params.branch, message: params.message }));
        case 'git_rebase':
          return okShape(await this._git.rebase(cwd, { branch: params.branch }));
        case 'git_push':
          return okShape(await this._git.push(cwd, { remote: params.remote, branch: params.branch, force: params.force }));
        default:
          return failShape(`Tool git desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  async _executeGitHubTool(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const okShape = (result) => ({ ok: true, result, error: null, tool: action.tool, elapsed: Date.now() - t0 });
    const failShape = (error) => ({ ok: false, result: null, error, tool: action.tool, elapsed: Date.now() - t0 });

    if (!this._github) {
      return failShape('GitHub no disponible — el GitHubManager no está inicializado.');
    }
    if (!(await this._github.hasToken)) {
      return failShape('No hay token de GitHub configurado. Guardalo con KeychainManager.setKey("github_token", "<PAT>").');
    }
    try {
      switch (action.tool) {
        case 'github_repo_info':
          return okShape(await this._github.repoInfo(params.repo));
        case 'github_issue_list':
          return okShape(await this._github.issueList(params.repo, { state: params.state, limit: params.limit }));
        case 'github_issue_create':
          return okShape(await this._github.issueCreate(params.repo, { title: params.title, body: params.body, labels: params.labels }));
        case 'github_issue_comment':
          return okShape(await this._github.issueComment(params.repo, { issue_number: params.issue_number, body: params.body }));
        case 'github_issue_close':
          return okShape(await this._github.issueClose(params.repo, { issue_number: params.issue_number }));
        case 'github_pr_list':
          return okShape(await this._github.prList(params.repo, { state: params.state, limit: params.limit }));
        case 'github_pr_create':
          return okShape(await this._github.prCreate(params.repo, { title: params.title, head: params.head, base: params.base, body: params.body }));
        case 'github_pr_review':
          return okShape(await this._github.prReview(params.repo, { pull_number: params.pull_number, event: params.event, body: params.body }));
        case 'github_actions_status':
          return okShape(await this._github.actionsStatus(params.repo, { limit: params.limit }));
        default:
          return failShape(`Tool github desconocida: ${action.tool}`);
      }
    } catch (e) {
      return failShape(e.message);
    }
  }

  /**
   * §11: lanza un subagente autónomo (AgentLoop anidado) para resolver una
   * sub-tarea de forma independiente. Devuelve el resumen final del subagente.
   */
  async _executeSubagent(action) {
    const t0 = Date.now();
    const params = action.params || {};
    const task = params.task || params.description || '';
    if (!task) {
      return { ok: false, error: 'task (descripción) requerida', result: null, tool: action.tool, elapsed: 0 };
    }

    const depth = this._subagentDepth || 0;
    if (depth >= MAX_SUBAGENT_DEPTH) {
      return { ok: false, error: `profundidad máxima de subagentes alcanzada (${MAX_SUBAGENT_DEPTH})`, result: null, tool: action.tool, elapsed: 0 };
    }

    const maxIters = Math.min(params.max_iterations || 8, 15);
    let nested;
    try {
      nested = new AgentLoop({
        bridge: this._bridge,
        llm: this._llm,
        lsp: this._lsp,
        git: this._git,
        github: this._github,
        mode: this._mode,
        maxIterations: maxIters,
      });
      nested._subagentDepth = depth + 1;
    } catch (e) {
      return { ok: false, error: `no se pudo crear el subagente: ${e.message}`, result: null, tool: action.tool, elapsed: 0 };
    }

    const subTask = params.context
      ? `${task}\n\nContexto adicional:\n${params.context}`
      : task;

    try {
      const out = await nested.run(subTask, SUBAGENT_SYSTEM, [], {
        llm: this._llm,
        taskIntent: this._currentTaskIntent || null,
        onProgress: null,
      });
      const toolCalls = (out.toolResults || []).map(r => `${r.tool}:${r.ok ? 'ok' : 'err'}`);
      return {
        ok: true,
        result: {
          response: out.response,
          iterations: out.iterations,
          truncated: !!out.truncated,
          error: out.error || null,
          toolCalls,
        },
        tool: action.tool,
        elapsed: Math.round((Date.now() - t0) / 1000),
      };
    } catch (e) {
      return { ok: false, error: `subagente falló: ${e.message}`, result: null, tool: action.tool, elapsed: Math.round((Date.now() - t0) / 1000) };
    }
  }

  _buildToolResultMessage(lastResult) {
    if (!lastResult) return null;

    const summary = this._summarizeResult(lastResult);
    if (lastResult.ok) {
      return `[Resultado de herramienta "${lastResult.tool}"]:\n${summary}`;
    }
    return `[ERROR en herramienta "${lastResult.tool}"]: ${lastResult.error || 'desconocido'}\n\nContinúa con otra estrategia o avísame si no puedes completar la tarea.`;
  }

  /**
   * G.1: compactación de contexto. Devuelve los mensajes que verá el LLM en la
   * iteración i:
   *   - el objetivo original siempre está presente,
   *   - si la historia creció, los turnos viejos se condensan en un resumen
   *     determinista (objetivo + acciones ejecutadas hasta ahora),
   *   - los últimos COMPACT_KEEP_TAIL turnos se conservan íntegros (para que el
   *     LLM tenga el estado reciente real, no un resumen),
   *   - y se anexa el mensaje de resultado de la última tool.
   */
  _buildLLMMessages(iterationHistory, currentUserMsg, userMessage, toolResults, iteration) {
    const msgs = [{ role: 'user', content: userMessage }];

    if (iterationHistory.length >= COMPACT_MIN_TURNS && iterationHistory.length - COMPACT_KEEP_TAIL > 0) {
      const keep = iterationHistory.slice(-COMPACT_KEEP_TAIL);
      const compacted = this._compactSummary(userMessage, toolResults, iterationHistory.length - COMPACT_KEEP_TAIL);
      if (compacted) msgs.push({ role: 'user', content: compacted });
      msgs.push(...keep);
      // §12: persistir una vez por run el resumen de compactación en memoria
      // vectorial para poder reconstruir contexto en sesiones futuras.
      this._rememberCompaction(userMessage, toolResults, iterationHistory.length - COMPACT_KEEP_TAIL);
    } else {
      msgs.push(...iterationHistory);
    }

    if (currentUserMsg) msgs.push({ role: 'user', content: currentUserMsg });
    return msgs;
  }

  /** Resumen determinista de lo hecho hasta ahora (para la compactación). */
  _compactSummary(userMessage, toolResults, droppedTurns) {
    const actions = (toolResults || []).map((t) => {
      const ok = t.ok ? 'OK' : `FALLÓ: ${t.error || ''}`;
      const params = t._action?.params || {};
      const brief = Object.entries(params)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
        .join(' ');
      return `  - ${t.tool} (${ok})${brief ? ' · ' + brief : ''}`;
    }).join('\n') || '  (ninguna todavía)';

    return [
      `[RESUMEN DE LO HECHO HASTA AHORA — ${droppedTurns} turnos anteriores condensados para ahorrar contexto]`,
      `Objetivo original: ${String(userMessage).slice(0, 200)}`,
      `Acciones ejecutadas:\n${actions}`,
      'Continúa desde este punto; no repitas acciones ya completadas.',
    ].join('\n');
  }

  /**
   * §12: persiste una vez por run el resumen de compactación como un nodo
   * Episode (memoria vectorial) para reconstruir contexto en sesiones largas
   * o retomadas. Best-effort: nunca rompe el loop si falla.
   */
  _rememberCompaction(userMessage, toolResults, droppedTurns) {
    if (!this._graph || this._compactionPersisted) return;
    try {
      const summary = this._compactSummary(userMessage, toolResults, droppedTurns);
      const label = `Contexto compactado: ${String(userMessage).slice(0, 80)}`;
      const existing = this._graph._findNodesByLabel
        ? this._graph._findNodesByLabel(label)
        : [];
      if (Array.isArray(existing) && existing.length > 0) {
        this._graph.updateNode(existing[0].id, { content: summary });
      } else {
        this._graph.createNode({
          type: 'Episode',
          label,
          content: summary,
          importance: 0.7,
          tags: ['context-compaction'],
        });
      }
      this._compactionPersisted = true;
    } catch (e) {
      console.warn(`[agent-loop] persistir compactación falló: ${e.message}`);
    }
  }

  /**
   * §12: recall semántico de episodios de compactación previos relevantes al
   * objetivo actual. Devuelve un bloque de texto para inyectar al prompt.
   */
  async _recallMemory(userMessage) {
    if (!this._graph || !userMessage) return null;
    try {
      const episodes = await this._graph.queryNodesSemantic(userMessage, {
        type: 'Episode',
        limit: 3,
        includeArchived: false,
      });
      const relevant = (episodes || []).filter((n) => {
        let tags = [];
        try { tags = JSON.parse(n.tags || '[]'); } catch {}
        return tags.includes('context-compaction');
      });
      if (relevant.length === 0) return null;

      const lines = relevant.map((n, i) => {
        const sim = n._similarity != null ? ` (similitud ${n._similarity.toFixed(2)})` : '';
        return `[Contexto ${i + 1} de memoria${sim}]\n${String(n.content).slice(0, 800)}`;
      });
      return [
        '# CONTEXTO RELEVANTE DE MEMORIA (sesiones previas)',
        'Usa esto si la tarea actual continúa o se relaciona con trabajo anterior:',
        ...lines,
      ].join('\n');
    } catch (e) {
      console.warn(`[agent-loop] recall de memoria falló: ${e.message}`);
      return null;
    }
  }

  _summarizeResult(result) {
    const raw = result.result;
    if (raw === null || raw === undefined) return 'Sin resultado.';

    if (typeof raw === 'string') {
      if (raw.length <= RESULT_TRUNCATE_LIMIT) return raw;
      return raw.slice(0, RESULT_TRUNCATE_LIMIT) + `\n\n[... resultado truncado: ${raw.length} caracteres totales]`;
    }

    if (typeof raw === 'object') {
      if (raw.stdout !== undefined) {
        const stdout = (raw.stdout || '').trim();
        const stderr = (raw.stderr || '').trim();
        let summary = '';
        if (stdout) {
          summary += stdout.length <= RESULT_TRUNCATE_LIMIT ? stdout : stdout.slice(0, RESULT_TRUNCATE_LIMIT) + `\n[... stdout truncado: ${stdout.length} chars]`;
        }
        if (stderr) {
          summary += (summary ? '\n' : '') + (stderr.length <= (RESULT_TRUNCATE_LIMIT / 2) ? stderr : stderr.slice(0, (RESULT_TRUNCATE_LIMIT / 2)) + `\n[... stderr truncado]`);
        }
        if (raw.exitCode !== undefined && raw.exitCode !== 0) {
          summary += `\n[exit code: ${raw.exitCode}]`;
        }
        return summary || `[Comando ejecutado, sin salida]`;
      }
      const str = JSON.stringify(raw, null, 2);
      return str.length <= RESULT_TRUNCATE_LIMIT ? str : str.slice(0, RESULT_TRUNCATE_LIMIT) + `\n[... truncado: ${str.length} chars]`;
    }

    return String(raw).slice(0, RESULT_TRUNCATE_LIMIT);
  }
}

module.exports = { AgentLoop, MAX_ITERATIONS };
