// @ts-check
'use strict';

/**
 * test_enforcement_evaluator.js — Tests para PromptEnforcer y ResponseEvaluator
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── PromptEnforcer Tests ────────────────────────────────────────────────────

const { PromptEnforcer, EMOTION_RULES } = require('../core/behavior/proactive/PromptEnforcer.js');

describe('PromptEnforcer', () => {
  it('should generate rules for frustration', () => {
    const enforcer = new PromptEnforcer(null);
    const enforcement = enforcer.enforce({ frustration: 0.8, enthusiasm: 0.1 });

    assert.ok(enforcement.rules.length > 0, 'has rules');
    assert.ok(enforcement.rules.some((r) => r.includes('preámbulos')), 'has no preambles rule');
    assert.ok(enforcement.forbidden.includes('¿En qué puedo ayudarte?'), 'forbidden phrase');
    assert.equal(enforcement.maxTokens, 80, 'maxTokens for frustration');
  });

  it('should generate rules for enthusiasm', () => {
    const enforcer = new PromptEnforcer(null);
    const enforcement = enforcer.enforce({ frustration: 0.1, enthusiasm: 0.8 });

    assert.ok(enforcement.rules.some((r) => r.includes('Celebra')), 'has celebration rule');
    assert.ok(enforcement.maxTokens > 80, 'more tokens for enthusiasm');
  });

  it('should generate rules for urgency', () => {
    const enforcer = new PromptEnforcer(null);
    const enforcement = enforcer.enforce({ urgency: 0.9 });

    assert.ok(enforcement.rules.some((r) => r.includes('ULTRA-BREVE')), 'has ultra-brief rule');
    assert.equal(enforcement.maxTokens, 60, 'maxTokens for urgency');
  });

  it('should return empty rules for no emotion', () => {
    const enforcer = new PromptEnforcer(null);
    const enforcement = enforcer.enforce({});

    assert.equal(enforcement.rules.length, 0, 'no rules');
    assert.equal(enforcement.maxTokens, 150, 'default maxTokens');
  });

  it('should consider effectiveness history', () => {
    const mockScorer = {
      getEffectiveness: (type) => type === 'badAdapt' ? 0.3 : 0.7,
    };
    const enforcer = new PromptEnforcer(mockScorer);
    const enforcement = enforcer.enforce({ frustration: 0.8 }, null, 'badAdapt');

    assert.ok(enforcement.rules.some((r) => r.includes('Invierte')), 'has inversion rule');
  });

  it('should serialize rules correctly', () => {
    const enforcer = new PromptEnforcer(null);
    const enforcement = enforcer.enforce({ frustration: 0.8 });
    const serialized = enforcer.serialize(enforcement);

    assert.ok(serialized.includes('REGLAS OBLIGATORIAS'), 'has header');
    assert.ok(serialized.includes('1.'), 'has numbered rules');
    assert.ok(serialized.includes('NUNCA'), 'has forbidden section');
  });
});

// ── ResponseEvaluator Tests ─────────────────────────────────────────────────

const { ResponseEvaluator, _evaluateResponse, _computeEngagementDelta } = require('../core/behavior/proactive/ResponseEvaluator.js');

describe('ResponseEvaluator', () => {
  it('should evaluate good response for frustration', () => {
    const enforcement = {
      rules: ['Ve directo al grano'],
      forbidden: ['¿En qué puedo ayudarte?'],
      maxTokens: 80,
    };
    const emotionalCtx = { frustration: 0.8 };

    const result = _evaluateResponse('Veo el error. Prueba con esto:', enforcement, emotionalCtx);
    assert.ok(result.score > 0.7, 'good score');
    assert.equal(result.violations.length, 0, 'no violations');
  });

  it('should detect forbidden phrase', () => {
    const enforcement = {
      rules: [],
      forbidden: ['¿En qué puedo ayudarte?'],
      maxTokens: 80,
    };
    const emotionalCtx = { frustration: 0.8 };

    const result = _evaluateResponse('¿En qué puedo ayudarte?', enforcement, emotionalCtx);
    assert.ok(result.score < 0.8, 'lower score for forbidden phrase');
    assert.ok(result.violations.some((v) => v.includes('frase prohibida')), 'has violation');
  });

  it('should detect inappropriate pattern for urgency', () => {
    const enforcement = {
      rules: [],
      forbidden: [],
      maxTokens: 60,
    };
    const emotionalCtx = { urgency: 0.9 };

    const result = _evaluateResponse('Déjame explicarte primero...', enforcement, emotionalCtx);
    assert.ok(result.score < 0.8, 'lower score for inappropriate pattern');
    assert.ok(result.violations.some((v) => v.includes('inapropiado')), 'has violation');
  });

  it('should detect too long response', () => {
    const enforcement = {
      rules: [],
      forbidden: [],
      maxTokens: 20, // very low maxTokens
    };
    const emotionalCtx = { urgency: 0.9 };

    const longResponse = 'Esta es una respuesta muy larga que tiene mucho texto y debería ser más corta para el usuario que tiene prisa y necesita una respuesta rápida y concisa sin tanta explicación.';
    const result = _evaluateResponse(longResponse, enforcement, emotionalCtx);
    assert.ok(result.violations.some((v) => v.includes('muy larga')), 'has length violation');
  });

  it('should compute engagement delta', () => {
    const improved = _computeEngagementDelta(0.3, 0.8);
    assert.ok(improved.improved, 'improved');
    assert.ok(improved.delta > 0, 'positive delta');

    const notImproved = _computeEngagementDelta(0.8, 0.3);
    assert.ok(!notImproved.improved, 'not improved');
    assert.ok(notImproved.delta < 0, 'negative delta');
  });

  it('should record and evaluate response', () => {
    const mockScorer = {
      updateScore: () => {},
    };
    const evaluator = new ResponseEvaluator(mockScorer);

    evaluator.recordResponse(
      'Veo el error',
      { rules: [], forbidden: [], maxTokens: 80 },
      { frustration: 0.8 },
      'testAdapt'
    );

    const result = evaluator.evaluate(0.7);
    assert.ok(typeof result.quality === 'number', 'has quality');
    assert.equal(result.feedbackApplied, true, 'feedback applied');
  });

  it('should evaluate dry run without updating scorer', () => {
    const evaluator = new ResponseEvaluator(null);
    const result = evaluator.evaluateDryRun(
      'Respuesta directa',
      { rules: [], forbidden: [], maxTokens: 80 },
      { frustration: 0.8 }
    );
    assert.ok(typeof result.score === 'number', 'has score');
    assert.equal(result.passed, true, 'passed');
  });
});

// ── Integration: adaptive-integration with enforcement ──────────────────────

describe('adaptive-integration: enforcement methods', () => {
  it('should have _buildEnforcementRules method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._buildEnforcementRules, 'function');
  });

  it('should have _serializeEnforcement method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._serializeEnforcement, 'function');
  });

  it('should have _recordKaoruResponse method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._recordKaoruResponse, 'function');
  });

  it('should have _evaluateKaoruResponse method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._evaluateKaoruResponse, 'function');
  });
});

// ── EMOTION_RULES completeness ──────────────────────────────────────────────

describe('EMOTION_RULES', () => {
  it('should have rules for all emotions', () => {
    const emotions = ['frustration', 'enthusiasm', 'confusion', 'urgency', 'calm', 'playfulness'];
    for (const emotion of emotions) {
      assert.ok(EMOTION_RULES[emotion], `has rules for ${emotion}`);
      assert.ok(EMOTION_RULES[emotion].hard.length > 0, `${emotion} has hard rules`);
      assert.ok(typeof EMOTION_RULES[emotion].maxTokens === 'number', `${emotion} has maxTokens`);
    }
  });

  it('frustration should forbid greeting phrases', () => {
    assert.ok(EMOTION_RULES.frustration.forbidden.includes('¿En qué puedo ayudarte?'));
    assert.ok(EMOTION_RULES.frustration.forbidden.includes('¡Claro!'));
  });

  it('urgency should have very low maxTokens', () => {
    assert.ok(EMOTION_RULES.urgency.maxTokens <= 60, 'urgency maxTokens <= 60');
  });
});
