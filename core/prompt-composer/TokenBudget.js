/**
 * TokenBudget.js 
 *
 * El Composer NUNCA concatena texto a ciegas. Antes de serializar el
 * prompt final, TokenBudget mira cuánto pesa cada bloque habilitado y,
 * si la suma no entra en el presupuesto, decide en qué orden recortar:
 *
 *   1. Sacar bloques enteros de menor prioridad (nunca los `critical`).
 *   2. Si eso no alcanza, comprimir en nivel 1 (leve) los bloques no
 *      críticos, empezando por los de menor prioridad.
 *   3. Si TODAVÍA no alcanza, comprimir en nivel 2 (agresiva).
 *   4. Si ni así entra, los bloques críticos se quedan tal cual (nunca se
 *      tocan) y se deja constancia en el resultado de que el presupuesto
 *      se excedió igual — el Composer lo loguea, no lo esconde.
 *
 * Esto reemplaza el truncado ciego que tenía GroqSerializer.js
 * (`systemPrompt.slice(0, MAX_SYSTEM_CHARS)`), que además tenía un bug:
 * se aplicaba ANTES de que MarchCore.js pegara las secciones de
 * BehaviorModel/OpenClaw/MCP encima — o sea que el límite real nunca se
 * respetaba salvo por casualidad. Acá el presupuesto se aplica UNA vez,
 * sobre el conjunto completo de bloques.
 */

'use strict';

class TokenBudget {
  constructor(maxTokens) {
    if (!maxTokens || maxTokens <= 0) throw new Error('TokenBudget necesita maxTokens > 0');
    this.maxTokens = maxTokens;
  }


  plan(blocks, context) {
    // Paso 0: medir todo en su forma completa
    let entries = blocks.map(block => {
      const text   = block.serialize(context) || '';
      const tokens = text ? block.estimateTokens(context) : 0;
      return { block, mode: 'full', text, tokens };
    }).filter(e => e.text); 

    const totalOf = (list) => list.reduce((sum, e) => sum + e.tokens, 0);

    // Paso 1: si ya entra, no hay nada más que hacer
    if (totalOf(entries) <= this.maxTokens) {
      return this._result(entries);
    }

    const droppable = () => entries
      .filter(e => !e.block.critical && e.mode !== 'dropped')
      .sort((a, b) => a.block.priority - b.block.priority);

    for (const candidate of droppable()) {
      if (totalOf(entries.filter(e => e.mode !== 'dropped')) <= this.maxTokens) break;
      candidate.mode  = 'dropped';
      candidate.text  = '';
      candidate.tokens = 0;
    }

    if (totalOf(entries.filter(e => e.mode !== 'dropped')) <= this.maxTokens) {
      return this._result(entries);
    }

    // Paso 3: comprimir nivel 1 los no-críticos que sobrevivieron, de menor
    // a mayor prioridad
    this._compressPass(entries, context, 1);
    if (totalOf(entries.filter(e => e.mode !== 'dropped')) <= this.maxTokens) {
      return this._result(entries);
    }

    // Paso 4: comprimir nivel 2 
    this._compressPass(entries, context, 2);

    // Paso 5: si algún bloque quedó null tras comprimir (compress() dijo
    // "no puedo más") y no es crítico, se saca del todo recién ahora
    for (const e of entries) {
      if (e.mode.startsWith('compressed') && !e.text && !e.block.critical) {
        e.mode = 'dropped';
      }
    }

    return this._result(entries);
  }

  _compressPass(entries, context, level) {
    const targets = entries
      .filter(e => !e.block.critical && e.mode !== 'dropped')
      .sort((a, b) => a.block.priority - b.block.priority);

    for (const e of targets) {
      const currentTotal = entries.filter(x => x.mode !== 'dropped').reduce((s, x) => s + x.tokens, 0);
      if (currentTotal <= this.maxTokens) break;

      const compressed = e.block.compress(context, level);
      e.text   = compressed || '';
      e.tokens = compressed ? Math.ceil(compressed.length / 4) : 0;
      e.mode   = `compressed-${level}`;
    }
  }

  _result(entries) {
    const active       = entries.filter(e => e.mode !== 'dropped');
    const totalTokens  = active.reduce((s, e) => s + e.tokens, 0);
    return {
      plan:              entries,
      totalTokens,
      overBudget:        totalTokens > this.maxTokens,
      droppedBlocks:     entries.filter(e => e.mode === 'dropped').map(e => e.block.name),
      compressedBlocks:  entries.filter(e => e.mode.startsWith('compressed')).map(e => e.block.name),
    };
  }
}

module.exports = { TokenBudget };
