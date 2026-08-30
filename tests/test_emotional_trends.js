// @ts-check
'use strict';

/**
 * test_emotional_trends.js — Tests para EmotionalTrendTracker
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { EmotionalTrendTracker } = require('../core/state-graph/evolution/EmotionalTrendTracker.js');

// ── EmotionalTrendTracker Tests (sin DB) ────────────────────────────────────

describe('EmotionalTrendTracker', () => {
  // Mock store con DB en memoria
  const mockStore = {
    _db: {
      exec: () => {},
      prepare: () => ({ run: () => {} }),
    },
  };

  it('should create tracker', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    assert.ok(tracker, 'tracker created');
  });

  it('should start session', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');
    assert.equal(tracker._currentSessionId, 'test-session');
  });

  it('should record turns', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.7,
        enthusiasm: 0.1,
        confusion: 0.2,
        calm: 0.3,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'esto no funciona'
    );

    const history = tracker._sessionHistory.get('test-session');
    assert.equal(history.length, 1);
    assert.equal(history[0].emotions.frustration, 0.7);
  });

  it('should detect rising trend', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(
        'test-session',
        {
          frustration: 0.2 + i * 0.15,
          enthusiasm: 0.1,
          confusion: 0.1,
          calm: 0.5 - i * 0.1,
          urgency: 0.1,
          playfulness: 0.0,
        },
        'turno ' + i
      );
    }

    const trend = tracker.getEmotionTrend('test-session', 'frustration');
    assert.equal(trend.trend, 'rising', 'frustration is rising');
    assert.ok(trend.velocity > 0, 'positive velocity');
  });

  it('should detect falling trend', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(
        'test-session',
        {
          frustration: 0.8 - i * 0.15,
          enthusiasm: 0.1,
          confusion: 0.1,
          calm: 0.3 + i * 0.1,
          urgency: 0.1,
          playfulness: 0.0,
        },
        'turno ' + i
      );
    }

    const trend = tracker.getEmotionTrend('test-session', 'frustration');
    assert.equal(trend.trend, 'falling', 'frustration is falling');
    assert.ok(trend.velocity < 0, 'negative velocity');
  });

  it('should detect stable trend', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(
        'test-session',
        {
          frustration: 0.5,
          enthusiasm: 0.1,
          confusion: 0.1,
          calm: 0.5,
          urgency: 0.1,
          playfulness: 0.0,
        },
        'turno ' + i
      );
    }

    const trend = tracker.getEmotionTrend('test-session', 'frustration');
    assert.equal(trend.trend, 'stable', 'frustration is stable');
  });

  it('should detect recovery', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.8,
        enthusiasm: 0.1,
        confusion: 0.1,
        calm: 0.2,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'turno 0'
    );
    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.7,
        enthusiasm: 0.1,
        confusion: 0.1,
        calm: 0.3,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'turno 1'
    );
    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.3,
        enthusiasm: 0.1,
        confusion: 0.1,
        calm: 0.7,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'turno 2'
    );

    const recovery = tracker.detectRecovery('test-session');
    assert.equal(recovery.recovered, true, 'recovery detected');
    assert.equal(recovery.from, 'frustrated');
  });

  it('should detect escalation', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(
        'test-session',
        {
          frustration: 0.1 + i * 0.25,
          enthusiasm: 0.1,
          confusion: 0.1,
          calm: 0.5 - i * 0.1,
          urgency: 0.1,
          playfulness: 0.0,
        },
        'turno ' + i
      );
    }

    const escalation = tracker.detectEscalation('test-session');
    assert.equal(escalation.escalated, true, 'escalation detected');
    assert.equal(escalation.emotion, 'frustration');
  });

  it('should build trend hint', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    for (let i = 0; i < 5; i++) {
      tracker.recordTurn(
        'test-session',
        {
          frustration: 0.2 + i * 0.15,
          enthusiasm: 0.1,
          confusion: 0.1,
          calm: 0.5 - i * 0.1,
          urgency: 0.1,
          playfulness: 0.0,
        },
        'turno ' + i
      );
    }

    const hint = tracker.buildTrendHint('test-session');
    assert.ok(hint.includes('TENDENCIA EMOCIONAL'), 'has header');
    assert.ok(hint.includes('frustración'), 'mentions frustration');
  });

  it('should get session stats', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    tracker.startSession('test-session');

    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.7,
        enthusiasm: 0.1,
        confusion: 0.1,
        calm: 0.3,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'turno 0'
    );
    tracker.recordTurn(
      'test-session',
      {
        frustration: 0.3,
        enthusiasm: 0.5,
        confusion: 0.1,
        calm: 0.7,
        urgency: 0.1,
        playfulness: 0.0,
      },
      'turno 1'
    );

    const stats = tracker.getSessionStats('test-session');
    assert.equal(stats.turns, 2);
    assert.ok(stats.avgFrustration > 0, 'has avgFrustration');
    assert.ok(stats.avgEnthusiasm > 0, 'has avgEnthusiasm');
  });

  it('should handle empty session', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    const trend = tracker.getEmotionTrend('empty-session', 'frustration');
    assert.equal(trend.trend, 'stable');
    assert.equal(trend.samples, 0);
  });

  it('should return empty hint for empty session', () => {
    const tracker = new EmotionalTrendTracker(mockStore);
    const hint = tracker.buildTrendHint('empty-session');
    assert.equal(hint, '');
  });
});
