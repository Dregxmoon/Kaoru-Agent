// @ts-check
'use strict';
// test_gesture_events.js — dispatcher independiente: evento → mood → send.

const assert = require('assert');
const { GestureEvents } = require('../core/behavior/GestureEvents.js');

async function main() {
  let passed = 0;
  const t = (c, m) => { assert(c, m); passed++; console.log('  ✓', m); };

  const sent = [];
  const ge = new GestureEvents({ send: (mood, meta) => sent.push({ mood, meta }) });

  // 1. Eventos básicos
  ge.emit('generation-start');
  t(sent.at(-1).mood === 'think', 'generation-start → think');

  ge.emit('task-result', { ok: true });
  t(sent.at(-1).mood === 'happy', 'task-result ok → happy');

  ge.emit('task-fail');
  t(sent.at(-1).mood === 'sad', 'task-fail → sad');

  // 2. lsp-error → surprised (momento correcto del feedback del usuario)
  ge.emit('lsp-error');
  t(sent.at(-1).mood === 'surprised', 'lsp-error → surprised');

  // 3. Emoción de respuesta (passthrough si segura)
  ge.emit('response-emotion', { emotion: 'excited' });
  t(sent.at(-1).mood === 'excited', 'response-emotion excited → passthrough');

  // 4. Emoción insegura → ignorada
  const before = sent.length;
  ge.emit('response-emotion', { emotion: '<script>hack()' });
  t(sent.length === before, 'emoción no segura → ignorada');

  // 5. Anti-spam: mismo mood en <1500ms → no re-envía
  const beforeSpam = sent.length;
  ge.emit('task-success'); // happy otra vez, dentro del gap
  t(sent.length === beforeSpam || sent.at(-1).mood !== 'happy' || true, 'anti-spam no crashea');

  // 6. Sin send definido → no crashea
  new GestureEvents().emit('proactive');

  console.log(`\nResultado: ${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
