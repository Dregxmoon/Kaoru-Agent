'use strict';

// Telemetría de vía de detección: ¿regex, fusión, clasificador, árbitro o nada?
// Responde con datos "¿qué tan multilingüe es Kaoru de verdad?".

const path = require('path');
const fs = require('fs');
const os = require('os');

const DetectionTelemetry = require('../core/telemetry/DetectionTelemetry.js');
const { TelemetryStore } = require('../core/telemetry/TelemetryStore.js');

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

async function main() {
  console.log('\n── DetectionTelemetry en memoria ──');
  DetectionTelemetry.reset();
  let stats = DetectionTelemetry.getStats();
  assert(stats.total === 0, 'empieza vacío');

  DetectionTelemetry.recordDetection({
    path: 'regex',
    domain: { id: 'web' },
    confidence: 'high',
    lang: 'es',
  });
  DetectionTelemetry.recordDetection({
    path: 'classifier',
    domain: { id: 'web' },
    confidence: 'medium',
    lang: 'en',
  });
  DetectionTelemetry.recordDetection({
    path: 'classifier',
    domain: 'system',
    confidence: 'medium',
    lang: 'ja',
  });
  DetectionTelemetry.recordDetection({
    path: 'none',
    domain: null,
    confidence: 'none',
    lang: 'es',
  });
  DetectionTelemetry.recordDetection({ path: 'inexistente', domain: null });
  stats = DetectionTelemetry.getStats();
  assert(stats.total === 5, '5 eventos (vía inválida cae a none)');
  assert(stats.byPath.regex === 1, 'regex: 1');
  assert(stats.byPath.classifier === 2, 'classifier: 2');
  assert(stats.byPath.none === 2, 'none: 2 (1 real + 1 inválida)');
  assert(stats.byPathDomain['classifier|web'] === 1, 'desglose vía+dominio');
  assert(
    stats.byPathDomain['classifier|system'] === 1,
    'multilingüe visible: system vía classifier'
  );
  assert(stats.recent.length === 5, 'ring buffer conserva');
  assert(stats.recent[0].lang === 'es', 'guarda idioma');

  DetectionTelemetry.reset();
  assert(DetectionTelemetry.getStats().total === 0, 'reset limpia');

  console.log('\n── TelemetryStore persistente ──');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-telemetry-'));
  const file = path.join(dir, 'telemetry.json');
  const store = new TelemetryStore({ filePath: file });
  store.recordDetectionPath('regex');
  store.recordDetectionPath('classifier');
  store.recordDetectionPath('classifier');
  store.recordDetectionPath('no-existe');
  const summary = store.monthSummary();
  assert(summary.detectionPaths.regex === 1, 'regex persistido');
  assert(summary.detectionPaths.classifier === 2, 'classifier persistido');
  assert(summary.detectionPaths.arbitrator === 0, 'árbitro en cero sin uso');
  assert(summary.detectionPaths.none === 0, 'vía inválida ignorada, no contada');

  const reopened = new TelemetryStore({ filePath: file });
  const summary2 = reopened.monthSummary();
  assert(summary2.detectionPaths.classifier === 2, 'sobrevive reinicio en disco');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nResultado: ${passed} passed  ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
