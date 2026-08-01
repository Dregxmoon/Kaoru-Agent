'use strict';

const { getOpenClawBridge } = require('./OpenClawBridge.js');
const { getStructuredActionParser } = require('./StructuredActionParser.js');
const AP = require('./ActionParser.js');
const LLMProvider = require('../llm/LLMProvider.js');
const { getToolRegistry } = require('../task/ToolRegistry.js');

const VALID_MODES = new Set(['smart', 'fast', 'task', 'conversational']);

const MAX_ITERATIONS = 25;
const RESULT_TRUNCATE_LIMIT = 800;

const AGENT_LOOP_SYSTEM = `
# MODO AGENTE — BUCLE DE EJECUCIÓN

Estás operando en un bucle agente: puedes solicitar una herramienta por vez
y recibirás el resultado real antes de decidir el siguiente paso.

## Cómo solicitar una herramienta

Usa este formato EXACTO dentro de tu respuesta:

\`\`\`action
ACCIÓN: <nombre> | ARCHIVO/COMANDO/QUERY/URL: <valor>
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
      const currentUserMsg = i === 0
        ? userMessage
        : this._buildToolResultMessage(lastToolResult);

      const llmMessages = [...iterationHistory];
      if (currentUserMsg) {
        llmMessages.push({ role: 'user', content: currentUserMsg });
      }

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
        actions = parser.parse(responseText, userMessage, taskIntent);
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
        result = await this._bridge.execute(action.tool, action.params);
      } catch (e) {
        result = { ok: false, error: e.message, result: null, tool: action.tool, elapsed: 0 };
      }

      result._action = action;
      toolResults.push(result);
      lastToolResult = result;

      if (opts.onProgress) {
        opts.onProgress({ iteration: i + 1, tool: action.tool, params: action.params, status: result.ok ? 'ok' : 'error', result: result.ok ? result.result : null, error: result.ok ? null : result.error });
      }

      const resultSummary = result.ok
        ? this._summarizeResult(result, action)
        : `[ERROR en ${action.tool}]: ${result.error || 'desconocido'}`;

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

  _buildToolResultMessage(lastResult) {
    if (!lastResult) return null;

    const summary = this._summarizeResult(lastResult);
    if (lastResult.ok) {
      return `[Resultado de herramienta "${lastResult.tool}"]:\n${summary}`;
    }
    return `[ERROR en herramienta "${lastResult.tool}"]: ${lastResult.error || 'desconocido'}\n\nContinúa con otra estrategia o avísame si no puedes completar la tarea.`;
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
