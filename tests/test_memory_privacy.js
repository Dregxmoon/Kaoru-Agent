// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { ContradictionResolver } = require('../core/state-graph/ContradictionResolver.js');

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

/** @param {any} graph @param {string} table @param {string} where @param {any[]} [args] */
function count(graph, table, where = '1=1', args = []) {
  return Number(
    graph._db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...args).count
  );
}

function testInspectionCorrectionAndExport() {
  console.log('\nPrivacidad de memoria — inspección, corrección y exportación');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-memory-privacy-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const evidenceId = graph.recordObservation({
      source: 'chat',
      kind: 'user_message',
      content: 'Mi dato secreto es ORQUIDEA-729',
      metadata: { token: 'META-SECRETA-913' },
      sensitivity: 'sensitive',
    });
    const nodeId = Number(
      graph.createNode({
        type: 'Belief',
        label: 'preferencia_horaria',
        content: 'Quizá trabaja mejor por la noche',
        inferred: 1,
        confidence: 0.72,
      })
    );
    graph.linkMemoryEvidence(nodeId, [Number(evidenceId)], 0.8);

    const inspection = graph.inspectMemory(nodeId);
    const serialized = JSON.stringify(inspection);
    assert(inspection.ok, 'permite inspeccionar un recuerdo existente');
    assert(inspection.node.metamemory.status === 'inferred', 'muestra su estado epistémico');
    assert(
      !serialized.includes('ORQUIDEA-729') && !serialized.includes('META-SECRETA-913'),
      'oculta contenido y metadatos sensibles en la interfaz'
    );
    assert(
      inspection.evidence[0].content === '[contenido sensible oculto]',
      'explica que existe evidencia sensible sin revelarla'
    );

    const oldUpdatedAt = inspection.node.updatedAt;
    const corrected = graph.correctMemory({
      nodeId,
      content: 'Trabajo mejor por la mañana',
      reason: 'corrección explícita en el panel',
      expectedUpdatedAt: oldUpdatedAt,
    });
    assert(corrected.ok && corrected.changed, 'acepta una corrección sobre la versión esperada');
    assert(!corrected.node.inferred, 'convierte la corrección del usuario en dato declarado');
    assert(corrected.node.confidence === null, 'no conserva confianza inferida tras la corrección');
    const history = graph.getMemoryRevisionHistory({ nodeId });
    assert(history.transitions.length === 1, 'conserva la versión previa en el historial');
    assert(
      history.transitions[0].policy === 'user_correction',
      'audita el origen de la corrección'
    );

    const stale = graph.correctMemory({
      nodeId,
      content: 'Esta edición no debe aplicarse',
      expectedUpdatedAt: oldUpdatedAt - 1,
    });
    assert(
      !stale.ok && stale.error === 'memory_changed',
      'rechaza una edición sobre una versión obsoleta'
    );
    assert(
      graph.getNode(nodeId).content === 'Trabajo mejor por la mañana',
      'una colisión no altera el recuerdo vigente'
    );

    const privateExport = graph.exportMemorySnapshot({ includeSensitive: false });
    const fullExport = graph.exportMemorySnapshot({ includeSensitive: true });
    assert(
      !JSON.stringify(privateExport).includes('ORQUIDEA-729'),
      'la exportación sanitizada tampoco filtra observaciones sensibles'
    );
    assert(
      JSON.stringify(fullExport).includes('ORQUIDEA-729'),
      'la exportación privada completa conserva los datos del propietario'
    );
    assert(fullExport.revisions.length === 1, 'la exportación incluye el historial de revisiones');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testPhysicalLineageDeletion() {
  console.log('\nPrivacidad de memoria — eliminación física y referencias compartidas');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-memory-delete-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    const resolver = new ContradictionResolver(graph);
    const oldId = Number(
      resolver.resolve({
        type: 'Preference',
        label: 'color_favorito',
        content: 'Su color favorito es azul',
      })
    );
    const currentId = Number(
      resolver.resolve({
        type: 'Preference',
        label: 'color_favorito',
        content: 'Su color favorito es verde',
        revision: { reason: 'cambió de preferencia', source: 'user_statement' },
      })
    );
    const unrelatedId = Number(
      graph.createNode({ type: 'Project', label: 'proyecto_verde', content: 'Proyecto compartido' })
    );
    require('sqlite-vec').load(graph._db);
    graph.enableVectorSearch();
    const insertVector = graph._db.prepare(
      'INSERT INTO node_vectors (rowid, embedding) VALUES (?, ?)'
    );
    insertVector.run(BigInt(oldId), Buffer.alloc(384 * 4));
    insertVector.run(BigInt(currentId), Buffer.alloc(384 * 4));
    const orphanEvidence = Number(
      graph.recordObservation({ source: 'chat', kind: 'user_message', content: 'Antes era azul' })
    );
    const sharedEvidence = Number(
      graph.recordObservation({
        source: 'chat',
        kind: 'user_message',
        content: 'Contexto compartido',
      })
    );
    graph.linkMemoryEvidence(oldId, [orphanEvidence, sharedEvidence]);
    graph.linkMemoryEvidence(unrelatedId, [sharedEvidence]);

    const before = graph.inspectMemory(currentId);
    const deleted = graph.deleteMemoryLineage({
      nodeId: currentId,
      expectedUpdatedAt: before.node.updatedAt,
      includeEvidence: true,
    });
    assert(deleted.ok && deleted.deletedNodes === 2, 'elimina la versión activa y la archivada');
    assert(deleted.deletedEvidence === 1, 'reporta sólo la evidencia huérfana realmente eliminada');
    assert(
      count(graph, 'nodes', 'label=?', ['color_favorito']) === 0,
      'no deja versiones del linaje'
    );
    assert(
      count(graph, 'memory_revisions', 'label=?', ['color_favorito']) === 0,
      'elimina su journal'
    );
    assert(
      count(graph, 'node_vectors', 'rowid IN (?, ?)', [oldId, currentId]) === 0,
      'elimina sus embeddings en la misma transacción'
    );
    assert(
      count(graph, 'observations', 'id=?', [orphanEvidence]) === 0,
      'elimina evidencia huérfana'
    );
    assert(
      count(graph, 'observations', 'id=?', [sharedEvidence]) === 1,
      'preserva evidencia compartida'
    );
    assert(graph.getNode(unrelatedId) != null, 'no afecta recuerdos ajenos al linaje');
    assert(
      graph.inspectMemory(currentId).error === 'memory_not_found',
      'la memoria borrada deja de estar disponible para inspección'
    );
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  testInspectionCorrectionAndExport();
  testPhysicalLineageDeletion();
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main();
