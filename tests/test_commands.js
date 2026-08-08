'use strict';

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

const {
  _parse,
  execute,
  getHelp,
  getNames,
  register,
} = require('../core/commands/CommandRegistry.js');

// ── Test 1: _parse ──────────────────────────────────────────────────────────

function testParse() {
  console.log(C.bold('\n── Test 1: Parseo de comandos ─────────────────────────────'));

  const r1 = _parse('/help');
  assert(r1.name === 'help', 'parse: "/help" → name=help', JSON.stringify(r1));
  assert(r1.args.length === 0, 'parse: "/help" → 0 args');

  const r2 = _parse('/agent coder');
  assert(r2.name === 'agent', 'parse: "/agent coder" → name=agent');
  assert(r2.args.length === 1, 'parse: "/agent coder" → 1 arg');
  assert(r2.args[0] === 'coder', 'parse: "/agent coder" → args[0]=coder');

  const r3 = _parse('/model groq');
  assert(r3.name === 'model', 'parse: "/model groq" → name=model');
  assert(r3.args[0] === 'groq', 'parse: "/model groq" → args[0]=groq');

  const r4 = _parse('/model   gemini  ');
  assert(r4.name === 'model', 'parse con espacios extra: name=model');
  assert(r4.args[0] === 'gemini', 'parse con espacios extra: args[0]=gemini');

  const r5 = _parse('/');
  assert(r5.name === '', 'parse: "/" solo → name vacío');

  const r6 = _parse('/unknown-command with args');
  assert(r6.name === 'unknown-command', 'parse: comando desconocido tiene nombre');
  assert(r6.args.length === 2, 'parse: comando desconocido tiene args');

  const r7 = _parse('/exec "echo hello"');
  assert(r7.name === 'exec', 'parse: args con comillas');
  assert(r7.args[0] === 'echo hello', 'parse: comillas se limpian');
}

// ── Test 2: Comandos registrados ────────────────────────────────────────────

function testRegisteredCommands() {
  console.log(C.bold('\n── Test 2: Comandos registrados ───────────────────────────'));

  const names = getNames();
  assert(names.includes('help'), 'help registrado');
  assert(names.includes('clear'), 'clear registrado');
  assert(!names.includes('mode'), 'mode eliminado (modo automático por intención)');
  assert(names.includes('model'), 'model registrado');
  assert(names.includes('memory'), 'memory registrado');
  assert(names.includes('retry'), 'retry registrado');
  assert(names.includes('stats'), 'stats registrado');
  assert(names.includes('export'), 'export registrado');
}

// ── Test 3: /help ───────────────────────────────────────────────────────────

function testHelp() {
  console.log(C.bold('\n── Test 3: /help ───────────────────────────────────────────'));

  const result = execute('/help', {});
  return result.then((r) => {
    assert(!r.error, 'help sin error');
    assert(r.result.includes('Comandos disponibles'), 'help lista comandos');
    assert(r.result.includes('/clear'), 'help menciona /clear');
    assert(r.result.includes('/cambio-modelo'), 'help menciona /cambio-modelo');
    assert(r.result.includes('/model'), 'help menciona /model');
    assert(!/\bmode\b/.test(r.result), 'help ya no menciona /mode');
  });
}

// ── Test 4: /clear ─────────────────────────────────────────────────────────

function testClear() {
  console.log(C.bold('\n── Test 4: /clear ──────────────────────────────────────────'));

  const history = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'adiós' },
  ];
  const ctx = { sessionHistory: history };

  const result = execute('/clear', ctx);
  return result.then((r) => {
    assert(!r.error, 'clear sin error');
    assert(r.result.includes('borrado'), 'clear confirma borrado');
    assert(history.length === 0, 'sessionHistory se vació');
  });
}

// ── Test 6: /model ─────────────────────────────────────────────────────────

