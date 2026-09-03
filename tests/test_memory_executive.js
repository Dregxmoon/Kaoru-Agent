// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateGraph } = require('../core/state-graph/StateGraph.js');
const { LearningEngine } = require('../core/learning/LearningEngine.js');
const { evaluateTaskOutcome } = require('../core/learning/OutcomeEvaluator.js');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function testOutcomeEvidence() {
  console.log('\nOutcomeEvaluator — éxito basado en evidencia');
  const passedEdit = evaluateTaskOutcome({
    toolResults: [{ tool: 'edit', ok: true }],
    verify: { status: 'passed' },
    error: null,
  });
  assert(passedEdit.success, 'una mutación verificada alimenta éxito');
  assert(passedEdit.verificationStatus === 'verified', 'conserva estado verified');

  const unverifiedEdit = evaluateTaskOutcome({
    toolResults: [{ tool: 'edit', ok: true }],
    verify: { status: 'skipped', reason: 'no_command' },
    error: null,
  });
  assert(!unverifiedEdit.success, 'una mutación sin verificación no se refuerza como éxito');
  assert(unverifiedEdit.terminalSuccess, 'separa terminación de éxito verificable');

  const failedVerify = evaluateTaskOutcome({
    toolResults: [{ tool: 'write', ok: true }],
    verify: { status: 'failed' },
    error: null,
  });
  assert(failedVerify.verificationStatus === 'failed', 'un check fallido domina el cierre textual');

  const push = evaluateTaskOutcome({
    toolResults: [{ tool: 'git_push', ok: true }],
    verify: { status: 'skipped', reason: 'no_mutations' },
    error: null,
  });
  assert(
    push.success && push.verificationReason === 'tool_confirmed',
    'push exitoso es evidencia directa'
  );
}

function testWorkingMemory() {
  console.log('\nWorkingMemory — foco por sesión y expiración');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-working-'));
  const graph = new StateGraph(path.join(dir, 'memory.db')).init();
  try {
    assert(
      graph.setWorkingMemory({
        scope: 'session:s1',
        key: 'current_goal',
        value: { goal: 'Arreglar CI', status: 'active' },
        ttlMs: 60_000,
      }),
      'guarda foco ejecutivo'
    );
    const row = graph.getWorkingMemory('session:s1', 'current_goal');
    assert(row?.value?.goal === 'Arreglar CI', 'recupera valor estructurado');
    const section = graph.buildWorkingMemorySection('session:s1') || '';
    assert(section.includes('ESTADO, NO AUTORIZACIÓN'), 'el prompt declara el límite de autoridad');
    assert(section.includes('Arreglar CI'), 'el foco llega al prompt');

    graph._db
      .prepare('UPDATE working_memory SET expires_at=? WHERE scope=? AND key=?')
      .run(Date.now() - 1, 'session:s1', 'current_goal');
    assert(graph.listWorkingMemory('session:s1').length === 0, 'no recupera slots expirados');
    graph.applyDecay();
    const count = graph._db.prepare('SELECT COUNT(*) AS c FROM working_memory').get().c;
    assert(count === 0, 'decay poda estado efímero vencido');
  } finally {
    graph.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testVersionedReflections() {
  console.log('\nLearningEngine — reflexión propuesta y aprobación explícita');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-reflection-'));
  const filePath = path.join(dir, 'learning.json');
  const engine = new LearningEngine({ filePath });
  try {
    for (let i = 0; i < 3; i++) {
      engine.recordTaskOutcome({
        mode: 'smart',
        success: false,
        terminalSuccess: true,
        verificationStatus: 'unverified',
        verificationReason: 'verification_missing',
        goal: `Tarea ${i}`,
      });
    }
    const proposals = engine.listReflectionProposals({ status: 'proposed' });
    assert(proposals.length === 1, 'tres fallos equivalentes crean una propuesta');
    assert(proposals[0].version === 1, 'la propuesta está versionada');
    assert(engine.buildPromptSection() === null, 'una propuesta pendiente no modifica conducta');
    assert(engine.decideReflection(proposals[0].id, 'approved'), 'acepta decisión explícita');
    const section = engine.buildPromptSection() || '';
    assert(
      section.includes('Estrategia aprobada v1'),
      'solo la estrategia aprobada entra al prompt'
    );

    const reloaded = new LearningEngine({ filePath });
    assert(
      reloaded.listReflectionProposals({ status: 'approved' }).length === 1,
      'la decisión sobrevive al reinicio'
    );

    const rejectedFile = path.join(dir, 'rejected.json');
    const rejected = new LearningEngine({ filePath: rejectedFile });
    for (let i = 0; i < 3; i++) {
      rejected.recordTaskOutcome({
        mode: 'smart',
        success: false,
        verificationStatus: 'failed',
        verificationReason: 'verification_failed',
      });
    }
    const v1 = rejected.listReflectionProposals()[0];
    assert(
      rejected.decideReflection(v1.id, 'rejected'),
      'permite rechazar sin activar la estrategia'
    );
    const decisionTime = Date.now();
    while (Date.now() <= decisionTime) {
      // El timestamp permite distinguir evidencia nueva sin temporizadores asíncronos.
    }
    for (let i = 0; i < 3; i++) {
      rejected.recordTaskOutcome({
        mode: 'smart',
        success: false,
        verificationStatus: 'failed',
        verificationReason: 'verification_failed',
      });
    }
    const v2 = rejected.listReflectionProposals({ status: 'proposed' });
    assert(v2.length === 1 && v2[0].version === 2, 'nueva evidencia crea v2 tras rechazar v1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testOutcomeEvidence();
testWorkingMemory();
testVersionedReflections();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
