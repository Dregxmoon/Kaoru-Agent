'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ${C.green('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${C.red('✗')} ${label}`);
    if (detail) console.log(`    ${C.dim(detail)}`);
    failed++;
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-test-'));
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ key: 'value' }), 'utf-8');
  return tmpDir;
}

function teardown() {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    tmpDir = null;
  }
}

// ── Mock LLM ──────────────────────────────────────────────────────────────────

function createMockLLM(responses) {
  let callCount = 0;
  const fn = async (messages, systemPrompt) => {
    if (callCount >= responses.length) {
      return 'Tarea completada.';
    }
    return responses[callCount++];
  };
  fn.callCount = () => callCount;
  fn.reset = () => {
    callCount = 0;
  };
  return fn;
}

// ── Mock Bridge (opera directo sobre FS para no depender de OpenClaw) ────────

function createMockBridge(projectCwd) {
  return {
    execute: async (tool, params) => {
      const t0 = Date.now();
      try {
        switch (tool) {
          case 'read': {
            const p = params.path;
            if (!fs.existsSync(p)) {
              return {
                ok: false,
                error: `File not found: ${p}`,
                result: null,
                tool,
                elapsed: Date.now() - t0,
              };
            }
            const content = fs.readFileSync(p, 'utf-8');
            return { ok: true, result: content, error: null, tool, elapsed: Date.now() - t0 };
          }
          case 'write':
          case 'create_file': {
            const p = params.path;
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const content = params.content || `Archivo creado: ${path.basename(p)}`;
            fs.writeFileSync(p, content, 'utf-8');
            return {
              ok: true,
              result: `Written to ${p}`,
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          case 'exec':
          case 'run_command': {
            const cmd = params.command || '';
            return {
              ok: true,
              result: { stdout: `[mock] ${cmd} ejecutado`, stderr: '', exitCode: 0 },
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          case 'edit':
          case 'edit_file': {
            const p = params.path;
            if (!fs.existsSync(p)) {
              return {
                ok: false,
                error: `File not found: ${p}`,
                result: null,
                tool,
                elapsed: Date.now() - t0,
              };
            }
            const content = fs.readFileSync(p, 'utf-8');
            const oldText = params.old_text || params.instruction || '';
            const newText = params.new_text || '';
            if (oldText && content.includes(oldText)) {
              const updated = content.replace(oldText, newText);
              fs.writeFileSync(p, updated, 'utf-8');
              return {
                ok: true,
                result: `Edited ${p}`,
                error: null,
                tool,
                elapsed: Date.now() - t0,
              };
            }
            return {
              ok: true,
              result: `File ${p} unchanged (no matching text)`,
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
          }
          default:
            return {
              ok: true,
              result: `[mock] ${tool} ejecutado`,
              error: null,
              tool,
              elapsed: Date.now() - t0,
            };
        }
      } catch (e) {
        return { ok: false, error: e.message, result: null, tool, elapsed: Date.now() - t0 };
      }
    },
  };
}

// ── Mock MCP Manager (catálogo + callTool sobre FS) ──────────────────────────

function createMockMCP(projectCwd) {
  const calls = [];
  const tools = [
    {
      server: 'filesystem',
      serverId: 'filesystem-1',
      tool: 'write_file',
      description: 'Escribe un archivo',
      inputSchema: {
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    {
      server: 'filesystem',
      serverId: 'filesystem-1',
      tool: 'list_directory',
      description: 'Lista un directorio',
      inputSchema: { properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];
  return {
    tools,
    calls,
    listAllTools: () => tools,
    callTool: async (server, tool, args) => {
      calls.push({ server, tool, args });
      if (server !== 'filesystem') throw new Error(`servidor no conectado: ${server}`);
      if (tool === 'write_file') {
        const dir = path.dirname(args.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content || '', 'utf-8');
        return { content: [{ type: 'text', text: `Escrito ${args.path}` }] };
      }
      if (tool === 'list_directory') {
        const entries = fs.readdirSync(args.path || projectCwd).join('\n');
        return { content: [{ type: 'text', text: entries }] };
      }
      throw new Error(`tool no soportada por el mock: ${tool}`);
    },
  };
}

// ToolResolver mock que reporta precedencia MCP (Skill > MCP > OpenClaw).
function createMCPPrecedenceResolver() {
  return {
    resolveToolset: async () => ({
      precedence: 'mcp',
      nativeToolSchemas: [
        { name: 'write_file', description: 'Escribe un archivo', parameters: {} },
      ],
      promptCatalog:
        '# HERRAMIENTAS DISPONIBLES\n\n## Herramientas MCP\n  Servidor: filesystem\n    - write_file — Escribe un archivo',
      excluded: [],
      matchedSkills: [],
    }),
  };
}

// ── Test 1: Loop termina en respuesta de texto ────────────────────────────────

async function testTextResponse() {
  console.log(C.bold('\n── Test 1: Loop termina en respuesta de texto ─────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const mockLLM = createMockLLM([
    'El archivo config.json contiene una clave "key" con el valor "value".',
  ]);

  const loop = new AgentLoop({ maxIterations: 10, llm: mockLLM, bridge: createMockBridge('/tmp') });

  const result = await loop.run('¿Qué hay en config.json?', 'Eres un asistente útil.', [], {});

  assert(result.iterations === 1, 'Termina en 1 iteración', `iteraciones: ${result.iterations}`);
  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error', `error: ${result.error}`);
  assert(
    result.response.includes('config.json'),
    'Respuesta contiene el texto esperado',
    result.response.slice(0, 100)
  );
}

// ── Test 2: Loop se adapta al resultado real (archivo no existe → create) ─────

async function testAdaptsToRealResult() {
  console.log(C.bold('\n── Test 2: Loop se adapta al resultado real de un paso ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = setup();
  AP.setProjectCWD(projectCwd);

  const nonExistentPath = path.join(projectCwd, 'no-existe.json');

  const mockLLM = createMockLLM([
    `Revisando el archivo...