function testModel() {
  console.log(C.bold('\n── Test 6: /model ──────────────────────────────────────────'));

  let configured = null;
  const mockProviders = [
    {
      id: 'groq',
      name: 'groq',
      free: true,
      hasKey: true,
      models: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
      activeModel: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
      catalog: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
    },
    {
      id: 'gemini',
      name: 'gemini',
      free: true,
      hasKey: false,
      models: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' },
      activeModel: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' },
      catalog: ['gemini-2.0-flash', 'gemini-2.5-pro'],
    },
  ];
  const mockLLMProvider = {
    getActiveProvider: () => configured || 'groq',
    configure: (cfg) => {
      configured = cfg.llm.primary;
    },
    getAvailableProviders: () => mockProviders,
    listModels: (id) => {
      const p = mockProviders.find((x) => x.id === id);
      return p ? p.catalog : [];
    },
  };

  const ctx = { LLMProvider: mockLLMProvider };

  return execute('/model gemini', ctx)
    .then((r) => {
      assert(!r.error, 'model gemini sin error');
      assert(configured === 'gemini', 'configure llamado con gemini');
      assert(r.result.includes('gemini'), 'respuesta menciona gemini');
    })
    .then(() => {
      return execute('/model', ctx);
    })
    .then((r) => {
      assert(!r.error, 'model sin args no es error');
      assert(r.result.includes('groq'), 'model sin args muestra activo');
    });
}

// ── Test 7: /memory ────────────────────────────────────────────────────────

function testMemory() {
  console.log(C.bold('\n── Test 7: /memory ─────────────────────────────────────────'));

  const ctx1 = { sessionHistory: [] };
  return execute('/memory', ctx1)
    .then((r) => {
      assert(!r.error, 'memory vacío sin error');
      assert(r.result.includes('No hay mensajes'), 'memory vacío muestra aviso');
    })
    .then(() => {
      const ctx2 = {
        sessionHistory: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: 'mundo' },
        ],
      };
      return execute('/memory', ctx2);
    })
    .then((r) => {
      assert(!r.error, 'memory con datos sin error');
      assert(r.result.includes('2 mensajes'), 'memory muestra cantidad');
      assert(r.result.includes('hola'), 'memory muestra contenido');
    });
}

// ── Test 8: /export ────────────────────────────────────────────────────────

function testExport() {
  console.log(C.bold('\n── Test 8: /export ─────────────────────────────────────────'));

  const ctx = {
    sessionHistory: [
      { role: 'user', content: 'mensaje 1' },
      { role: 'assistant', content: 'respuesta 1' },
    ],
    fs: require('fs'),
    path: require('path'),
    process: { cwd: () => process.cwd() },
  };

  return execute('/export', ctx).then((r) => {
    assert(!r.error, 'export sin error');
    assert(r.result.includes('exports/'), 'export menciona ruta');
    assert(r.result.includes('.md'), 'export es .md');
    assert(!r.result.includes('error'), 'export no contiene error');
  });
}

// ── Test 9: Comando desconocido ────────────────────────────────────────────

function testUnknownCommand() {
  console.log(C.bold('\n── Test 9: Comando desconocido ───────────────────────────────'));

  const result = execute('/xyzzy', {});
  return result.then((r) => {
    assert(r.error, 'comando desconocido tiene error');
    assert(r.error.includes('desconocido'), 'error menciona "desconocido"');
    assert(r.error.includes('/help'), 'error sugiere /help');
  });
}

// ── Test 10: /agent ──────────────────────────────────────────────────────────

let _agentManagerMode = null;
const mockAgentManager = {
  getActive: () => ({ name: 'conversation', label: 'Conversación', description: 'default' }),
  setActive: (name) => {
    if (name === 'coder')
      return { name: 'coder', label: 'Programación', description: 'coder', mode: 'task' };
    if (name === 'reviewer')
      return { name: 'reviewer', label: 'Review', description: 'reviewer', mode: 'task' };
    if (name === 'planner')
      return { name: 'planner', label: 'Planner', description: 'planner', mode: 'task' };
    if (name === 'conversation')
      return {
        name: 'conversation',
        label: 'Conversación',
        description: 'default',
        mode: 'conversational',
      };
    return null;
  },
  getAll: () => [
    { name: 'conversation', label: 'Conversación', description: 'default' },
    { name: 'coder', label: 'Programación', description: 'coder' },
    { name: 'reviewer', label: 'Review', description: 'reviewer' },
    { name: 'planner', label: 'Planner', description: 'planner' },
  ],
  getMode: (name) =>
    name === 'coder' || name === 'reviewer' || name === 'planner' ? 'task' : 'conversational',
  getSystemPrompt: (name) => '',
};

