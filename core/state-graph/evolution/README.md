# Evolutionary Memory System

## Overview

The Evolutionary Memory System adds a hidden behavioral/emotional inference layer to the existing StateGraph + SQLite architecture. It tracks user communication patterns, emotional states, and topic momentum to adapt responses dynamically.

## Architecture

### New Components (core/state-graph/evolution/)

1. **EvolutionStore.js** - Persistent storage for communication profiles and topic momentum
   - `communication_profiles` table: EMA-based style metrics
   - `topic_momentum` table: Topic frequency tracking with momentum scoring

2. **TraitLearner.js** - Deterministic behavioral inference (per-turn)
   - Emotional pattern detection (frustration, enthusiasm, confusion, etc.)
   - Communication style measurement (length, formality, technical density)
   - No LLM calls - pure regex/stats

3. **CommunicationStyleProfiler.js** - EMA-based style adaptation
   - Tracks user preferences over time
   - Generates system prompt hints for response adaptation

4. **TopicMomentumTracker.js** - Hot/cold topic detection
   - Sliding window (7 days) momentum scoring
   - Extracts topics from user messages
   - Provides context for proactive triggers

5. **AdaptiveResponseEngine.js** - Combines all insights
   - Builds complete adaptation profile
   - Applies emotional adjustments
   - Serializes for system prompt injection

## Integration Points

### Modified Files

1. **StateGraph.js**
   - Added imports for evolution components
   - Added `_initStores()` initialization
   - Added schema creation for evolution tables
   - Added public accessors for evolution components

2. **SessionManager.js**
   - Modified `addTurn()` to call TraitLearner and TopicMomentumTracker per user message

3. **BehaviorModel.js**
   - Modified `evaluate()` to accept adaptation profile
   - Applies style adaptations when confidence > 0.2

4. **ContextAssembler.js**
   - Added communication style hint to context package

5. **GroqSerializer.js**
   - Added `_buildCommStyleSection()` for system prompt injection
   - Modified `serialize()` to include commStyleHint

6. **curiosity.js mixin**
   - Added topic_cold candidates for proactive triggers
   - Registered signal profile for topic_cold

7. **config.js**
   - Added topic_cold to CURIOSITY_TYPES
   - Added topic_cold cooldown (4 hours)
   - Added topic_cold proposal hint

8. **context.js**
   - Added Adaptation section to truncation priority

## Data Flow

```
User Message
    ↓
SessionManager.addTurn()
    ↓
┌─────────────────────────────────────────┐
│ TraitLearner.analyzeTurn()              │
│   - Detect emotions                     │
│   - Measure style metrics               │
│   - Update EvolutionStore profiles      │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ TopicMomentumTracker.analyzeTurn()      │
│   - Extract topics                      │
│   - Record in EvolutionStore            │
│   - Update momentum scores              │
└─────────────────────────────────────────┘
    ↓
Context Assembly (per-turn)
    ↓
┌─────────────────────────────────────────┐
│ AdaptiveResponseEngine                  │
│   .buildAdaptationProfile()             │
│   - Get emotional state                 │
│   - Get style preferences               │
│   - Get topic momentum                  │
│   - Apply emotional adjustments         │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ BehaviorModel.evaluate()                │
│   - Apply adaptation profile            │
│   - Adjust response length              │
│   - Add style hints to notes            │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ GroqSerializer.serialize()              │
│   - Build commStyleHint section         │
│   - Inject into system prompt           │
└─────────────────────────────────────────┘
    ↓
LLM Response (adapted to user style)
```

## Graceful Degradation

- All components work without LLM (deterministic)
- EvolutionStore gracefully handles database errors
- TraitLearner and TopicMomentumTracker never block main flow
- Adaptation hints only injected when confidence > 0.2
- System degrades to default behavior if evolution components unavailable

## Performance

- EMA updates: O(1) per metric
- Topic tracking: O(1) per mention, bounded to 50 topics
- Emotional analysis: O(1) per turn (regex matching)
- No impact on main thread (all operations are fast)

## Testing

Run tests with:
```bash
node tests/test_evolutionary_memory.js
```

Tests verify:
- Module loading
- Topic extraction
- Emotion detection
- Style metrics
- Thresholds and constants
- Integration with StateGraph and SessionManager