\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${nonExistentPath}
\`\`\``,
    `El archivo no existe, lo creo.
\`\`\`action
ACCIÓN: create_file | ARCHIVO: ${path.join(projectCwd, 'nuevo.json')}
\`\`\``,
  ]);

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createMockBridge(projectCwd),
  });

  const result = await loop.run(
    'crea config.json si no existe',
    'Eres un asistente que gestiona archivos.',
    [],
    { onApprovalNeeded: async () => true }
  );

  assert(
    result.iterations === 3,
    'Ejecuta 3 iteraciones (read + create + texto final)',
    `iteraciones: ${result.iterations}`
  );
  assert(
    result.toolResults.length === 2,
    'Dos herramientas ejecutadas',
    `tools: ${result.toolResults.length}`
  );

  const firstTool = result.toolResults[0];
  assert(firstTool.tool === 'read', 'Primera tool: read', `tool: ${firstTool.tool}`);
  assert(
    !firstTool.ok,
    'Primera tool falla (archivo no existe)',
    firstTool.error ? firstTool.error.slice(0, 80) : ''
  );

  const secondTool = result.toolResults[1];
  assert(
    secondTool.tool === 'write',
    'Segunda tool: write (normalizado de create_file)',
    `tool: ${secondTool.tool} — verifica que el LLM adaptó su decisión al resultado real`
  );
  assert(secondTool.ok, 'Segunda tool tiene éxito', secondTool.error || '');

  const createdFile = path.join(projectCwd, 'nuevo.json');
  assert(fs.existsSync(createdFile), 'El archivo fue creado en disco');

  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error');

  teardown();
}

// ── Test 3: Límite de iteraciones ─────────────────────────────────────────────