// Monkey-patch until we load the real module for some tests
function testAgentCommand() {
  console.log(C.bold('\n── Test 10: /agent ───────────────────────────────────────────'));

  const ctx = {
    sessionHistory: [],
    fs: require('fs'),
    path: require('path'),
    process: { cwd: () => process.cwd() },
  };

  // We need to test with real AgentManager
  return execute('/agent', ctx)
    .then((r) => {
      assert(!r.error, 'agent sin args no es error');
      assert(r.result.includes('Agente activo'), 'agent sin args muestra estado');
      assert(r.result.includes('conversation'), 'agent muestra agente actual');
    })
    .then(() => {
      return execute('/agent coder', ctx);
    })
    .then((r) => {
      assert(!r.error, 'agent coder sin error');
      assert(r.result.includes('Programación'), 'agent coder menciona label');
    })
    .then(() => {
      return execute('/agent coder', ctx);
    })
    .then((r) => {
      // Después de cambiar a coder, verificar que funciona
      assert(r.result.includes('Programación'), 'agent coder (segunda vez) funciona');
    })
    .then(() => {
      return execute('/agent conversation', ctx);
    })
    .then((r) => {
      assert(!r.error, 'agent conversation sin error');
    });
}

// ── Test 11: /agent inválido ─────────────────────────────────────────────────
function testAgentInvalid() {
  console.log(C.bold('\n── Test 11: /agent inválido ─────────────────────────────────'));

  return execute('/agent noexiste', {}).then((r) => {
    assert(!r.error, 'agent inválido no rompe');
    assert(r.result.includes('desconocido'), 'agent inválido muestra error amigable');
  });
}

// ── Test 12: /init ───────────────────────────────────────────────────────────
function testInit() {
  console.log(C.bold('\n── Test 12: /init ───────────────────────────────────────────'));

  const ctx = {
    fs: require('fs'),
    path: require('path'),
    process: { cwd: () => process.cwd() },
  };

  return execute('/init', ctx).then((r) => {
    assert(!r.error, 'init sin error');
    assert(r.result.includes('Resumen del proyecto'), 'init muestra resumen');
    assert(r.result.includes('archivos'), 'init menciona archivos');
  });
}

// ── Test 13: /review ─────────────────────────────────────────────────────────
function testReview() {
  console.log(C.bold('\n── Test 13: /review ─────────────────────────────────────────'));

  const ctx = {
    fs: require('fs'),
    path: require('path'),
    process: { cwd: () => process.cwd() },
  };

  return execute('/review', ctx)
    .then((r) => {
      assert(!r.error, 'review sin args no rompe');
      assert(r.result.includes('archivo'), 'review sin args pide archivo');
    })
    .then(() => {
      return execute('/review inexistente.js', ctx);
    })
    .then((r) => {
      assert(!r.error, 'review archivo inexistente no rompe');
      assert(r.result.includes('no encontrado'), 'review archivo inexistente avisa');
    })
    .then(() => {
      // Review con archivo existente (el mismo test file)
      return execute('/review tests/test_commands.js', ctx);
    })
    .then((r) => {
      assert(!r.error, 'review archivo existente sin error');
      assert(r.result.includes('Revisión solicitada'), 'review confirma archivo');
    });
}

