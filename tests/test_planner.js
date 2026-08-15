'use strict';

// Planner — ejecutor de planes (Fase 3 v9). Se cubre el parsing puro
// (planSingleStep/planMultiStep/planFromLLMResponse), la ejecución con un
// bridge stub (aprobación, fallos, cola, cancelación, dependencias) y los
// paths edit/create con un LLM stub (modo completo + chunking).

const path = require('path');
const fs = require('fs');
const os = require('os');

const { Planner, setProjectCWD } = require('../core/planner/Planner.js');
const LLMProvider = require('../core/llm/LLMProvider.js');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-test-'));

/** Bridge stub: responde ok salvo fallos explícitos (path o command "fail-*"). */
function makeStubBridge() {
  const calls = [];
  const bridge = {
    calls,
    execute: async (tool, params = {}) => {
      calls.push({ tool, params });
      const p = String(params.path || params.command || '');
      if (p.includes('fail-read'))
        return { ok: false, error: 'read falló', result: null, tool, elapsed: 1 };
      if (params.command === 'fail-me') {
        return { ok: false, error: 'comando falló', result: null, tool, elapsed: 1 };
      }
      return { ok: true, result: 'resultado de ' + tool, tool, elapsed: 1 };
    },
    getStats: () => ({ total: 0, ok: 0, failed: 0, tools: [], available: true }),
  };
  return bridge;
}

function newPlanner() {
  const p = new Planner();
  p._bridge = makeStubBridge();
  return p;
}

function testPlanConstruction() {
  console.log(C.bold('\n── planSingleStep / planMultiStep / isHighImpact ─────────────'));

  const p = newPlanner();
  const single = p.planSingleStep('objetivo', 'read', { path: 'dentro.txt' }, 'leer dentro');
  assert(single.steps.length === 1, 'planSingleStep crea 1 paso');
  assert(single.steps[0].requiresApproval === false, 'read dentro del proyecto → sin aprobación');

  const browserPlan = p.planSingleStep('x', 'browser', { action: 'navigate', url: 'https://x' });
  assert(browserPlan.steps[0].requiresApproval === true, 'browser → requiere aprobación');

  const multi = p.planMultiStep('multi', [
    { id: 'leer', tool: 'read', params: { path: 'a.js' } },
    { id: 'editar', tool: 'edit', params: { path: 'a.js' }, dependsOn: ['leer'] },
  ]);
  assert(multi.steps.length === 2, 'planMultiStep crea 2 pasos');
  assert(multi.steps[1].dependsOn[0] === 'leer', 'planMultiStep conserva dependsOn');
  assert(multi.steps[0].id === 'leer', 'planMultiStep usa id estable');
}

function testPlanFromLLMResponse() {
  console.log(C.bold('\n── planFromLLMResponse: bloque estructurado + regex ──────────'));

  const p = newPlanner();
  const structured = '```action\nACCIÓN: read_file | ARCHIVO: a.txt\n```';
  const single = p.planFromLLMResponse(structured, 'leer algo');
  assert(
    single && single.steps.length === 1 && single.steps[0].tool === 'read',
    'bloque estructurado → 1 paso'
  );

  const multi =
    '```action\nACCIÓN: read_file | ARCHIVO: a.txt\n```\n' +
    '```action\nACCIÓN: write | ARCHIVO: b.txt | CONTENIDO: x\n```';
  const multiPlan = p.planFromLLMResponse(multi, 'dos pasos');
  assert(multiPlan && multiPlan.steps.length === 2, 'bloque estructurado multi → 2 pasos');

  const none = p.planFromLLMResponse('pregunta normal sin acciones', 'charla');
  assert(none === null, 'sin acciones → null');
}

function testExecuteSingle() {
  console.log(C.bold('\n── execute: plan de 1 paso → done ─────────────────────────────'));

  const p = newPlanner();
  const plan = p.planSingleStep('objetivo', 'read', { path: 'a.txt' });
  const doneSteps = [];
  return p.execute(plan, { onStepDone: (s, r) => doneSteps.push([s.id, r]) }).then((result) => {
    assert(result.status === 'done', 'plan single → done');
    assert(result.steps[0].status === 'done', 'paso → done');
    assert(doneSteps.length === 1, 'onStepDone se invoca 1 vez');
    assert(result.result === 'resultado de read', 'result agregado');
    assert(p.getHistory(1).length === 1, 'plan archivado en history');
    const stats = p.getStats();
    assert(stats.done === 1 && stats.total === 1, 'getStats cuenta done');
  });
}

