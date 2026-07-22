'use strict';

function contextPackageFromLegacy(legacy) {
  const {
    identity          = null,
    osContext         = null,
    persistentMemory  = null,
    sessionHistory    = [],
    currentMessage    = null,
    toolIntent        = null,
    openclawAvailable = false,
    mcpTools          = [],
    behaviorInstructions = null,
  } = legacy;

  return {
    identity,
    environment: osContext,
    conversation: {
      history:     sessionHistory,
      userMessage: currentMessage,
    },
    memories: persistentMemory || { nodes: [], episodes: [] },
    projects: [],           
    goals: [],               
    retrievedKnowledge: [],  
    availableTools: {
      openclaw: { available: !!openclawAvailable },
      mcp:      mcpTools || [],
    },
    currentIntent:  toolIntent,
    userMessage:    currentMessage,
    behaviorInstructions,
  };
}

module.exports = { contextPackageFromLegacy };
