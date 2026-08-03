'use strict';

const { ipcMain } = require('electron');

function register(ctx) {
  const { Core } = ctx;

  // IPC: memoria
  ipcMain.on('memory-add-turn', (e, { role, content }) => {
    Core.addTurn(role, content);
    if (role === 'user') Core.detectInstant(content);
  });

  ipcMain.handle('memory-stats', () => Core.getStats());

  // IPC: decisión de propuesta proactiva (Fase A)
  ipcMain.on('initiative-decision', (e, decision) => {
    Core.handleProposalDecision(decision);
  });

  // IPC: grounding
  ipcMain.handle('grounding-build-context', async (e, { sessionHistory, activeProvider, mode, plan }) => {
    const ctxRes = await Core.buildContext(sessionHistory, activeProvider, { mode, plan });
    console.log('[grounding-ipc] provider:', activeProvider, '| mode:', mode || 'chat', '| systemPrompt:', ctxRes?.systemPrompt?.length, 'chars');
    return ctxRes;
  });

  ipcMain.handle('generate-plan', async (e, { sessionHistory, userGoal }) => {
    const taskDetector = Core.getTaskDetector?.();
    const taskIntent = taskDetector ? taskDetector.detect(userGoal) : null;
    const result = await Core.generatePlan(userGoal, taskIntent, sessionHistory);
    return result;
  });

  // IPC: OS Sensor
  ipcMain.handle('os-get-context', () => {
    return Core.getOSSensor()?.getCurrentContext() ?? null;
  });

  ipcMain.handle('os-get-today-history', () => {
    return Core.getOSSensor()?.getTodayHistory() ?? [];
  });

  ipcMain.handle('os-get-today-summary', () => {
    return Core.getOSSensor()?.getTodaySummary() ?? null;
  });

  ipcMain.handle('get-stats', () => {
    return Core.getStats();
  });

  ipcMain.handle('memory-forget', (e, { text } = {}) => Core.forgetMemory(text));

  ipcMain.handle('list-skills', () => Core.listSkills());
  ipcMain.handle('store-fact', (e, fact) => Core.storeFact(fact));

  ipcMain.on('set-provider', (e, { primary }) => {
    if (!primary) return;
    const LLMProvider = require('../core/llm/LLMProvider.js');
    LLMProvider.configure({ llm: { primary } });
    console.log('[config] provedor cambiado a:', primary);
  });
}

module.exports = { register };