// @ts-check
'use strict';

const assert = require('assert');
const { reviewMissionPlan, validatePlanReview } = require('../core/desktop/MissionPlanReviewer.js');

const mission = {
  goal: 'Create a note and schedule a reminder / メモを作って通知を設定して',
  applications: ['Notas', 'Agenda'],
  steps: [
    {
      description: 'Create the note',
      expected: { type: 'ui_visible', application: 'Notas', name: 'Nota creada', role: 'label' },
    },
    {
      description: '通知を設定する',
      expected: { type: 'ui_visible', application: 'Agenda', name: '通知済み', role: 'label' },
    },
  ],
};

/** @param {Record<string,unknown>} params */
function result(params) {
  return { content: '', toolCalls: [{ tool: 'mission_plan_review', params }] };
}

async function main() {
  let calls = 0;
  const accepted = await reviewMissionPlan(mission, {
    model: async (/** @type {any[]} */ messages, /** @type {string} */ prompt) => {
      calls++;
      assert.strictEqual(JSON.parse(messages[0].content).goal, mission.goal);
      assert(prompt.includes('idioma original'));
      return result({ covered: true, gaps: [], weakSteps: [] });
    },
  });
  assert.strictEqual(accepted.covered, true);
  assert.strictEqual(calls, 1, 'solo una revisión focal por plan');

  const omitted = await reviewMissionPlan(
    { ...mission, applications: ['Notas'], steps: [mission.steps[0]] },
    {
      model: async () =>
        result({ covered: false, gaps: ['Falta configurar la notificación'], weakSteps: [] }),
    }
  );
  assert.strictEqual(omitted.covered, false);
  assert.strictEqual(omitted.error, 'mission_plan_incomplete');
  assert(omitted.gaps[0].includes('notificación'));

  const weak = await reviewMissionPlan(mission, {
    model: async () => result({ covered: false, gaps: [], weakSteps: [1] }),
  });
  assert.deepStrictEqual(weak.weakSteps, [1]);
  assert.strictEqual(weak.covered, false);

  assert.strictEqual(
    validatePlanReview({ covered: true, gaps: ['Omitido'], weakSteps: [] }, 2).covered,
    false,
    'covered=true nunca vence una brecha declarada'
  );
  assert.strictEqual(
    validatePlanReview({ covered: true, gaps: [], weakSteps: [2] }, 2).covered,
    false,
    'covered=true nunca vence una postcondición débil'
  );
  for (const malformed of [
    { covered: true, gaps: [''], weakSteps: [] },
    { covered: true, gaps: [], weakSteps: [99] },
    { covered: true, gaps: [], weakSteps: ['1'] },
  ]) {
    assert.strictEqual(
      validatePlanReview(malformed, 2).error,
      'review_invalid',
      'una revisión malformada no concede el pase'
    );
  }
  const missing = await reviewMissionPlan(mission, {
    model: async () => ({ content: 'Todo bien', toolCalls: [] }),
  });
  assert.strictEqual(missing.error, 'review_missing', 'texto libre no concede el pase');

  const invalid = await reviewMissionPlan(
    {
      ...mission,
      steps: [
        {
          description: 'Enviar',
          expected: {
            type: 'ui_visible',
            application: 'Notas',
            name: 'Enviar',
            role: 'button',
          },
        },
      ],
    },
    {
      model: async () => {
        throw new Error('No se debe llamar');
      },
    }
  );
  assert.strictEqual(invalid.error, 'mission_plan_invalid');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await reviewMissionPlan(mission, {
    signal: controller.signal,
    model: async () => {
      throw new Error('No se debe llamar');
    },
  });
  assert.strictEqual(cancelled.error, 'cancelled');

  console.log('Desktop mission reviewer: 8 escenarios aprobados');
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
