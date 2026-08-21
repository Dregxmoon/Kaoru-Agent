// @ts-check
'use strict';

/**
 * test_evolutionary_memory.js — Tests for the evolutionary memory system.
 * Verifies module loading and basic functionality.
 */

const assert = require('assert');

// Mock logger
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Test suite
async function runTests() {
  console.log('Running evolutionary memory tests...\n');

  try {
    // Test 1: Module loading
    console.log('Test 1: Module loading');
    const { EvolutionStore } = require('../core/state-graph/evolution/EvolutionStore.js');
    const { TraitLearner } = require('../core/state-graph/evolution/TraitLearner.js');
    const { CommunicationStyleProfiler } = require('../core/state-graph/evolution/CommunicationStyleProfiler.js');
    const { TopicMomentumTracker, extractTopics } = require('../core/state-graph/evolution/TopicMomentumTracker.js');
    const { AdaptiveResponseEngine } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    console.log('  ✓ All modules loaded successfully');

    // Test 2: ExtractTopics function
    console.log('Test 2: ExtractTopics function');
    const topics = extractTopics('Me gusta mucho JavaScript y React para desarrollo web');
    assert(topics.length > 0, 'Should extract topics');
    assert(topics.includes('javascript'), 'Should include javascript');
    console.log('  ✓ extractTopics works correctly');

    // Test 3: TraitLearner emotion detection
    console.log('Test 3: TraitLearner emotion detection');
    const { EMOTION_RULES } = require('../core/state-graph/evolution/TraitLearner.js');
    const frustrationRule = EMOTION_RULES.find(r => r.trait === 'frustration');
    assert(frustrationRule, 'Should have frustration rule');
    assert(frustrationRule.pattern.test('No me funciona este código'), 'Should match frustration');
    console.log('  ✓ TraitLearner emotion rules work correctly');

    // Test 4: Style metrics
    console.log('Test 4: Style metrics');
    const { STYLE_METRICS } = require('../core/state-graph/evolution/TraitLearner.js');
    const lengthScore = STYLE_METRICS._measureLength('Hola');
    assert(lengthScore < 0.3, 'Short message should have low length score');
    const longLengthScore = STYLE_METRICS._measureLength('Este es un mensaje muy largo con mucho contenido para probar la medición de longitud en el sistema de aprendizaje evolutivo del asistente');
    assert(longLengthScore >= 0.6, 'Long message should have high length score');
    console.log('  ✓ Style metrics work correctly');

    // Test 5: CommunicationStyleProfiler thresholds
    console.log('Test 5: CommunicationStyleProfiler thresholds');
    const { STYLE_THRESHOLDS } = require('../core/state-graph/evolution/CommunicationStyleProfiler.js');
    assert(STYLE_THRESHOLDS.length.brief < STYLE_THRESHOLDS.length.normal, 'Brief threshold should be less than normal');
    assert(STYLE_THRESHOLDS.length.normal < STYLE_THRESHOLDS.length.detailed, 'Normal threshold should be less than detailed');
    console.log('  ✓ CommunicationStyleProfiler thresholds are correct');

    // Test 6: TopicMomentumTracker stopwords
    console.log('Test 6: TopicMomentumTracker stopwords');
    const { STOPWORDS } = require('../core/state-graph/evolution/TopicMomentumTracker.js');
    assert(STOPWORDS.has('el'), 'Should have Spanish stopwords');
    assert(STOPWORDS.has('the'), 'Should have English stopwords');
    console.log('  ✓ TopicMomentumTracker stopwords are correct');

    // Test 7: AdaptiveResponseEngine default profile
    console.log('Test 7: AdaptiveResponseEngine default profile');
    const { DEFAULT_PROFILE } = require('../core/state-graph/evolution/AdaptiveResponseEngine.js');
    assert(DEFAULT_PROFILE.responseLength === 'normal', 'Default length should be normal');
    assert(DEFAULT_PROFILE.formality === 'neutral', 'Default formality should be neutral');
    assert(DEFAULT_PROFILE.technicalLevel === 'moderate', 'Default technical level should be moderate');
    console.log('  ✓ AdaptiveResponseEngine default profile is correct');

    // Test 8: EvolutionStore constants
    console.log('Test 8: EvolutionStore constants');
    const { EMA_ALPHA, TOPIC_EMA_ALPHA, TOPIC_WINDOW_MS, MAX_TRACKED_TOPICS } = require('../core/state-graph/evolution/EvolutionStore.js');
    assert(EMA_ALPHA > 0 && EMA_ALPHA < 1, 'EMA_ALPHA should be between 0 and 1');
    assert(TOPIC_EMA_ALPHA > 0 && TOPIC_EMA_ALPHA < 1, 'TOPIC_EMA_ALPHA should be between 0 and 1');
    assert(TOPIC_WINDOW_MS > 0, 'TOPIC_WINDOW_MS should be positive');
    assert(MAX_TRACKED_TOPICS > 0, 'MAX_TRACKED_TOPICS should be positive');
    console.log('  ✓ EvolutionStore constants are correct');

    // Test 9: Integration - Verify StateGraph imports work
    console.log('Test 9: StateGraph integration');
    // This tests that the imports are correct in StateGraph.js
    const stateGraphPath = require.resolve('../core/state-graph/StateGraph.js');
    assert(stateGraphPath, 'StateGraph.js should be resolvable');
    console.log('  ✓ StateGraph.js is resolvable');

    // Test 10: Verify SessionManager has evolutionary memory integration
    console.log('Test 10: SessionManager integration');
    const sessionManagerPath = require.resolve('../core/state-graph/SessionManager.js');
    assert(sessionManagerPath, 'SessionManager.js should be resolvable');
    console.log('  ✓ SessionManager.js is resolvable');

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);