// ── Test 14: /plan ───────────────────────────────────────────────────────────
function testPlan() {
  console.log(C.bold('\n── Test 14: /plan ───────────────────────────────────────────'));

  return execute('/plan', {})
    .then((r) => {
      assert(!r.error, 'plan sin args no rompe');
      assert(r.result.includes('Planificador'), 'plan sin args muestra ayuda');
    })
    .then(() => {
      return execute('/plan Implementar login', {}).then((r) => {
        assert(!r.error, 'plan con args no rompe');
        assert(r.result.includes('Plan solicitado'), 'plan con args confirma');
        assert(r.result.includes('Implementar login'), 'plan preserva texto');
      });
    });
}

// ── Test 15: /undo ───────────────────────────────────────────────────────────
function testUndo() {
  console.log(C.bold('\n── Test 15: /undo ───────────────────────────────────────────'));

  // Sin ipcRenderer — handler returns string, execute wraps as { result }
  return execute('/undo', {}).then((r) => {
    assert(!r.error, 'undo sin IPC no da error del sistema');
    assert(r.result && r.result.includes('IPC'), 'resultado menciona IPC');
  });
}

// ── Test 16: /fix ────────────────────────────────────────────────────────────
function testFix() {
  console.log(C.bold('\n── Test 16: /fix ────────────────────────────────────────────'));

  // Sin ipcRenderer — handler returns string, execute wraps as { result }
  return execute('/fix', {}).then((r) => {
    assert(!r.error, 'fix sin IPC no da error del sistema');
    assert(r.result && r.result.includes('IPC'), 'resultado menciona IPC');
  });
}

// ── Test 17: /code ───────────────────────────────────────────────────────────
function testCode() {
  console.log(C.bold('\n── Test 17: /code ───────────────────────────────────────────'));

  const ctx = {
    sessionHistory: [],
    fs: require('fs'),
    path: require('path'),
    process: { cwd: () => process.cwd() },
  };

  return execute('/code', ctx).then((r) => {
    assert(!r.error, 'code sin error');
    assert(r.result.includes('Programación'), 'code cambia a coder');
    assert(r.result.includes('@archivo'), 'code menciona @archivo');
  });
}

// ── Test 18: /cambio-modelo ───────────────────────────────────────────────────
function testCambioModelo() {
  console.log(C.bold('\n── Test 18: /cambio-modelo ───────────────────────────────────'));

  const mockIPC = {
    invoke: async (ch, payload) => {
      if (ch === 'models-list') {
        return [
          { id: 'March 7th', name: 'March 7th', model3Path: '/x/march.model3.json', active: true },
          { id: 'Otro', name: 'Otro', model3Path: '/x/otro.model3.json', active: false },
        ];
      }
      if (ch === 'model-set') return { ok: true, info: { id: payload.id, name: payload.id } };
      return null;
    },
  };

  return execute('/cambio-modelo', { ipcRenderer: mockIPC })
    .then((r) => {
      assert(!r.error, 'cambio-modelo sin error');
      assert(r.result.includes('March 7th'), 'lista el modelo activo');
      assert(r.result.includes('Otro'), 'lista los modelos disponibles');
    })
    .then(() => execute('/cambio-modelo Otro', { ipcRenderer: mockIPC }))
    .then((r) => {
      assert(!r.error, 'cambio-modelo con argumento no da error');
      assert(r.result.includes('Otro'), 'cambia al modelo pedido');
    })
    .then(() => execute('/cambio-modelo inexistente', { ipcRenderer: mockIPC }))
    .then((r) => {
      assert(r.result && r.result.includes('no encontrado'), 'modelo inexistente se reporta');
    })
    .then(() => execute('/cambio-modelo', {}))
    .then((r) => {
      assert(r.result && r.result.includes('IPC'), 'sin IPC menciona IPC');
    });
}