async function testMaxIterations() {
  console.log(C.bold('\n── Test 3: Límite de iteraciones no es infinito ───────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  // Mock LLM que SIEMPRE pide una herramienta (nunca texto final)
  const alwaysTool = `\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${path.join(projectCwd, 'nonexistent.txt')}
\`\`\``;
  const mockLLM = createMockLLM([alwaysTool, alwaysTool, alwaysTool, alwaysTool, alwaysTool]);

  const loop = new AgentLoop({
    maxIterations: 3,
    llm: mockLLM,
    bridge: createMockBridge(projectCwd),
  });

  const result = await loop.run('ejecuta herramientas sin parar', 'Eres un asistente.', [], {});

  assert(result.truncated === true, 'Resultado marcado como truncado');
  assert(result.iterations <= 3, `Iteraciones respetan límite: ${result.iterations} <= 3`);
  assert(
    result.error === 'max_iterations_reached',
    `Error es max_iterations_reached`,
    `error: ${result.error}`
  );

  teardown();
}

// ── Test 4: Aprobación rechazada no rompe el loop ────────────────────────────

async function testApprovalRejected() {
  console.log(C.bold('\n── Test 4: Aprobación rechazada no rompe el loop ──────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const testFilePath = path.join(projectCwd, 'test-aprobacion.txt');

  let approvalCalls = 0;
  let rejectedTool = null;
  let approvedTool = null;

  const approvalHandler = async (step) => {
    approvalCalls++;
    if (step.tool === 'exec') {
      rejectedTool = step.tool;
      return false;
    }
    approvedTool = step.tool;
    return true;
  };

  const mockLLM = createMockLLM([
    `Voy a ejecutar esto.
\`\`\`action
ACCIÓN: run_command | COMANDO: rm -rf /
\`\`\``,
    `Ahora creo el archivo.
\`\`\`action
ACCIÓN: create_file | ARCHIVO: ${testFilePath}
\`\`\``,
  ]);

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createMockBridge(projectCwd),
  });

  const result = await loop.run('prueba de aprobación', 'Eres un asistente.', [], {
    onApprovalNeeded: approvalHandler,
  });

  assert(
    approvalCalls === 1,
    'Handler de aprobación llamado 1 vez (solo exec, write no requiere aprobación)',
    `veces: ${approvalCalls}`
  );
  assert(rejectedTool === 'exec', 'La primera tool (exec) fue rechazada');
  assert(approvedTool === null, 'write normalizado no requiere aprobación (path interno)');
  assert(
    result.toolResults.length === 1,
    'Solo 1 herramienta ejecutada (write pasó directo)',
    `tools: ${result.toolResults.length}`
  );
  assert(
    result.toolResults[0].tool === 'write',
    'La ejecutada es write (normalizado de create_file)'
  );
  assert(result.toolResults[0].ok, 'write se ejecuta correctamente');
  assert(fs.existsSync(testFilePath), 'Archivo de prueba creado');

  teardown();
}

// ── Test 5: Sin callback de aprobación → fail closed ──────────────────────────

async function testNoApprovalCallback() {
  console.log(C.bold('\n── Test 5: Sin callback de aprobación → fail closed ────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const testFilePath = path.join(projectCwd, 'no-deberia-existir.txt');

  const mockLLM = createMockLLM([
    `Aplicando patch...
\`\`\`action
ACCIÓN: apply_patch | ARCHIVO: ${testFilePath}
\`\`\``,
    `Tarea completada.`,
  ]);

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createMockBridge(projectCwd),
  });

  // Sin onApprovalNeeded → apply_patch es highImpact → fail closed
  const result = await loop.run(
    'aplica un patch',
    'Eres un asistente.',
    [],
    {} // sin onApprovalNeeded
  );

  assert(
    result.toolResults.length === 0,
    'Ninguna herramienta se ejecutó (fail closed)',
    `tools: ${result.toolResults.length}`
  );
  assert(!fs.existsSync(testFilePath), 'El archivo NO fue creado (apply_patch bloqueado)');

  // El loop debió continuar y eventualmente terminar con texto normal
  assert(!result.truncated, 'No está truncado');
  assert(!result.error, 'Sin error');

  teardown();
}

// ── Test 6: Iteración ejecuta bridge real contra directorio temporal ──────────

async function testBridgeExecution() {
  console.log(C.bold('\n── Test 6: Bridge real contra directorio temporal ─────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  // Crear archivo de prueba
  const testFile = path.join(projectCwd, 'prueba.txt');
  fs.writeFileSync(testFile, 'contenido de prueba', 'utf-8');

  const mockLLM = createMockLLM([
    `Leyendo archivo...
\`\`\`action
ACCIÓN: read_file | ARCHIVO: ${testFile}
\`\`\``,
    `El archivo contiene: contenido de prueba.`,
  ]);

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createMockBridge(projectCwd),
  });

  const result = await loop.run('lee el archivo de prueba', 'Eres un asistente.', [], {});

  assert(result.iterations === 2, '2 iteraciones (read + texto)');
  assert(result.toolResults.length === 1, '1 herramienta ejecutada');
  assert(result.toolResults[0].ok, 'read_file tuvo éxito');
  assert(result.toolResults[0].tool === 'read', 'Tool es read');

  // Verificar que el resultado incluye el contenido real
  const resultStr =
    typeof result.toolResults[0].result === 'string'
      ? result.toolResults[0].result
      : JSON.stringify(result.toolResults[0].result);
  assert(
    resultStr.includes('contenido de prueba'),
    'Resultado contiene el contenido real del archivo',
    resultStr.slice(0, 100)
  );

  teardown();
}

// ── Test 7: Tool-call nativo con content vacío NO es "el modelo no respondió" ──

async function testNativeToolCallEmptyContent() {
  console.log(C.bold('\n── Test 7: Tool-call nativa con content vacío se ejecuta ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const testFile = path.join(projectCwd, 'greeting.txt');
  fs.writeFileSync(testFile, 'contenido de greeting', 'utf-8');

  // Caso real: llama-3.3-70b con tools devuelve { content: null, toolCalls: [...] }.
  // El loop abortaba con "El modelo no respondió." en vez de ejecutar la llamada.
  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls === 1) {
      return { content: null, toolCalls: [{ tool: 'read', params: { path: testFile } }] };
    }
    return { content: 'Tarea completada.', toolCalls: null };
  };

  try {
    const mockLLM = createMockLLM(['no se usa']);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(projectCwd),
    });

    const result = await loop.run('hola', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'read',
          description: 'lee un archivo',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    assert(
      calls === 2,
      'completeWithTools llamado 2 veces (tool call + cierre)',
      `llamadas: ${calls}`
    );
    assert(
      result.toolResults.length === 1,
      'La tool call nativa se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(result.toolResults[0].tool === 'read', 'Tool ejecutada: read');
    assert(result.toolResults[0].ok, 'read tuvo éxito', result.toolResults[0].error || '');
    assert(!result.error, 'Sin error "empty_response"', `error: ${result.error}`);
    assert(
      result.response.includes('Tarea completada'),
      'Respuesta final es el texto de cierre',
      result.response.slice(0, 60)
    );
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 7a: tool-call nativo con alias legacy (run_command) se normaliza ────
// Caso real de producción: Groq emitió { tool: 'run_command' } en un tool-call
// nativo y el loop falló con "Herramienta desconocida: run_command" → el run
// terminaba en "El modelo no respondió.". El alias debe resolverse a 'exec'.

async function testNativeToolCallAlias() {
  console.log(C.bold('\n── Test 7a: tool-call nativo run_command → exec ────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let calls = 0;
  let dispatchedTool = null;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls === 1) {
      return {
        content: null,
        toolCalls: [{ tool: 'run_command', params: { command: 'echo hi' } }],
      };
    }
    return { content: 'Listo.', toolCalls: null };
  };

  try {
    const mockLLM = createMockLLM(['no se usa']);
    const bridge = createMockBridge(projectCwd);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge,
    });

    const result = await loop.run('corre un comando', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'exec',
          description: 'ejecuta un comando',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    dispatchedTool = result.toolResults[0]?.tool;
    assert(
      result.toolResults.length === 1,
      'El tool-call nativo se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(
      dispatchedTool === 'exec',
      'run_command se normalizó a exec',
      `tool despachada: ${dispatchedTool}`
    );
    assert(result.toolResults[0].ok, 'exec tuvo éxito', result.toolResults[0].error || '');
    assert(!result.error, 'Sin error "empty_response"', `error: ${result.error}`);
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 7b: fallo de LLM en iter > 0 conserva tools completadas ────────────

async function testLLMFailureKeepsCompletedTools() {
  console.log(C.bold('\n── Test 7b: fallo de LLM en iter>0 conserva tools completadas ─────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const outFile = path.join(projectCwd, 'salida.txt');

  // Iter 1: la tool write se ejecuta con éxito. Iter 2: el LLM falla en
  // tool-calling nativo Y en el fallback textual → el response debe incluir
  // tanto la confirmación de la tool exitosa como el aviso de error.
  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls === 1) {
      return {
        content: null,
        toolCalls: [{ tool: 'write', params: { path: outFile, content: 'hecho' } }],
      };
    }
    throw new Error('todos los proveedores caídos');
  };

  const failingLLM = async () => {
    throw new Error('fallback textual caído');
  };

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: failingLLM,
      bridge: createMockBridge(projectCwd),
    });

    const result = await loop.run('creá salida.txt', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'write',
          description: 'escribe un archivo',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    assert(result.error === 'llm_failure', 'error = llm_failure', `error: ${result.error}`);
    assert(
      result.toolResults.length === 1,
      'la tool de la iter 1 se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(result.toolResults[0].tool === 'write', 'tool ejecutada: write');
    assert(result.toolResults[0].ok, 'write tuvo éxito', result.toolResults[0].error || '');
    assert(
      result.response.includes('Llegué a completar esto'),
      'response incluye el resumen de lo ya logrado',
      result.response
    );
    assert(
      result.response.includes('✓ write'),
      'response menciona la tool exitosa',
      result.response
    );
    assert(
      result.response.includes('No pude continuar'),
      'response incluye el aviso de error',
      result.response
    );
    assert(
      result.response.includes('fallback textual caído'),
      'response conserva el mensaje de la excepción',
      result.response
    );
    assert(
      result.response.indexOf('✓ write') < result.response.indexOf('No pude continuar'),
      'el éxito aparece antes que el aviso de error',
      result.response
    );
    assert(
      fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf-8') === 'hecho',
      'el archivo de la tool exitosa quedó escrito en disco'
    );
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 7c: precedencia mcp + tool-calling nativo caído → MCP_TOOL en texto ─

async function testMCPToolTextFallback() {
  console.log(C.bold('\n── Test 7c: precedencia mcp, tool-calling nativo caído → MCP_TOOL ─'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const outFile = path.join(projectCwd, 'calc.py');

  // Escenario exacto del bug: precedencia mcp (mcpManager + toolResolver),
  // completeWithTools falla en todos los providers, y el modelo cae al
  // formato de texto estructurado usando MCP_TOOL: filesystem.write_file.
  const originalCompleteWithTools = LLMProvider.completeWithTools;
  LLMProvider.completeWithTools = async () => {
    throw new Error('todos los proveedores caídos');
  };

  const mockMCP = createMockMCP(projectCwd);
  const mockLLM = createMockLLM([
    `Creo el archivo con el servidor filesystem.
\`\`\`action
MCP_TOOL: filesystem.write_file | ARCHIVO: ${outFile}
CONTENIDO: print("hola")
\`\`\``,
    'Listo, archivo creado.',
  ]);

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(projectCwd),
      mcpManager: mockMCP,
    });

    const result = await loop.run('creá un archivo calc.py', 'Eres un asistente.', [], {
      tools: [{ name: 'write_file', description: 'Escribe un archivo', parameters: {} }],
      toolResolver: createMCPPrecedenceResolver(),
      onApprovalNeeded: async () => true,
    });

    assert(!result.error, 'Sin error', `error: ${result.error}`);
    assert(
      result.toolResults.length === 1,
      'la tool MCP se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(
      result.toolResults[0].tool === 'mcp:filesystem:write_file',
      'resultado vía MCPManager (no OpenClawBridge)',
      result.toolResults[0].tool
    );
    assert(result.toolResults[0].ok, 'write_file tuvo éxito', result.toolResults[0].error || '');
    assert(mockMCP.calls.length === 1, 'callTool llamado 1 vez', `calls: ${mockMCP.calls.length}`);
    assert(
      mockMCP.calls[0].server === 'filesystem' && mockMCP.calls[0].tool === 'write_file',
      'callTool(server="filesystem", tool="write_file")',
      JSON.stringify(mockMCP.calls[0])
    );
    assert(
      mockMCP.calls[0].args.path === outFile && mockMCP.calls[0].args.content === 'print("hola")',
      'args MCP mapeados desde ARCHIVO/CONTENIDO',
      JSON.stringify(mockMCP.calls[0].args)
    );
    assert(
      fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf-8') === 'print("hola")',
      'el archivo quedó escrito en disco por la tool MCP'
    );
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 7d: mcp_call clásico (SERVIDOR/HERRAMIENTA/PARAMS) va a MCPManager ──

async function testMCPCallClassicRouting() {
  console.log(C.bold('\n── Test 7d: mcp_call clásico se enruta a MCPManager ─────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  const originalCompleteWithTools = LLMProvider.completeWithTools;
  LLMProvider.completeWithTools = async () => {
    throw new Error('proveedores caídos');
  };

  const mockMCP = createMockMCP(projectCwd);
  const mockLLM = createMockLLM([
    `Voy a listar el directorio del proyecto.
\`\`\`action
ACCIÓN: mcp_call | SERVIDOR: filesystem | HERRAMIENTA: list_directory | PARAMS: {"path": "${projectCwd}"}
\`\`\``,
    'Listado listo.',
  ]);

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(projectCwd),
      mcpManager: mockMCP,
    });

    const result = await loop.run('listá el directorio del proyecto', 'Eres un asistente.', [], {
      tools: [{ name: 'list_directory', description: 'Lista un directorio', parameters: {} }],
      toolResolver: createMCPPrecedenceResolver(),
      onApprovalNeeded: async () => true,
    });

    assert(!result.error, 'Sin error', `error: ${result.error}`);
    assert(
      result.toolResults.length === 1,
      'la tool MCP se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(
      result.toolResults[0].ok,
      'list_directory tuvo éxito',
      result.toolResults[0].error || ''
    );
    assert(
      result.toolResults[0].tool === 'mcp:filesystem:list_directory',
      'resultado vía MCPManager',
      result.toolResults[0].tool
    );
    assert(
      mockMCP.calls.length === 1 &&
        mockMCP.calls[0].server === 'filesystem' &&
        mockMCP.calls[0].tool === 'list_directory',
      'callTool(server, tool) correcto',
      JSON.stringify(mockMCP.calls[0])
    );
    assert(
      mockMCP.calls[0].args.path === projectCwd,
      'PARAMS JSON llegó como args',
      JSON.stringify(mockMCP.calls[0].args)
    );
    assert(
      result.response.includes('Listado listo.'),
      'response final es el cierre del LLM',
      result.response
    );
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 7e: tool MCP inexistente → error claro, no "Herramienta desconocida" ─

async function testMCPUnknownToolClearError() {
  console.log(C.bold('\n── Test 7e: tool MCP inexistente → error claro con catálogo ──────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const outFile = path.join(projectCwd, 'x.txt');

  const originalCompleteWithTools = LLMProvider.completeWithTools;
  LLMProvider.completeWithTools = async () => {
    throw new Error('proveedores caídos');
  };

  const mockMCP = createMockMCP(projectCwd);
  const mockLLM = createMockLLM([
    `\`\`\`action
MCP_TOOL: filesystem.herramienta_inexistente | ARCHIVO: ${outFile}
\`\`\``,
    'No pude ejecutar esa herramienta.',
  ]);

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(projectCwd),
      mcpManager: mockMCP,
    });

    const result = await loop.run('escribí x.txt', 'Eres un asistente.', [], {
      tools: [{ name: 'write_file', description: 'Escribe', parameters: {} }],
      toolResolver: createMCPPrecedenceResolver(),
      onApprovalNeeded: async () => true,
    });

    assert(
      result.toolResults.length === 1,
      'la tool falló pero quedó registrada',
      `tools: ${result.toolResults.length}`
    );
    assert(!result.toolResults[0].ok, 'la tool MCP inexistente falla');
    assert(
      result.toolResults[0].error.includes('no existe en el catálogo'),
      'error claro de tool no existente',
      result.toolResults[0].error
    );
    assert(
      result.toolResults[0].error.includes('filesystem.herramienta_inexistente'),
      'menciona el nombre exacto que escribió el modelo',
      result.toolResults[0].error
    );
    assert(
      result.toolResults[0].error.includes('filesystem.write_file'),
      'lista las tools disponibles del catálogo',
      result.toolResults[0].error
    );
    assert(
      !result.toolResults[0].error.includes('Herramienta desconocida: mcp'),
      'NO cae en el error genérico de OpenClawBridge',
      result.toolResults[0].error
    );
    assert(mockMCP.calls.length === 0, 'callTool nunca se llama con una tool inexistente');
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 8: múltiples tools por iteración (native tool calls) ────────────────

async function testMultiToolPerIteration() {
  console.log(C.bold('\n── Test 8: todas las tools de una respuesta se ejecutan ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');
  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);
  const srcFile = path.join(projectCwd, 'a.txt');
  const outFile = path.join(projectCwd, 'b.txt');
  fs.writeFileSync(srcFile, 'AAA', 'utf-8');

  // Una sola respuesta del modelo con DOS tool calls → ambas deben ejecutarse
  // en la misma iteración (antes solo corría actions[0]).
  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let calls = 0;
  LLMProvider.completeWithTools = async () => {
    calls++;
    if (calls === 1) {
      return {
        content: null,
        toolCalls: [
          { tool: 'read', params: { path: srcFile } },
          { tool: 'write', params: { path: outFile, content: 'BBB' } },
        ],
      };
    }
    return { content: 'Hice ambas cosas.', toolCalls: null };
  };

  try {
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: createMockLLM(['no se usa']),
      bridge: createMockBridge(projectCwd),
    });
    const result = await loop.run('lee y escribe', 'Eres un asistente.', [], {
      tools: [
        { name: 'read', description: 'lee', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: 'escribe', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    assert(
      result.toolResults.length === 2,
      'Ambas tools se ejecutaron en la iteración',
      `tools: ${result.toolResults.length}`
    );
    assert(
      result.toolResults.every((r) => r.ok),
      'Ambas tools tuvieron éxito',
      result.toolResults
        .map((r) => r.error)
        .filter(Boolean)
        .join(', ')
    );
    assert(fs.existsSync(outFile), 'b.txt fue escrito');
    assert(fs.readFileSync(outFile, 'utf-8') === 'BBB', 'Contenido de b.txt correcto');
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 9: compactación de contexto (G.1) ────────────────────────────────────

async function testContextCompaction() {
  console.log(C.bold('\n── Test 8: compactación de contexto ───────────────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop = new AgentLoop({
    maxIterations: 25,
    llm: async () => 'hola',
    bridge: createMockBridge('/tmp'),
  });

  // Historia larga: 20 tuplas (assistant + user) → debe compactar.
  const history = [];
  for (let i = 0; i < 20; i++) {
    history.push({ role: 'assistant', content: `respuesta ${i}` });
    history.push({ role: 'user', content: `resultado de tool ${i}` });
  }
  const toolResults = [];
  for (let i = 0; i < 20; i++) {
    toolResults.push({
      ok: i % 4 !== 0,
      tool: i % 2 === 0 ? 'write' : 'exec',
      error: i % 4 === 0 ? 'boom' : null,
      _action: { params: { path: `archivo-${i}.js` } },
    });
  }

  const msgs = loop._buildLLMMessages(
    history,
    'mensaje de resultado actual',
    'el objetivo original',
    toolResults,
    20
  );

  // 1. El objetivo original siempre presente al inicio.
  assert(msgs[0].content === 'el objetivo original', 'el objetivo original va primero');
  // 2. Hay un mensaje de resumen compacto.
  const summary = msgs.find(
    (m) => m.content && m.content.includes('[RESUMEN DE LO HECHO HASTA AHORA')
  );
  assert(!!summary, 'hay un mensaje de resumen compacto');
  assert(summary.content.includes('el objetivo original'), 'el resumen incluye el objetivo');
  assert(summary.content.includes('Acciones ejecutadas'), 'el resumen lista las acciones');
  // 3. La cola reciente se conserva íntegra.
  const tail = msgs.slice(1).filter((m) => m.content && m.content.startsWith('respuesta 19'));
  assert(tail.length === 1, 'el último turno se conserva íntegro');
  // 4. Número total de mensajes acotado (NO 20 tuplas crudas).
  assert(msgs.length < history.length, `la historia se acota (${msgs.length} < ${history.length})`);

  // Historia corta → sin compactación, se reenvía igual.
  const short = [
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'b' },
  ];
  const shortMsgs = loop._buildLLMMessages(short, 'res', 'obj', [], 2);
  assert(
    shortMsgs.length === 4,
    'historia corta se reenvía completa (objetivo + 2 turnos + resultado)'
  );

  // Resumen sin toolResults no explota.
  const emptyMsgs = loop._buildLLMMessages(history, 'res', 'obj', [], 20);
  assert(
    emptyMsgs.some((m) => m.content && m.content.includes('(ninguna todavía)')),
    'resumen tolera toolResults vacío'
  );
}

// ── Test 9: subagente (tool dispatch en proceso) ──────────────────────────────

async function testSubagentDispatch() {
  console.log(C.bold('\n── Test 9: subagente anidado se ejecuta y devuelve resumen ─'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  const AP = require('../core/planner/ActionParser.js');
  AP.setProjectCWD(projectCwd);

  // La tool-call nativa devuelve subagent; el subagente anidado usa el LLM
  // textual (sin tools → mockLLM), y el agente principal cierra después.
  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let tcCalls = 0;
  LLMProvider.completeWithTools = async () => {
    tcCalls++;
    if (tcCalls === 1) {
      return {
        content: null,
        toolCalls: [{ tool: 'subagent', params: { task: 'cuenta los archivos' } }],
      };
    }
    return { content: 'Tarea completada.', toolCalls: null };
  };

  try {
    const mockLLM = createMockLLM(['Resumen del subagente: hay 3 archivos.']);
    const loop = new AgentLoop({
      maxIterations: 5,
      llm: mockLLM,
      bridge: createMockBridge(projectCwd),
    });

    const result = await loop.run('delega la tarea a un subagente', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'subagent',
          description: 'lanzar subagente',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    assert(
      tcCalls === 2,
      'completeWithTools llamado 2 veces (subagent + cierre)',
      `llamadas: ${tcCalls}`
    );
    assert(
      result.toolResults.length === 1,
      'El subagente se ejecutó',
      `tools: ${result.toolResults.length}`
    );
    assert(result.toolResults[0].tool === 'subagent', 'Tool ejecutada: subagent');
    assert(result.toolResults[0].ok, 'subagent tuvo éxito', result.toolResults[0].error || '');
    assert(
      result.toolResults[0].result.response.includes('3 archivos'),
      'El resumen del subagente llegó al padre',
      result.toolResults[0].result.response.slice(0, 60)
    );
    assert(
      Array.isArray(result.toolResults[0].result.toolCalls),
      'subagent reporta toolCalls internos'
    );
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Test 10: límite de profundidad de subagentes ───────────────────────────────

async function testSubagentDepthLimit() {
  console.log(C.bold('\n── Test 10: profundidad máxima de subagentes ───────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const loop = new AgentLoop({
    maxIterations: 3,
    llm: async () => 'x',
    bridge: createMockBridge('/tmp'),
  });

  // Simular un subagente ya a profundidad 2 → debe negarse a crear uno más.
  loop._subagentDepth = 2;
  const result = await loop._executeSubagent({ tool: 'subagent', params: { task: 'haz algo' } });
  assert(!result.ok, 'a profundidad máxima el subagente falla con error claro', result.error || '');
  assert(
    result.error.includes('profundidad máxima'),
    'error menciona el límite de profundidad',
    result.error
  );

  // Sin task → error de validación.
  const noTask = await loop._executeSubagent({ tool: 'subagent', params: {} });
  assert(
    !noTask.ok && noTask.error.includes('task'),
    'subagente sin task → error de validación',
    noTask.error || ''
  );

  // A profundidad 0 la negativa NO aplica (crea el subagente, y el mock LLM
  // responde directamente sin herramientas).
  const fresh = new AgentLoop({
    maxIterations: 3,
    llm: async () => 'ok',
    bridge: createMockBridge('/tmp'),
  });
  const ok = await fresh._executeSubagent({ tool: 'subagent', params: { task: 'resume algo' } });
  assert(ok.ok, 'subagente a profundidad 0 se ejecuta', ok.error || '');
  assert(
    ok.result.response === 'ok',
    'el subagente devuelve la respuesta del LLM',
    ok.result.response
  );
}

// ── Test 11: compactación persiste y reconstruye contexto (memoria) ───────────

async function testMemoryCompaction() {
  console.log(C.bold('\n── Test 11: compactación ↔ memoria vectorial ────────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const { StateGraph } = require('../core/state-graph/StateGraph.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
  const graph = new StateGraph(path.join(dir, 'mem.db')).init();

  try {
    // Fuerza el branch de compactación: historia larga, sin tools.
    const loop = new AgentLoop({
      maxIterations: 25,
      llm: async () => 'hola',
      bridge: createMockBridge('/tmp'),
      graph,
    });
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: 'assistant', content: `turno ${i}` });
      history.push({ role: 'user', content: `respuesta ${i}` });
    }
    loop._buildLLMMessages(history, 'res', 'tarea de memoria recurrente', [], 20);
    assert(loop._compactionPersisted === true, 'la compactación se persistió en memoria');

    // El estado del graph se volvió a leer: el nodo Episode está en disco.
    const nodes = graph.queryNodes({ type: 'Episode', limit: 10 });
    assert(
      nodes.some((n) => (JSON.parse(n.tags || '[]') || []).includes('context-compaction')),
      'el episodio tiene tag context-compaction'
    );

    // Un segundo loop (sin haber compactado) recupera el contexto por recall.
    const loop2 = new AgentLoop({
      maxIterations: 5,
      llm: async () => 'x',
      bridge: createMockBridge('/tmp'),
      graph,
    });
    const memory = await loop2._recallMemory('tarea de memoria recurrente');
    assert(
      memory && memory.includes('CONTEXTO RELEVANTE DE MEMORIA'),
      'recall encuentra el episodio persistido',
      String(memory).slice(0, 120)
    );
    assert(memory.includes('tarea de memoria recurrente'), 'recall incluye el objetivo original');

    // Sin graph → recall null, sin romper.
    const loop3 = new AgentLoop({
      maxIterations: 5,
      llm: async () => 'x',
      bridge: createMockBridge('/tmp'),
    });
    const noMem = await loop3._recallMemory('algo');
    assert(noMem === null, 'sin graph → recall devuelve null');

    // La persistencia es best-effort: un graph con createNode roto no rompe el loop.
    const broken = new AgentLoop({
      maxIterations: 5,
      llm: async () => 'x',
      bridge: createMockBridge('/tmp'),
      graph: {
        createNode: () => {
          throw new Error('db caída');
        },
      },
    });
    broken._buildLLMMessages(history, 'res', 'objetivo', [], 20);
    assert(true, 'persistencia con graph roto no lanza');
  } finally {
    try {
      graph.close();
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// ── Edit legacy (instrucción en lenguaje natural) se resuelve a diff exacto ─

async function testResolvedLegacyEdit() {
  console.log(C.bold('\n── edit_file legacy: instruction → old_text/new_text exactos ──────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-resolve-edit-'));
  const filePath = path.join(dir, 'src', 'demo.js');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(filePath, 'const x = 1;\nconsole.log(x);\n', 'utf-8');

  const mockLLM = createMockLLM([
    '```action\nACCIÓN: edit_file | ARCHIVO: ' +
      filePath +
      '\nCONTENIDO: cambia "x = 1" por "y = 2" en la primera línea\n```',
    JSON.stringify({ old_text: 'const x = 1;', new_text: 'const y = 2;' }),
    'Listo, renombré la variable.',
  ]);

  const loop = new AgentLoop({
    maxIterations: 5,
    llm: mockLLM,
    bridge: createMockBridge(dir),
  });

  const result = await loop.run('edita el archivo', 'Eres un asistente.', [], {
    onApprovalNeeded: async () => true,
  });

  const edited = fs.readFileSync(filePath, 'utf-8');
  assert(edited.includes('const y = 2;'), 'El archivo quedó editado (y = 2)');
  assert(!edited.includes('const x = 1;'), 'El texto original fue reemplazado');
  assert(
    mockLLM.callCount() >= 2,
    'Se usó una llamada LLM extra para resolver la instrucción',
    `calls: ${mockLLM.callCount()}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Self-critique: verifica contra la intención original ───────────────────

async function testSelfCritique() {
  console.log(C.bold('\n── Test 14: Self-critique corrige una tarea incompleta ─────────'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  // Secuencia de respuestas:
  //  1. El agente responde con texto pero SIN ejecutar lo pedido (respuesta
  //     vaga "Tarea lista").
  //  2. La auto-crítica detecta que no se cumplió la intención → INCOMPLETA.
  //  3. El agente, con el feedback, corrige y da una respuesta completa.
  //  4. La segunda auto-crítica confirma COMPLETA → termina el run.
  const mockLLM = createMockLLM([
    'Tarea lista, espero haberte ayudado.',
    'VEREDICTO: INCOMPLETA\nRAZÓN: la intención pedía revisar config.json y nunca se leyó el archivo.',
    'Revisé el archivo config.json y contiene la clave "key" con el valor "value".',
    'VEREDICTO: COMPLETA',
  ]);

  const loop = new AgentLoop({
    maxIterations: 10,
    llm: mockLLM,
    bridge: createMockBridge('/tmp'),
  });

  const result = await loop.run(
    'Revisa config.json y dime qué contiene',
    'Eres un asistente útil.',
    [],
    { selfCritique: true }
  );

  assert(
    result.iterations === 2,
    'Ocupa una iteración extra para corregir',
    `iter: ${result.iterations}`
  );
  assert(
    mockLLM.callCount() === 4,
    '4 llamadas LLM (2 respuestas + 2 críticas)',
    `calls: ${mockLLM.callCount()}`
  );
  assert(!result.error, 'Sin error');
  assert(
    result.response.includes('config.json') && result.response.includes('value'),
    'Respuesta final cubre la intención original',
    result.response.slice(0, 120)
  );
}

async function testSelfCritiqueCompleteNoExtraRounds() {
  console.log(C.bold('\n── Test 15: Self-critique no consume rondas si la tarea está completa ─'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');

  const mockLLM = createMockLLM([
    'config.json contiene la clave "key" con el valor "value".',
    'VEREDICTO: COMPLETA',
  ]);

  const loop = new AgentLoop({
    maxIterations: 10,
    llm: mockLLM,
    bridge: createMockBridge('/tmp'),
  });

  const result = await loop.run(
    'Revisa config.json y dime qué contiene',
    'Eres un asistente útil.',
    [],
    { selfCritique: true }
  );

  assert(result.iterations === 1, 'Termina en 1 iteración', `iter: ${result.iterations}`);
  assert(
    mockLLM.callCount() === 2,
    '2 llamadas (1 respuesta + 1 crítica)',
    `calls: ${mockLLM.callCount()}`
  );
  assert(!result.error, 'Sin error');
}

// ── Plugin tools: default alto impacto (seguridad) ─────────────────────────

function testPluginToolsAreHighImpact() {
  console.log(C.bold('\n── Tools de plugins: alto impacto ─────────────────────────'));

  const AP = require('../core/planner/ActionParser.js');

  assert(AP.isHighImpact('plugin', {}), 'tool "plugin" → requiere aprobación');
  assert(
    AP.isHighImpact('plugin.myplugin.do_something', {}),
    'tool "plugin.<nombre>.<tool>" → requiere aprobación'
  );
  assert(
    AP.isHighImpact('plugin.secret_reader.read', {}),
    'cualquier tool de plugin (con datos) → requiere aprobación'
  );
  assert(!AP.isHighImpact('read', { path: 'src/index.js' }), 'read normal dentro del proyecto NO');
}

// ── Fase 2: anti-repetición de llamadas idénticas fallidas ──────────────────
// Caso real de producción: el mismo Write contra un directorio (EISDIR) se
// repitió 3 veces seguidas quemando iteraciones. El loop registra las llamadas
// del run y SALTA cualquier copia exacta (tool + params) que ya haya fallado,
// inyectándole al LLM una nota para que cambie de estrategia.

async function testAntiRepetition() {
  console.log(C.bold('\n── Test 16: llamada fallida idéntica se salta (anti-repetición) ───'));

  const { AgentLoop } = require('../core/planner/AgentLoop.js');
  const AP = require('../core/planner/ActionParser.js');
  const LLMProvider = require('../core/llm/LLMProvider.js');

  const projectCwd = teardown() || setup();
  AP.setProjectCWD(projectCwd);

  const originalCompleteWithTools = LLMProvider.completeWithTools;
  let calls = 0;
  let sawSkipNote = false;
  const missing = path.join(projectCwd, 'no-existe.txt');

  LLMProvider.completeWithTools = async (messages, ..._rest) => {
    calls++;
    if (calls === 1) {
      return { content: null, toolCalls: [{ tool: 'read', params: { path: missing } }] };
    }
    if (calls === 2) {
      // El LLM (errado) repite EXACTAMENTE la misma llamada que acaba de fallar.
      return { content: null, toolCalls: [{ tool: 'read', params: { path: missing } }] };
    }
    // Turno de cierre: aquí ya debería haber visto la nota de "ya la intentaste".
    sawSkipNote = /Ya intentaste exactamente/.test(JSON.stringify(messages));
    return { content: 'No pude leer el archivo; cambié de estrategia.', toolCalls: null };
  };

  try {
    const bridge = createMockBridge(projectCwd);
    let readExecutions = 0;
    const wrappedBridge = {
      ...bridge,
      execute: async (tool, params) => {
        if (tool === 'read') readExecutions++;
        return bridge.execute(tool, params);
      },
    };

    const loop = new AgentLoop({
      maxIterations: 6,
      llm: createMockLLM(['no se usa']),
      bridge: wrappedBridge,
    });

    const result = await loop.run('leé un archivo que no existe', 'Eres un asistente.', [], {
      tools: [
        {
          name: 'read',
          description: 'lee un archivo',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    assert(
      readExecutions === 1,
      'read se ejecutó UNA vez (la 2ª idéntica se salteó)',
      `ejecuciones: ${readExecutions}`
    );
    assert(
      result.toolResults.length === 1,
      'Solo 1 tool result (la repetida no entró al loop)',
      `tools: ${result.toolResults.length}`
    );
    assert(
      String(result.toolResults[0].error).includes('File not found'),
      'La única llamada falló como se esperaba',
      String(result.toolResults[0].error)
    );
    assert(
      sawSkipNote,
      'El LLM recibió la nota "Ya intentaste exactamente" antes de la 2ª llamada'
    );
    assert(calls === 3, 'El LLM cerró con texto en el 3er turno', `llamadas LLM: ${calls}`);
  } finally {
    LLMProvider.completeWithTools = originalCompleteWithTools;
  }

  teardown();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  March 7th — Test Suite: AgentLoop Fase 0')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));
  await testTextResponse();
  await testAdaptsToRealResult();
  await testMaxIterations();
  await testApprovalRejected();
  await testNoApprovalCallback();
  await testBridgeExecution();
  await testNativeToolCallEmptyContent();
  await testNativeToolCallAlias();
  await testLLMFailureKeepsCompletedTools();
  await testMCPToolTextFallback();
  await testMCPCallClassicRouting();
  await testMCPUnknownToolClearError();
  await testMultiToolPerIteration();
  await testContextCompaction();
  await testSubagentDispatch();
  await testSubagentDepthLimit();
  await testMemoryCompaction();
  await testResolvedLegacyEdit();
  await testSelfCritique();
  await testSelfCritiqueCompleteNoExtraRounds();
  testPluginToolsAreHighImpact();
  await testAntiRepetition();

  console.log(C.bold('\n════════════════════════════════════════════════════════'));
  const total = passed + failed;
  console.log(
    C.bold(
      `  Resultado: ${C.green(passed + ' passed')}  ${failed > 0 ? C.red(failed + ' failed') : C.dim('0 failed')}  / ${total} total`
    )
  );
  console.log(C.bold('════════════════════════════════════════════════════════\n'));

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(C.red('\nERROR FATAL:'), e.message);
  console.error(e.stack);
  process.exit(1);
});
