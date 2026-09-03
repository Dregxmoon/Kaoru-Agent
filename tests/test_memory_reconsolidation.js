// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { ContradictionResolver } = require('../core/state-graph/ContradictionResolver.js');
const { StateUpdater } = require('../core/state-graph/StateUpdater.js');
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

function testRevisionChainAndPersistence() {
  console.log('\nReconsolidación — historial inmutable y persistente');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revisions-'));
  const dbPath = path.join(dir, 'memory.db');
  let graph = new StateGraph(dbPath).init();
  try {
    const resolver = new ContradictionResolver(graph);
    const id = resolver.resolve({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Tijuana',
      importance: 0.9,
    });
    resolver.resolve({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Ensenada',
      importance: 0.9,
      revision: {
        reason: 'el usuario corrigió su ciudad',
        source: 'user_statement',
        evidenceIds: [41, 41, 42],
      },
    });
    resolver.resolve({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Mexicali',
      importance: 0.9,
      revision: { reason: 'mudanza confirmada', source: 'user_statement' },
    });

    const history = graph.getMemoryRevisionHistory({ label: 'ubicacion_usuario' });
    assert(history.transitions.length === 2, 'registra cada transición sin sobrescribirla');
    assert(history.versions.length === 3, 'reconstruye original, corrección y versión vigente');
    assert(history.versions[0].content === 'Vive en Tijuana', 'conserva el contenido original');
    assert(history.versions[1].content === 'Vive en Ensenada', 'conserva la primera corrección');
    assert(history.versions[2].content === 'Vive en Mexicali', 'identifica la versión vigente');
    assert(history.versions[2].status === 'current', 'marca sólo la última versión como vigente');
    assert(history.current?.id === id, 'overwrite conserva el contrato de identidad del nodo');
    assert(
      history.transitions[0].evidenceIds.join(',') === '41,42',
      'normaliza y conserva referencias de evidencia'
    );
    assert(
      history.transitions[0].reason === 'el usuario corrigió su ciudad',
      'conserva el motivo de corrección'
    );

    graph.close();
    graph = new StateGraph(dbPath).init();
    const restored = graph.getMemoryRevisionHistory({ nodeId: Number(id) });
    assert(restored.versions.length === 3, 'el historial sobrevive al reinicio');
    assert(restored.current?.content === 'Vive en Mexicali', 'restaura la versión vigente');

    const assessment = graph.assessMemoryNode(graph.getNode(Number(id)));
    assert(assessment.revisionCount === 2, 'metamemoria conoce cuántas revisiones hubo');
    assert(assessment.lastCorrectedAt > 0, 'metamemoria conoce la última corrección');
    const prompt = new GroqSerializer().serialize(
      {
        identity: null,
        persistentMemory: {
          nodes: [{ ...graph.getNode(Number(id)), _metamemory: assessment }],
          episodes: [],
        },
      },
      { includeMemory: true }
    ).systemPrompt;
    assert(
      prompt.includes('revisada 2 veces'),
      'el prompt expone el historial sin copiarlo completo'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPoliciesAndExplicitTensionResolution() {
  console.log('\nReconsolidación — políticas y tensión explícita');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revision-policy-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const resolver = new ContradictionResolver(graph);
    const oldColor = resolver.resolve({
      type: 'Preference',
      label: 'color_favorito',
      content: 'Su color favorito es azul',
    });
    const newColor = resolver.resolve({
      type: 'Preference',
      label: 'color_favorito',
      content: 'Su color favorito es verde',
      revision: { reason: 'preferencia actualizada', source: 'user_statement' },
    });
    const colorHistory = graph.getMemoryRevisionHistory({ label: 'color_favorito' });
    assert(oldColor !== newColor, 'archive_and_replace mantiene nodos distintos');
    assert(colorHistory.transitions[0].previousNodeId === oldColor, 'enlaza el nodo reemplazado');
    assert(colorHistory.transitions[0].currentNodeId === newColor, 'enlaza el nodo vigente');

    const first = resolver.resolve({
      type: 'Belief',
      label: 'observaciones_usuario',
      content: 'Prefiere trabajar solo',
    });
    const second = resolver.resolve({
      type: 'Belief',
      label: 'observaciones_usuario',
      content: 'Prefiere colaborar en equipo',
    });
    assert(graph.getTensions().length === 1, 'la contradicción permanece abierta inicialmente');

    const invalid = graph.resolveMemoryTension({
      winnerNodeId: Number(newColor),
      loserNodeId: Number(first),
    });
    assert(!invalid.resolved, 'rechaza resolver nodos que no forman la misma tensión');

    const resolved = graph.resolveMemoryTension({
      winnerNodeId: Number(second),
      loserNodeId: Number(first),
      reason: 'el usuario confirmó que ahora prefiere colaborar',
      source: 'user_confirmation',
      evidenceIds: [77],
    });
    assert(resolved.resolved, 'resuelve una tensión con elección explícita');
    assert(graph.getNode(Number(first)).archived === 1, 'archiva sólo la versión descartada');
    assert(graph.getNode(Number(second)).archived === 0, 'mantiene activa la versión elegida');
    assert(graph.getTensions().length === 0, 'la tensión deja de estar activa');
    const tensionHistory = graph.getMemoryRevisionHistory({ label: 'observaciones_usuario' });
    assert(tensionHistory.transitions[0].policy === 'resolve_tension', 'audita la resolución');
    assert(tensionHistory.transitions[0].source === 'user_confirmation', 'conserva su procedencia');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testAtomicRollback() {
  console.log('\nReconsolidación — rollback atómico');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revision-rollback-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const resolver = new ContradictionResolver(graph);
    const id = resolver.resolve({
      type: 'User',
      label: 'trabajo_usuario',
      content: 'Trabaja en una biblioteca',
    });
    const originalRecorder = graph._recordMemoryRevision.bind(graph);
    graph._recordMemoryRevision = () => {
      throw new Error('fallo simulado del journal');
    };
    let threw = false;
    try {
      resolver.resolve({
        type: 'User',
        label: 'trabajo_usuario',
        content: 'Trabaja en un museo',
      });
    } catch (_) {
      threw = true;
    }
    graph._recordMemoryRevision = originalRecorder;
    assert(threw, 'propaga el fallo del journal');
    assert(
      graph.getNode(Number(id)).content === 'Trabaja en una biblioteca',
      'revierte el cambio si no puede preservar la historia'
    );
    assert(
      graph.getMemoryRevisionHistory({ label: 'trabajo_usuario' }).transitions.length === 0,
      'no deja una transición parcial'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testStateUpdaterProvenance() {
  console.log('\nReconsolidación — procedencia desde conversación');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revision-source-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const updater = new StateUpdater(graph);
    const sessionId = 'revision-session';
    const original = 'tengo 30 años';
    const correction = 'en realidad tengo 31 años';
    graph.recordObservation({
      source: 'chat',
      kind: 'user_message',
      content: original,
      sessionId,
    });
    updater.detectAndSaveInstant(original, { sessionId });
    const correctionEvidence = graph.recordObservation({
      source: 'chat',
      kind: 'user_message',
      content: correction,
      sessionId,
    });
    updater.detectAndSaveInstant(correction, { sessionId });

    const history = graph.getMemoryRevisionHistory({ label: 'edad_usuario' });
    assert(history.transitions.length === 1, 'StateUpdater registra la corrección automática');
    assert(history.transitions[0].source === 'user_statement', 'la atribuye al usuario');
    assert(
      history.transitions[0].evidenceIds[0] === correctionEvidence,
      'enlaza la observación exacta que causó el cambio'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testDirectUpdateCoverage() {
  console.log('\nReconsolidación — cobertura de rutas directas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revision-direct-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const id = graph.createNode({
      type: 'Project',
      label: 'proyecto_contexto',
      content: 'Contexto inicial',
    });
    graph.updateNode(id, {
      content: 'Contexto compactado',
      revision: {
        policy: 'compaction',
        source: 'agent_loop',
        reason: 'compactación del contexto',
      },
    });
    graph.updateNode(id, { importance: 0.9 });
    const direct = graph.getMemoryRevisionHistory({ label: 'proyecto_contexto' });
    assert(direct.transitions.length === 1, 'audita cambios directos de contenido');
    assert(direct.transitions[0].policy === 'compaction', 'conserva la política del llamador');
    assert(
      direct.transitions[0].source === 'agent_loop',
      'conserva la fuente de la actualización directa'
    );
    assert(direct.transitions.length === 1, 'no registra cambios sólo de metadata como revisiones');

    graph.upsertNode({
      type: 'Belief',
      label: 'consolidacion_prueba',
      content: 'Patrón inicial',
      inferred: 1,
    });
    graph.upsertNode({
      type: 'Belief',
      label: 'consolidacion_prueba',
      content: 'Patrón actualizado',
      inferred: 1,
    });
    const upserted = graph.getMemoryRevisionHistory({ label: 'consolidacion_prueba' });
    assert(upserted.transitions.length === 1, 'upsert tampoco reescribe silenciosamente');
    assert(upserted.transitions[0].policy === 'upsert', 'identifica la reconsolidación por upsert');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testForgetRemovesRevisionHistory() {
  console.log('\nReconsolidación — compatibilidad con olvidar');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-revision-forget-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const resolver = new ContradictionResolver(graph);
    resolver.resolve({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Rosarito',
    });
    resolver.resolve({
      type: 'User',
      label: 'ubicacion_usuario',
      content: 'Vive en Tecate',
    });
    assert(
      graph.getMemoryRevisionHistory({ label: 'ubicacion_usuario' }).transitions.length === 1,
      'setup: existe historial antes de olvidar'
    );
    graph.forget('ubicacion_usuario');
    assert(
      graph.getMemoryRevisionHistory({ label: 'ubicacion_usuario' }).transitions.length === 0,
      'olvidar retira también snapshots y motivos del journal'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  testRevisionChainAndPersistence();
  testPoliciesAndExplicitTensionResolution();
  testAtomicRollback();
  testStateUpdaterProvenance();
  testDirectUpdateCoverage();
  testForgetRemovesRevisionHistory();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main();