function testExecuteFailure() {
  console.log(C.bold('\n── execute: paso falla → plan failed + dependencias skipped ────'));

  const p = newPlanner();
  const plan = p.planMultiStep('fallo', [
    { id: 'a', tool: 'read', params: { path: 'fail-read' } },
    { id: 'b', tool: 'write', params: { path: 'b.txt' }, dependsOn: ['a'] },
  ]);
  return p.execute(plan, {}).then((result) => {
    assert(result.status === 'failed', 'plan → failed');
    assert(result.steps[0].status === 'failed', 'paso que falla → failed');
    assert(result.steps[1].status === 'skipped', 'paso dependiente → skipped');
    assert(
      result.steps[0].error.includes('read falló'),
      'error del bridge llega al paso',
      result.steps[0].error
    );
  });
}

function testExecuteApproval() {
  console.log(C.bold('\n── execute: aprobación humana (deniega / otorga) ───────────────'));

  const p1 = newPlanner();
  const denied = p1.planSingleStep('x', 'browser', { action: 'navigate', url: 'https://x' });
  return p1
    .execute(denied, { onApprovalNeeded: async () => false })
    .then((result) => {
      assert(result.status === 'done', 'denegada → plan done (paso skipped, no falla)');
      assert(result.steps[0].status === 'skipped', 'paso denegado → skipped');
      assert(result.steps[0].error === 'Cancelado por el usuario', 'error de denegación');
    })
    .then(() => {
      const p2 = newPlanner();
      const granted = p2.planSingleStep('x', 'browser', { action: 'navigate', url: 'https://x' });
      return p2.execute(granted, { onApprovalNeeded: async () => true }).then((res) => {
        assert(res.status === 'done' && res.steps[0].status === 'done', 'aprobada → paso done');
      });
    });
}

function testExecuteMultiWave() {
  console.log(C.bold('\n── execute: multi-paso con dependsOn + $ref ────────────────────'));

  const p = newPlanner();
  const plan = p.planMultiStep('wave', [
    { id: 'leer', tool: 'read', params: { path: 'a.txt' } },
    { id: 'editar', tool: 'read', params: { path: '$leer' }, dependsOn: ['leer'] },
    { id: 'libre', tool: 'read', params: { path: 'c.txt' } },
  ]);
  return p.execute(plan, {}).then((result) => {
    assert(result.status === 'done', 'plan multi → done');
    assert(
      result.steps.every((s) => s.status === 'done'),
      'todos los pasos → done'
    );
    const refCall = p._bridge.calls.find(
      (c) => c.tool === 'read' && c.params.path === 'resultado de read'
    );
    assert(refCall, '$ref se resuelve con el resultado del paso previo');
  });
}

function testExecuteDependencyCycle() {
  console.log(C.bold('\n── execute: ciclo de dependencias → skipped ────────────────────'));

  const p = newPlanner();
  const plan = p.planMultiStep('ciclo', [
    { id: 'a', tool: 'read', params: { path: 'a' }, dependsOn: ['b'] },
    { id: 'b', tool: 'read', params: { path: 'b' }, dependsOn: ['a'] },
  ]);
  return p.execute(plan, {}).then((result) => {
    assert(
      result.steps.every((s) => s.status === 'skipped'),
      'pasos en ciclo → skipped'
    );
    assert(result.steps[0].error === 'Dependencia no disponible', 'error de dependencia');
  });
}

function testExecuteQueue() {
  console.log(C.bold('\n── execute: segundo plan → queued ───────────────────────────────'));

  const p = newPlanner();
  const a = p.planSingleStep('uno', 'read', { path: 'a' });
  const b = p.planSingleStep('dos', 'read', { path: 'b' });
  const resA = p.execute(a, {});
  const resB = p.execute(b, {});
  return Promise.all([resA, resB])
    .then(([ra, rb]) => {
      assert(ra.status === 'done', 'primer plan → done');
      assert(rb.status === 'queued', 'segundo plan encolado (status queued)');
      return new Promise((r) => setImmediate(r));
    })
    .then(() => {
      assert(b.status === 'done', 'el encolado se desencola al terminar el activo');
    });
}

function testCancel() {
  console.log(C.bold('\n── cancel: aborta el plan activo ─────────────────────────────────'));

  const p = newPlanner();
  p._bridge.execute = () => new Promise(() => {});
  const plan = p.planSingleStep('cuelga', 'read', { path: 'hang' });
  const execPromise = p.execute(plan, {});
  return Promise.resolve()
    .then(() => p.cancel())
    .then(() => {
      assert(plan.status === 'cancelled', 'cancel marca el plan activo como cancelled');
      return execPromise;
    });
}