// ── Test 19: /modelo-vistas ───────────────────────────────────────────────────
function testModeloVistas() {
  console.log(C.bold('\n── Test 19: /modelo-vistas ───────────────────────────────────'));

  const mockIPC = {
    invoke: async (ch, payload) => {
      if (ch === 'views-get') return { modelId: 'March 7th', mode: 'random', activeView: 'full' };
      if (ch === 'views-set')
        return {
          ok: true,
          modelId: 'March 7th',
          mode: payload.mode,
          activeView: payload.mode === 'random' ? 'full' : payload.mode,
        };
      return null;
    },
  };

  return execute('/modelo-vistas', { ipcRenderer: mockIPC })
    .then((r) => {
      assert(!r.error, 'modelo-vistas sin error');
      assert(r.result.includes('Cuerpo completo'), 'menú muestra cuerpo completo');
      assert(r.result.includes('Aleatorio'), 'menú muestra aleatorio');
      assert(r.result.includes('view-toggle-group'), 'menú renderiza botones de toggle');
    })
    .then(() => execute('/modelo-vistas full', { ipcRenderer: mockIPC }))
    .then((r) => {
      assert(!r.error, 'fijar full no da error');
      assert(r.result.includes('queda fijo'), 'confirma vista fija');
    })
    .then(() => execute('/modelo-vistas random', { ipcRenderer: mockIPC }))
    .then((r) => {
      assert(!r.error, 'aleatorio no da error');
      assert(r.result.includes('rotará'), 'confirma modo aleatorio');
    })
    .then(() => execute('/modelo-vistas foo', { ipcRenderer: mockIPC }))
    .then((r) => {
      assert(r.result && r.result.includes('Modo desconocido'), 'modo inválido se reporta');
    })
    .then(() => execute('/modelo-vistas', {}))
    .then((r) => {
      assert(r.result && r.result.includes('IPC'), 'sin IPC menciona IPC');
    });
}

// ── Test 20: Nuevos comandos en getNames ─────────────────────────────────────
function testNewRegisteredCommands() {
  console.log(C.bold('\n── Test 20: Registro de comandos nuevos ─────────────────────'));

  const names = getNames();
  assert(names.includes('agent'), '/agent registrado');
  assert(names.includes('init'), '/init registrado');
  assert(names.includes('review'), '/review registrado');
  assert(names.includes('plan'), '/plan registrado');
  assert(names.includes('undo'), '/undo registrado');
  assert(names.includes('fix'), '/fix registrado');
  assert(names.includes('code'), '/code registrado');
  assert(names.includes('cambio-modelo'), '/cambio-modelo registrado');
  assert(names.includes('modelo-vistas'), '/modelo-vistas registrado');
}

// ── Test 20: Inyección no rompe ─────────────────────────────────────────────

function testEdgeCases() {
  console.log(C.bold('\n── Test 10: Casos borde ─────────────────────────────────────'));

  const r1 = execute('', {});
  return r1
    .then((r) => {
      assert(r.error, 'texto vacío produce error');
    })
    .then(() => {
      const r2 = execute('/', {});
      return r2;
    })
    .then((r) => {
      assert(r.error, 'solo "/" produce error');
    })
    .then(() => {
      const r3 = execute('/help extra args here', {});
      return r3;
    })
    .then((r) => {
      assert(!r.error, 'help con args extra no rompe');
      assert(r.result.includes('Comandos disponibles'), 'help con args extra funciona');
    })
    .then(() => {
      const r4 = execute('/clear --malicious-option', {
        sessionHistory: [{ role: 'user', content: 'test' }],
      });
      return r4;
    })
    .then((r) => {
      assert(!r.error, 'clear con args extra no rompe');
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.bold(C.cyan('\n════════════════════════════════════════════════════════')));
  console.log(C.bold(C.cyan('  March 7th — Test Suite: Comandos / — Fase 3')));
  console.log(C.bold(C.cyan('════════════════════════════════════════════════════════')));

  testParse();
  testRegisteredCommands();
  await testHelp();
  await testClear();
  await testModel();
  await testMemory();
  await testExport();
  await testAgentCommand();
  await testAgentInvalid();
  await testInit();
  await testReview();
  await testPlan();
  await testUndo();
  await testFix();
  await testCode();
  await testCambioModelo();
  await testModeloVistas();
  testNewRegisteredCommands();
  await testUnknownCommand();
  await testEdgeCases();

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
