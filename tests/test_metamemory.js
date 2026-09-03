// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { RetrievalPlanner, isMemoryQuery } = require('../core/grounding/RetrievalPlanner.js');
const { ContextAssembler } = require('../core/grounding/ContextAssembler.js');
const { GroqSerializer } = require('../core/grounding/serializers/GroqSerializer.js');

let passed = 0;
let failed = 0;

/** @param {unknown} condition @param {string} label @param {string} [detail] */
function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function testMetamemoryAssessment() {
  console.log('\nMetamemoria — procedencia, frescura y contradicción');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-metamemory-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const observationId = graph.recordObservation({
      source: 'chat',
      kind: 'user_message',
      content: 'Me llamo Panfilo',
      sessionId: 'meta-1',
    });
    const supportedId = graph.createNode({
      type: 'User',
      label: 'nombre_usuario',
      content: 'El usuario se llama Panfilo',
      importance: 0.9,
    });
    graph.linkMemoryEvidence(supportedId, [observationId], 1);
    const supported = graph.assessMemoryNode(graph.getNode(supportedId));
    assert(supported.status === 'supported', 'reconoce un recuerdo con observación enlazada');
    assert(supported.confidenceBand === 'high', 'la evidencia eleva la banda de confianza');
    assert(supported.mayStateAsFact, 'permite afirmar sólo un recuerdo fresco y apoyado');

    const untracedId = graph.createNode({
      type: 'Preference',
      label: 'preferencia_editor',
      content: 'Prefiere un editor oscuro',
    });
    const untraced = graph.assessMemoryNode(graph.getNode(untracedId));
    assert(untraced.status === 'recorded_without_trace', 'distingue registros sin procedencia');
    assert(!untraced.mayStateAsFact, 'un registro sin traza requiere calificación');

    graph._db
      .prepare('UPDATE nodes SET verified_at=? WHERE id=?')
      .run(Date.now() - 400 * 86400e3, untracedId);
    const stale = graph.assessMemoryNode(graph.getNode(untracedId));
    assert(stale.status === 'stale', 'detecta memoria vencida según su tipo');
    assert(stale.confidenceBand === 'low', 'la memoria vencida baja de confianza');

    graph._db
      .prepare('UPDATE nodes SET verified_at=NULL, created_at=?, updated_at=? WHERE id=?')
      .run(Date.now() - 400 * 86400e3, Date.now(), untracedId);
    const invalidated = graph.assessMemoryNode(graph.getNode(untracedId));
    assert(invalidated.stale, 'una actualización técnica no revalida un recuerdo invalidado');
    assert(
      invalidated.verifiedAt === null,
      'no inventa una fecha de confirmación desde updated_at'
    );

    const tensionId = graph.createNode({
      type: 'Preference',
      label: 'preferencia_editor_nueva',
      content: 'Prefiere un editor claro',
    });
    graph.createRelation({ source: untracedId, target: tensionId, type: 'CONTRADICES' });
    const tensionRecall = graph.assessMemoryRecall({
      nodes: [graph.getNode(untracedId), graph.getNode(tensionId)],
    });
    assert(
      tensionRecall.nodes.every((node) => node._metamemory.status === 'contested'),
      'marca ambos extremos de una contradicción activa'
    );

    const inferredId = graph.createNode({
      type: 'Belief',
      label: 'patron_prueba',
      content: 'Quizá prefiere trabajar temprano',
      inferred: 1,
      confidence: 0.8,
    });
    assert(
      graph.assessMemoryNode(graph.getNode(inferredId)).status === 'inferred',
      'una inferencia nunca se confunde con recuerdo declarado'
    );

    const planner = new RetrievalPlanner(graph);
    const knownRetrieval = await planner.plan('¿qué sabes de mí?', null);
    assert(knownRetrieval.memoryQuery, 'detecta una pregunta explícita sobre memoria');
    assert(
      knownRetrieval.memoryMatchCount > 0,
      'registra coincidencias relevantes separadas del world model'
    );
    const knownContext = new ContextAssembler(graph).build({
      sessionHistory: [{ role: 'user', content: '¿qué sabes de mí?' }],
      retrievalResult: knownRetrieval,
      activeProvider: 'groq',
      includeMemory: true,
    });
    assert(
      knownContext.systemPrompt.includes('apoyada por evidencia'),
      'la procedencia llega al prompt'
    );
    assert(
      knownContext.systemPrompt.includes('confianza alta'),
      'la banda de confianza llega al prompt'
    );
    assert(
      /confirmada \d{4}-\d{2}-\d{2}/.test(knownContext.systemPrompt),
      'la fecha de última confirmación llega al prompt'
    );

    const unknownRetrieval = await planner.plan('¿recuerdas unicornios de ayer?', null);
    const unknownContext = new ContextAssembler(graph).build({
      sessionHistory: [{ role: 'user', content: '¿recuerdas unicornios de ayer?' }],
      retrievalResult: unknownRetrieval,
      activeProvider: 'groq',
      includeMemory: true,
    });
    assert(
      unknownRetrieval.memoryMatchCount === 0,
      'no cuenta hechos ajenos como respuesta temporal'
    );
    assert(
      unknownContext.systemPrompt.includes('No se recuperó un recuerdo relevante'),
      'un hueco obliga a reconocer que no hay memoria fiable'
    );
    assert(
      unknownContext.systemPrompt.includes('no completes el vacío'),
      'el límite prohíbe fabricar continuidad'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPartialAndNoLeak() {
  console.log('\nMetamemoria — recuerdo parcial y privacidad');
  const serializer = new GroqSerializer();
  const partial = serializer.serialize(
    {
      identity: null,
      persistentMemory: {
        nodes: [],
        episodes: [
          {
            content: 'Resumen aproximado de una conversación',
            created_at: Date.now(),
            _metamemory: {
              status: 'recollection_untraced',
              confidenceBand: 'medium',
            },
          },
        ],
      },
      metamemory: { knowledgeState: 'partial', reason: 'memory_requires_qualification' },
    },
    { includeMemory: true }
  ).systemPrompt;
  assert(partial.includes('recuerdo tentativo'), 'un recuerdo parcial exige lenguaje tentativo');
  assert(partial.includes('resumen sin traza'), 'expone la ausencia de procedencia');

  const privateOff = serializer.serialize(
    {
      identity: null,
      persistentMemory: { nodes: [], episodes: [] },
      metamemory: { knowledgeState: 'unknown', reason: 'no_relevant_memory' },
    },
    { includeMemory: false }
  ).systemPrompt;
  assert(
    !privateOff.includes('No se recuperó un recuerdo relevante'),
    'metamemoria local no cruza al proveedor cuando la memoria está desactivada'
  );
  assert(
    isMemoryQuery('hola, ¿cómo estás?') === false,
    'una charla casual no activa huecos falsos'
  );
  assert(
    isMemoryQuery('un recordatorio cualquiera') === false,
    'el detector no confunde fragmentos dentro de otras palabras'
  );
}

async function main() {
  await testMetamemoryAssessment();
  testPartialAndNoLeak();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
