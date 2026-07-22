/**
 * Cada sección del prompt (identidad, reglas, entorno, conversación,
 * memoria, conocimiento, herramientas, mensaje del usuario, instrucciones
 * de salida) es una instancia de esta clase (o de una subclase). Un bloque
 * no sabe nada de LLMs, providers ni formato final — solo sabe producir su
 * propio contenido a partir del Context Package.
 *
 * Contrato (coincide con el pedido en el ticket EPIC-005):
 *   - name            string único, estable — se usa en logs/debug/orden.
 *   - priority        number — más alto = más importante = se recorta último
 *                      cuando el TokenBudget tiene que liberar espacio.
 *   - critical        boolean — si es true, el TokenBudget NUNCA lo saca ni
 *                      lo comprime, pase lo que pase con el presupuesto
 *                      (ej: Identity, Rules, UserBlock, OutputInstructions).
 *   - enabled         boolean — si es false, el Composer lo salta por
 *                      completo (no cuenta tokens, no serializa).
 *   - estimateTokens(context)   → number  (aproximado, barato de calcular)
 *   - serialize(context)        → string  (el contenido real del bloque)
 *   - compress(context, level)  → string | null  (versión reducida; level
 *                      1 = leve, 2 = agresiva. null = "no puedo comprimir
 *                      más, sacame del prompt si hace falta".)
 *
 * compress() es opcional — la implementación default de compress() en esta
 * clase base simplemente trunca el resultado de serialize() a un porcentaje
 * del tamaño original según el nivel. Los bloques que puedan comprimir de
 * forma más inteligente (Conversation, Memory, Knowledge) sobreescriben
 * compress() con su propia lógica — ver esos archivos.
 */

'use strict';

// Heurística de estimación: ~4 caracteres por token para español/inglés
// mixto. Es la MISMA heurística que ya usaba ContextAssembler.js
// (`Math.round(result.systemPrompt.length / 4)`) — se centraliza acá para
// que todo el subsistema use un solo criterio consistente.
const CHARS_PER_TOKEN = 4;

function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

class PromptBlock {
  constructor({ name, priority = 50, critical = false, enabled = true }) {
    if (!name) throw new Error('PromptBlock requiere un name');
    this.name     = name;
    this.priority = priority;
    this.critical = critical;
    this.enabled  = enabled;
  }

  /**
   * Debe devolver el texto de este bloque para el Context Package dado.
   * Devolver '' o null significa "este bloque no tiene nada que aportar
   * en este contexto" (ej: EnvironmentBlock sin osContext) — el Composer
   * lo omite del prompt final sin tratarlo como error.
   * Las subclases DEBEN implementar esto.
   */
  // eslint-disable-next-line no-unused-vars
  serialize(context) {
    throw new Error(`PromptBlock "${this.name}" no implementó serialize()`);
  }

  /**
   * Estimación barata de tokens — por default, serializa y mide caracteres.
   * Los bloques caros de serializar (que hacen trabajo pesado en
   * serialize()) pueden sobreescribir esto con una estimación más barata
   * que no dependa de generar el texto completo.
   */
  estimateTokens(context) {
    return estimateTokensFromText(this.serialize(context));
  }

  compress(context, level = 1) {
    const full = this.serialize(context);
    if (!full) return null;
    const ratio = level >= 2 ? 0.35 : 0.7;
    const targetLen = Math.floor(full.length * ratio);
    if (targetLen < 40) return null; // ya no vale la pena, es ruido
    return full.slice(0, targetLen).trim() + '\n[…recortado por presupuesto de tokens…]';
  }
}

module.exports = { PromptBlock, estimateTokensFromText, CHARS_PER_TOKEN };