function testMCPAndPlugin() {
  console.log(C.bold('\n── execute: tools mcp y plugin ──────────────────────────────────'));

  const MCPM = require('../core/mcp/MCPManager.js');
  MCPM.getMCPManager = () => ({
    callTool: async (server, tool) => ({
      content: [{ type: 'text', text: `ok ${server}:${tool}` }],
    }),
  });
  const PM = require('../core/plugins/PluginManager.js');
  PM.getPluginManager = () => ({ _dispatch: async (id) => ({ ok: true, result: `ok ${id}` }) });

  const p = newPlanner();
  const plan = p.planMultiStep('mcp', [
    { id: 'm', tool: 'mcp', params: { server: 'srv', tool: 'tool', args: { x: 1 } } },
    { id: 'pl', tool: 'plugin', params: { name: 'plugin.a.b' }, dependsOn: ['m'] },
  ]);
  return p.execute(plan, {}).then((result) => {
    assert(result.status === 'done', 'mcp + plugin → done');
    assert(result.steps[0].tool === 'mcp', 'paso mcp existe');
    assert(result.steps[1].tool === 'plugin', 'paso plugin existe');
  });
}

function testEditCreateFiles() {
  console.log(C.bold('\n── edit_file / create_file con LLM stub (completo + chunking) ───'));

  LLMProvider.completeTask = async () => 'CONTENIDO GENERADO POR EL LLM STUB';

  const p = newPlanner();
  p._bridge.execute = async (tool, params = {}) => {
    if (tool === 'read' && params.path === 'corto.md') {
      return { ok: true, result: 'contenido corto', tool, elapsed: 1 };
    }
    if (tool === 'read' && params.path === 'largo.md') {
      const md = Array.from(
        { length: 12 },
        (_, i) => `# Seccion ${i}\n${'parrafo relleno repetido. '.repeat(120)}\n`
      ).join('\n');
      return { ok: true, result: md, tool, elapsed: 1 };
    }
    if (tool === 'read' && params.path === 'token.md') {
      const md = ['# Titulo', '# Unica seccion con unicotoken42', '# Cierre'].join('\n');
      return { ok: true, result: md, tool, elapsed: 1 };
    }
    if (tool === 'write') return { ok: true, result: 'escrito', tool, elapsed: 1 };
    return { ok: false, error: 'no esperado', result: null, tool, elapsed: 1 };
  };

  // create_file directo
  return (
    p
      .execute(
        p.planSingleStep('crear', 'create_file', { path: 'nuevo.txt', instruction: 'crea algo' }),
        {}
      )
      .then((res) => {
        assert(res.status === 'done', 'create_file → done');
        const write = p._bridge.calls.find(
          (c) => c.tool === 'write' && c.params.path === 'nuevo.txt'
        );
        assert(
          write && write.params.content === 'CONTENIDO GENERADO POR EL LLM STUB',
          'create_file escribe el contenido del LLM'
        );
      })
      // edit_file en modo completo (contenido corto)
      .then(() =>
        p.execute(
          p.planSingleStep('editar', 'edit_file', { path: 'corto.md', instruction: 'cambia algo' }),
          {}
        )
      )
      .then((res) => {
        assert(res.status === 'done', 'edit_file (completo) → done');
        assert(res.steps[0].result.status === 'success', 'edit_file devuelve status success');
      })
      // edit_file en modo chunking multi-sección (>8k chars, varias secciones)
      .then(() =>
        p.execute(
          p.planSingleStep('editar', 'edit_file', {
            path: 'largo.md',
            instruction: 'modifica la seccion 5',
          }),
          {}
        )
      )
      .then((res) => {
        assert(res.status === 'done', 'edit_file (chunking multi-sección) → done');
        assert(
          res.steps[0].result.newContent.includes('CONTENIDO GENERADO POR EL LLM STUB'),
          'chunking reconstruye con el contenido del LLM'
        );
      })
      // edit_file con una única sección relevante (token único)
      .then(() =>
        p.execute(
          p.planSingleStep('editar', 'edit_file', {
            path: 'token.md',
            instruction: 'edita unicotoken42',
          }),
          {}
        )
      )
      .then((res) => {
        assert(res.status === 'done', 'edit_file (chunking sección única) → done');
      })
      // LLM devuelve vacío → error controlado
      .then(() => {
        LLMProvider.completeTask = async () => '';
        return p.execute(
          p.planSingleStep('crear', 'create_file', { path: 'x.txt', instruction: 'x' }),
          {}
        );
      })
      .then((res) => {
        assert(
          res.status === 'failed' && res.error.includes('contenido vacío'),
          'LLM vacío → error controlado'
        );
      })
      .then(() => {
        LLMProvider.completeTask = async () => 'CONTENIDO GENERADO POR EL LLM STUB';
      })
  );
}

async function main() {
  setProjectCWD(TMP);
  testPlanConstruction();
  testPlanFromLLMResponse();
  await testExecuteSingle();
  await testExecuteFailure();
  await testExecuteApproval();
  await testExecuteMultiWave();
  await testExecuteDependencyCycle();
  await testExecuteQueue();
  await testCancel();
  await testMCPAndPlugin();
  await testEditCreateFiles();

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
