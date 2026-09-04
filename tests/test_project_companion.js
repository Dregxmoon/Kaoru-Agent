// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { ProactiveEngine } = require('../core/behavior/ProactiveEngine.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label */
function assert(condition, label) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    failed++;
  }
}

async function main() {
  console.log('\nCompañero de proyecto — continuidad aislada por workspace');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-project-companion-'));
  const projectA = path.join(dir, 'kaoru');
  const projectB = path.join(dir, 'tienda');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  let workspace = projectA;
  const engine = new ProactiveEngine(graph, {
    getWorkspace: () => workspace,
    getFocusedFile: () => path.join(workspace, 'core', 'index.js'),
  });
  try {
    engine._captureProjectUpdate(
      'El objetivo de este proyecto es mejorar el módulo de memoria y el siguiente paso es probar la integración'
    );
    engine._captureProjectUpdate('Estoy atorado con un error del módulo de memoria');
    const stateA = graph.getProjectCompanion(projectA);
    assert(stateA?.objective?.includes('mejorar'), 'recuerda el objetivo declarado');
    assert(stateA?.blocker?.includes('error'), 'recuerda un bloqueo explícito como vigente');
    assert(stateA?.nextStep?.includes('probar'), 'conserva el siguiente paso');

    graph.updateProjectCompanion({
      workspace: projectA,
      eventType: 'test_backdate',
      now: Date.now() - 3 * 60 * 60 * 1000,
    });
    let resumeTriggers = 0;
    engine._tryTrigger = async () => {
      resumeTriggers++;
      return 'Retomamos desde el bloqueo guardado.';
    };
    engine.setOSSensor({
      getCurrentContext: () => ({ category: 'browser', title: 'Búsqueda' }),
      getTodaySummary: () => '',
    });
    await engine._onProjectWorkspaceChanged({ path: projectA });
    assert(resumeTriggers === 0, 'no menciona el proyecto al navegar o buscar');
    engine.setOSSensor({
      getCurrentContext: () => ({ category: 'code', title: 'kaoru/core/index.js' }),
      getTodaySummary: () => '',
    });
    await engine._onProjectWorkspaceChanged({ path: projectA });
    assert(resumeTriggers === 1, 'propone retomar al volver realmente al workspace de trabajo');
    assert(
      graph.getProjectCompanion(projectA)?.lastPromptedAt,
      'persiste el cooldown de continuidad entre reinicios'
    );

    workspace = projectB;
    engine._observeProjectFocus({ category: 'code', title: 'tienda/index.js' });
    const stateB = engine._getCurrentProjectCompanion();
    assert(stateB?.projectName === 'tienda', 'al cambiar de workspace cambia el hilo activo');
    assert(!stateB?.objective && !stateB?.blocker, 'no filtra datos del proyecto anterior');

    workspace = projectA;
    engine._captureProjectUpdate(
      'Ya resolví el bug del proyecto y ahora voy a ejecutar las pruebas'
    );
    const resumed = graph.getProjectCompanion(projectA);
    assert(resumed?.blocker === null, 'un avance explícito limpia el bloqueo anterior');
    assert(resumed?.lastProgress?.includes('el bug'), 'mantiene el último avance comprobado');

    engine.setOSSensor({
      getCurrentContext: () => ({ category: 'code', title: 'kaoru/core/index.js' }),
      getTodaySummary: () => '',
    });
    const promptContext = await engine._buildMemoryContext({
      type: 'lsp_error',
      context: 'error actual en index.js',
    });
    assert(
      promptContext.includes('Estado comprobado del proyecto activo (kaoru)'),
      'inyecta continuidad en foco de trabajo'
    );
    assert(
      !promptContext.includes('tienda/index.js'),
      'el prompt no contiene estado de otro workspace'
    );

    const exported = graph.exportMemorySnapshot();
    assert(exported.projectCompanions.length === 2, 'el usuario puede exportar estos hilos');

    const before = engine._recentUserTurns.length;
    engine._bus.emit('memory:turn-added', { role: 'user', content: 'mensaje normal' });
    assert(
      engine._recentUserTurns.length === before + 1,
      'cada turno recibido por el bus se contabiliza una sola vez'
    );
  } finally {
    engine.stop();
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
