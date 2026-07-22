/**
 * PromptComposer.js 
 *
 * El pipeline completo:
 *
 *   Context Package
 *        ↓
 *   [Identity → Rules → Environment → Conversation → Memory → Knowledge
 *    → Tools → User → Output Instructions]     (blocks habilitados)
 *        ↓
 *   TokenBudget.plan()                          (recorta/comprime si no entra)
 *        ↓
 *   ProviderAdapter.reorderSections()           (el adapter puede reordenar)
 *        ↓
 *   Serializer.serialize()                      (markdown / xml / json-sections / provider-native)
 *        ↓
 *   ProviderAdapter.buildRequest()               (forma final: system separado, roles remapeados, etc)
 *        ↓
 *   { ...request, meta, debug? }
 *
 * El Composer NO retiene estado entre llamadas (aparte de la lista de
 * bloques configurada) — cada compose() es independiente, así que es
 * seguro reusar la misma instancia para llamadas concurrentes.
 *
 * Cumple explícitamente lo que pide el ticket: el Composer nunca toca
 * memoria, embeddings, bases de datos, ni decide relevancia — todo eso ya
 * viene resuelto en el Context Package que recibe compose().
 */

'use strict';

const { TokenBudget }        = require('./TokenBudget.js');
const { createDefaultBlocks } = require('./blocks/index.js');
const { getAdapter }          = require('./adapters/index.js');
const { getSerializer }       = require('./serializers/index.js');
const { exportDebug }         = require('./DebugExporter.js');

const DEFAULT_MAX_TOKENS = 6000; // ~24k chars — conservador para dejar espacio a historial+respuesta

class PromptComposer {
  /**
   * @param {object} [opts]
   * @param {import('./PromptBlock').PromptBlock[]} [opts.blocks]  default: createDefaultBlocks()
   * @param {number} [opts.maxTokens]
   * @param {string} [opts.defaultSerializer]  'markdown'|'xml'|'json-sections'|'provider-native'
   */
  constructor({ blocks, maxTokens = DEFAULT_MAX_TOKENS, defaultSerializer = 'provider-native' } = {}) {
    this.blocks              = blocks || createDefaultBlocks();
    this.maxTokens            = maxTokens;
    this.defaultSerializer    = defaultSerializer;
  }

  /** Extensibilidad: un módulo futuro puede sumar un bloque propio sin tocar este archivo. */
  registerBlock(block) {
    this.blocks.push(block);
    return this;
  }

  getBlock(name) {
    return this.blocks.find(b => b.name === name) || null;
  }

  /**
   * @param {object} contextPackage  ver docs/ARCHITECTURE.md para la forma completa
   * @param {object} [opts]
   * @param {string} [opts.provider='groq']    'groq'|'openai'|'gemini'|'claude'
   * @param {string} [opts.serializerName]      si se omite, usa this.defaultSerializer
   * @param {boolean} [opts.debug=false]         adjunta un export completo para depuración
   * @returns {object}  forma final según el adapter del provider, + `meta` (y `debug` si se pidió)
   */
  compose(contextPackage, { provider = 'groq', serializerName, debug = false } = {}) {
    const context = { ...contextPackage, provider };

    const activeBlocks = this.blocks.filter(b => b.enabled);
    const maxTokens     = contextPackage.tokenBudget || this.maxTokens;
    const budget        = new TokenBudget(maxTokens);
    const planResult     = budget.plan(activeBlocks, context);

    // Secciones de TEXTO (todo menos conversation/user, que van a `messages`
    // aparte — ver más abajo). Se arman en el orden del pipeline, no en el
    // orden en que TokenBudget las procesó internamente (que es por prioridad).
    const textBlockNames = new Set(
      activeBlocks.filter(b => b.name !== 'conversation' && b.name !== 'user').map(b => b.name)
    );
    const sections = planResult.plan
      .filter(e => textBlockNames.has(e.block.name) && e.text)
      .map(e => ({ name: e.block.name, text: e.text }));

    const adapter   = getAdapter(provider);
    const reordered = adapter.reorderSections(sections);

    const extra = adapter.extraInstructions(context);
    if (extra) reordered.push({ name: `${provider}-extra`, text: extra });

    const serializer  = getSerializer(serializerName || this.defaultSerializer, provider);
    const systemPrompt = serializer.serialize(reordered);

    // Mensajes: el nivel de compresión que decidió TokenBudget para el
    // bloque 'conversation' determina cuántos turnos entran.
    const conversationBlock = this.getBlock('conversation');
    const userBlock          = this.getBlock('user');
    const convPlanEntry      = planResult.plan.find(e => e.block === conversationBlock);

    let maxTurns; // undefined = todos los turnos
    if (convPlanEntry) {
      if      (convPlanEntry.mode === 'dropped')       maxTurns = 0;
      else if (convPlanEntry.mode === 'compressed-2')  maxTurns = 4;
      else if (convPlanEntry.mode === 'compressed-1')  maxTurns = 10;
    }

    const historyMessages = conversationBlock
      ? conversationBlock.toMessages(context, maxTurns != null ? { maxTurns } : {})
      : [];
    const userMessages = userBlock ? userBlock.toMessages(context) : [];
    let messages = [...historyMessages, ...userMessages];

    // Mismo resguardo que tenía GroqSerializer.js original: algunos
    // providers rechazan un array de mensajes vacío.
    if (messages.length === 0) {
      messages = [{ role: 'user', content: '...' }];
    }

    const request = adapter.buildRequest({ systemPrompt, messages });

    const result = {
      ...request,
      meta: {
        provider,
        serializer:        serializer.name,
        totalTokens:        planResult.totalTokens,
        maxTokens,
        overBudget:         planResult.overBudget,
        droppedBlocks:      planResult.droppedBlocks,
        compressedBlocks:   planResult.compressedBlocks,
        promptChars:        systemPrompt.length,
        generatedAt:        new Date().toISOString(),
      },
    };

    if (debug) {
      result.debug = exportDebug({ sections: reordered, planResult, provider, serializerName: serializer.name, systemPrompt });
    }

    return result;
  }
}

module.exports = { PromptComposer, DEFAULT_MAX_TOKENS };
