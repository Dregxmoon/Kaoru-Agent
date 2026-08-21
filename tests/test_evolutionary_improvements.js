// @ts-check
'use strict';

/**
 * test_evolutionary_improvements.js — Tests para las mejoras del sistema evolutivo:
 *   1. FeedbackScorer (sin DB - solo lógica en memoria)
 *   2. LLMEotionDetector (fallback regex)
 *   3. Integración con ProactiveEngine
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── FeedbackScorer Tests (sin DB) ───────────────────────────────────────────

const { _computeTurnEngagement, _detectFrustration } = require('../core/state-graph/evolution/FeedbackScorer.js');

describe('FeedbackScorer: engagement & frustration detection', () => {
  it('should compute engagement scores', () => {
    const low = _computeTurnEngagement('ok', false);
    const medium = _computeTurnEngagement('Sí, me gusta mucho programar en JavaScript y hacer proyectos', false);
    const high = _computeTurnEngagement('¡¡Waaah!! ¿Cómo lograste hacer eso tan rápido? 🎉', false);

    // Low should be less than high
    assert.ok(low < high, 'short message < long enthusiastic message');
    // High should have emoji boost
    assert.ok(high > 0.5, 'high engagement for long message with emoji');
  });

  it('should detect frustration', () => {
    const neutral = _detectFrustration('hola');
    const frustrated = _detectFrustration('esto no funciona, me tiene FRUSTRADO');

    assert.ok(neutral < frustrated, 'neutral < frustrated');
    assert.ok(frustrated > 0.3, 'frustration detected');
  });

  it('should detect urgency in messages', () => {
    const normal = _detectFrustration('¿cómo estás?');
    const urgent = _detectFrustration('NECESITO ESTO AHORA URGENTE!!!');

    assert.ok(urgent > normal, 'urgent > normal');
  });

  it('should handle empty messages', () => {
    const score = _computeTurnEngagement('', false);
    assert.ok(score >= 0 && score <= 1, 'score in range');
  });

  it('should boost score for questions', () => {
    const statement = _computeTurnEngagement('Me gusta JavaScript', false);
    const question = _computeTurnEngagement('¿Te gusta JavaScript?', false);

    assert.ok(question >= statement, 'question >= statement');
  });

  it('should boost score for emojis', () => {
    const plain = _computeTurnEngagement('Genial', false);
    const withEmoji = _computeTurnEngagement('Genial 🎉', false);

    assert.ok(withEmoji >= plain, 'emoji >= plain');
  });
});

// ── LLMEotionDetector Tests ─────────────────────────────────────────────────

const { LLMEotionDetector } = require('../core/state-graph/evolution/LLMEotionDetector.js');

describe('LLMEotionDetector', () => {
  it('should detect frustration in fallback mode', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });
    const result = await detector.detect('esto no funciona, me tiene frustrado');

    assert.ok(result.frustration > 0.5, 'frustration detected');
    assert.equal(result.implicitIntent, 'venting');
  });

  it('should detect enthusiasm in fallback mode', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });
    const result = await detector.detect('¡¡Increíble!! ¡Logré terminar el proyecto!');

    assert.ok(result.enthusiasm > 0.5, 'enthusiasm detected');
    assert.equal(result.implicitIntent, 'sharing_achievement');
  });

  it('should detect confusion in fallback mode', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });
    const result = await detector.detect('¿Cómo funciona esto? No entiendo');

    assert.ok(result.confusion > 0.5, 'confusion detected');
    assert.equal(result.implicitIntent, 'seeking_help');
  });

  it('should detect calm for neutral messages', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });
    const result = await detector.detect('hola, ¿cómo estás?');

    assert.ok(result.calm > 0.3, 'calm detected');
    assert.equal(result.tone, 'casual');
  });

  it('should cache results', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });

    const result1 = await detector.detect('test message for caching');
    const result2 = await detector.detect('test message for caching');

    assert.deepEqual(result1, result2, 'cached result matches');
  });

  it('should handle empty/null messages', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });

    const empty = await detector.detect('');
    const nullish = await detector.detect(null);

    assert.equal(empty.implicitIntent, 'none');
    assert.equal(nullish.implicitIntent, 'none');
  });

  it('should detect playfulness', async () => {
    const detector = new LLMEotionDetector(null, { enabled: false });
    const result = await detector.detect('jaja eso fue una buena broma XD');

    assert.ok(result.playfulness > 0.5, 'playfulness detected');
  });
});

// ── BehaviorModel Integration Tests ─────────────────────────────────────────

describe('BehaviorModel: emotional context integration', () => {
  it('should export BehaviorModel class', () => {
    const BehaviorModel = require('../core/behavior/BehaviorModel.js');
    assert.ok(BehaviorModel, 'BehaviorModel exported');
  });

  it('should apply emotional context to behavior evaluation', () => {
    const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
    const bm = new BehaviorModel();

    const ctx = bm.evaluate(
      'esto no funciona',
      null,
      [],
      null,
      { frustration: 0.8, tone: 'casual', energy: 'high', implicitIntent: 'venting' }
    );

    // Tone is detected by TONE_RULES regex, not emotional context
    // But frustration should add a note and adjust response length
    assert.equal(ctx.responseLength, 'brief'); // frustration → brief
    assert.ok(ctx.notes.some((n) => n.includes('frustrado')), 'frustration note added');
  });

  it('should handle null emotional context gracefully', () => {
    const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
    const bm = new BehaviorModel();

    const ctx = bm.evaluate('hola', null, [], null, null);
    assert.ok(ctx, 'context returned');
    assert.equal(ctx.emotionalCtx, null);
  });

  it('should apply enthusiasm context', () => {
    const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
    const bm = new BehaviorModel();

    const ctx = bm.evaluate(
      '¡Genial!',
      null,
      [],
      null,
      { enthusiasm: 0.8, tone: 'casual', energy: 'high', implicitIntent: 'sharing_achievement' }
    );

    assert.ok(ctx.notes.some((n) => n.includes('entusiasmado')), 'enthusiasm note added');
  });

  it('should apply urgency context', () => {
    const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
    const bm = new BehaviorModel();

    const ctx = bm.evaluate(
      'NECESITO ESTO AHORA',
      null,
      [],
      null,
      { urgency: 0.8, tone: 'casual', energy: 'high', implicitIntent: 'none' }
    );

    assert.equal(ctx.responseLength, 'brief'); // urgency → brief
    assert.ok(ctx.notes.some((n) => n.includes('urgencia')), 'urgency note added');
  });

  it('should apply confusion context', () => {
    const { BehaviorModel } = require('../core/behavior/BehaviorModel.js');
    const bm = new BehaviorModel();

    const ctx = bm.evaluate(
      'No entiendo esto',
      null,
      [],
      null,
      { confusion: 0.8, tone: 'casual', energy: 'medium', implicitIntent: 'seeking_help' }
    );

    assert.ok(ctx.notes.some((n) => n.includes('confundido')), 'confusion note added');
  });
});

// ── ProactiveEngine Integration Tests ───────────────────────────────────────

describe('ProactiveEngine: adaptive-integration mixin', () => {
  it('should have _buildEmotionalContext method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._buildEmotionalContext, 'function');
  });

  it('should have _buildTopicContext method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._buildTopicContext, 'function');
  });

  it('should have _recordAdaptationFeedback method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._recordAdaptationFeedback, 'function');
  });

  it('should have _shouldAdaptStyle method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._shouldAdaptStyle, 'function');
  });

  it('should have _detectEmotionsFallback method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._detectEmotionsFallback, 'function');
  });

  it('should have _processAdaptationFeedback method', () => {
    const adaptiveIntegration = require('../core/behavior/proactive/mixins/adaptive-integration.js');
    assert.equal(typeof adaptiveIntegration._processAdaptationFeedback, 'function');
  });
});

// ── AdaptiveResponseEngine Tests (sin DB) ───────────────────────────────────

describe('AdaptiveResponseEngine: shouldAdapt logic', () => {
  it('shouldAdapt returns true when no feedbackScorer', () => {
    const { AdaptiveResponseEngine } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    const engine = new AdaptiveResponseEngine(null, null, null, null);
    assert.equal(engine.shouldAdapt('unknownType'), true);
  });

  it('shouldAdapt returns true for unknown adaptations', () => {
    // Create a mock FeedbackScorer
    const mockScorer = {
      getEffectiveness: () => 0.5, // default effectiveness
    };
    const { AdaptiveResponseEngine } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    const engine = new AdaptiveResponseEngine(null, null, null, mockScorer);
    assert.equal(engine.shouldAdapt('unknownType'), true);
  });

  it('shouldAdapt rejects ineffective adaptations', () => {
    const mockScorer = {
      getEffectiveness: (type) => type === 'badAdapt' ? 0.3 : 0.7,
    };
    const { AdaptiveResponseEngine } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    const engine = new AdaptiveResponseEngine(null, null, null, mockScorer);

    assert.equal(engine.shouldAdapt('goodAdapt'), true);
    assert.equal(engine.shouldAdapt('badAdapt'), false);
  });

  it('recordAdaptation delegates to FeedbackScorer', () => {
    let recorded = null;
    const mockScorer = {
      recordAdaptation: (type, hint) => { recorded = { type, hint }; },
    };
    const { AdaptiveResponseEngine } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    const engine = new AdaptiveResponseEngine(null, null, null, mockScorer);

    engine.recordAdaptation('testType', 'test hint');
    assert.deepEqual(recorded, { type: 'testType', hint: 'test hint' });
  });
});
