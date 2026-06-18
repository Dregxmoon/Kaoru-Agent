/**
 * BehaviorModel.js — Fase 3
 *
 * Decide CÓMO se comporta March en cada turno:
 *   - Tono (curioso, empático, seco, directo...)
 *   - Si debe usar herramientas o solo responder
 *   - Nivel de detalle / extensión esperada
 *   - Cuándo intervenir proactivamente (score U = Relevance - InterruptionCost)
 *
 * No genera lenguaje. No llama al LLM. Solo produce un BehaviorContext
 * que el Planner y el GroundingEngine consumen para ajustar el prompt.
 *
 * Separación de responsabilidades:
 *   InitiativeEngine  → decide cuándo interrumpir basado en OS/app
 *   ProactiveEngine   → decide qué decir en silencio largo / madrugada
 *   BehaviorModel     → decide cómo responder dado el turno actual
 *
 * El BehaviorContext que produce tiene esta forma:
 * {
 *   tone:         'curious' | 'empathic' | 'dry' | 'direct' | 'playful' | 'focused'
 *   responseLength: 'brief' | 'normal' | 'detailed'
 *   useTools:     boolean
 *   toolHint:     string | null   — tipo de herramienta sugerida si useTools=true
 *   urgency:      'low' | 'medium' | 'high'
 *   notes:        string[]        — instrucciones extra para el serializer
 * }
 */

'use strict';

// ── Patrones que sugieren uso de herramientas ─────────────────────────────────
const TOOL_TRIGGERS = [
  { pattern: /busca(r|me)?\s+en\s+(la\s+)?web/i,       hint: 'web_search'    },
  { pattern: /abre?\s+(el\s+)?(navegador|chrome|edge)/i, hint: 'browser'      },
  { pattern: /ejecuta?\s+|corre?\s+|lanza?\s+/i,         hint: 'exec'         },
  { pattern: /crea?\s+(un\s+)?(archivo|carpeta|fichero)/i, hint: 'write'       },
  { pattern: /lee?\s+(el\s+)?(archivo|fichero|documento)/i, hint: 'read'       },
  { pattern: /instala?\s+|npm\s+install|pip\s+install/i,  hint: 'exec'         },
  { pattern: /escribe?\s+(en|al?)\s+(archivo|fichero)/i,  hint: 'write'        },
  { pattern: /busca?\s+(en\s+)?(google|bing|internet)/i, hint: 'web_search'    },
  { pattern: /abre?\s+(la\s+)?terminal|consola/i,         hint: 'exec'         },
  { pattern: /git\s+(add|commit|push|pull|status|log)/i,  hint: 'exec'         },
  { pattern: /toma?\s+una\s+(captura|screenshot)/i,       hint: 'browser'      },
  { pattern: /descarga?\s+|download\s+/i,                 hint: 'browser'      },
];

// ── Patrones de tono ──────────────────────────────────────────────────────────
const TONE_RULES = [
  // Errores / frustración → empático primero
  { pattern: /no\s+(me\s+)?funciona|error|fallo|rompi|bug|crash|exploto/i, tone: 'empathic' },
  // Preguntas rápidas → directo
  { pattern: /^(qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eé]n)\s+/i,        tone: 'direct'   },
  // Contexto de código → enfocado
  { pattern: /\b(código|función|clase|método|variable|import|export|async|await|const|let|var)\b/i, tone: 'focused' },
  // Charla casual → seco/playful aleatorio
  { pattern: /^(hola|buenas|oye|hey|qu[eé]\s+tal|c[oó]mo\s+est[aá]s)/i,  tone: 'playful'  },
  // Curiosidad / explicaciones → curioso
  { pattern: /\bpor\s+qu[eé]\b|\bc[oó]mo\s+funciona\b|\bexplica\b/i,      tone: 'curious'  },
];

// ── Patrones de longitud ──────────────────────────────────────────────────────
const LENGTH_RULES = [
  { pattern: /^(s[ií]|no|ok|vale|bien|listo|claro|entend[ií])\.?\s*$/i, length: 'brief'    },
  { pattern: /explica(me)?\s+|describe\s+|dame\s+(un\s+)?detalle/i,      length: 'detailed' },
  { pattern: /resume(me)?\s+|en\s+resumen|tl;?dr/i,                       length: 'brief'    },
  { pattern: /doc(umentaci[oó]n)?\s+|tutorial|gu[ií]a\s+paso/i,          length: 'detailed' },
];

class BehaviorModel {
  constructor(stateGraph) {
    this._graph = stateGraph;
  }

  /**
   * Evalúa el mensaje actual y produce un BehaviorContext.
   *
   * @param {string} userMessage   — mensaje del usuario este turno
   * @param {object} osContext     — contexto OS actual (app, category, elapsed...)
   * @param {Array}  history       — historial de sesión actual
   * @returns {object}             — BehaviorContext
   */
  evaluate(userMessage = '', osContext = null, history = []) {
    const text = userMessage.trim();

    const tone          = this._detectTone(text, osContext, history);
    const responseLength = this._detectLength(text);
    const { useTools, toolHint } = this._detectTools(text);
    const urgency       = this._detectUrgency(text, osContext);
    const notes         = this._buildNotes(tone, osContext, history, useTools);

    const ctx = { tone, responseLength, useTools, toolHint, urgency, notes };

    console.log(
      `[behavior] tone=${tone} length=${responseLength} tools=${useTools}` +
      (toolHint ? `(${toolHint})` : '') +
      ` urgency=${urgency}`
    );

    return ctx;
  }

  // ── Detección de tono ───────────────────────────────────────────────────────

  _detectTone(text, osContext, history) {
    // Reglas explícitas del mensaje
    for (const { pattern, tone } of TONE_RULES) {
      if (pattern.test(text)) return tone;
    }

    // Si está en código y lleva tiempo — focused
    if (osContext?.category === 'code' && osContext?.elapsed > 600) return 'focused';

    // Conversación larga → más empático
    if (history.length > 12) return 'empathic';

    // Default: seco (la voz natural de March)
    return 'dry';
  }

  // ── Detección de longitud ───────────────────────────────────────────────────

  _detectLength(text) {
    for (const { pattern, length } of LENGTH_RULES) {
      if (pattern.test(text)) return length;
    }

    // Mensaje muy corto → respuesta breve
    if (text.length < 20) return 'brief';
    // Mensaje muy largo (pregunta compleja) → detallado
    if (text.length > 200) return 'detailed';

    return 'normal';
  }

  // ── Detección de herramientas ───────────────────────────────────────────────

  _detectTools(text) {
    for (const { pattern, hint } of TOOL_TRIGGERS) {
      if (pattern.test(text)) return { useTools: true, toolHint: hint };
    }
    return { useTools: false, toolHint: null };
  }

  // ── Urgencia ────────────────────────────────────────────────────────────────

  _detectUrgency(text, osContext) {
    const urgentWords = /urgente|r[aá]pido|ahora mismo|inmediatamente|ya\s+mismo|ASAP/i;
    if (urgentWords.test(text)) return 'high';

    // Terminal activa → puede ser urgente
    if (osContext?.category === 'terminal') return 'medium';

    return 'low';
  }

  // ── Notas extra para el serializer ─────────────────────────────────────────

  _buildNotes(tone, osContext, history, useTools) {
    const notes = [];

    if (tone === 'focused') {
      notes.push('Responde con precisión técnica. Menos relleno emocional.');
    }
    if (tone === 'empathic') {
      notes.push('Reconoce primero cómo se siente el usuario antes de resolver.');
    }
    if (tone === 'playful') {
      notes.push('Puedes ser más desenfadada. El humor seco de March está bien aquí.');
    }
    if (useTools) {
      notes.push('El usuario pide una acción. Responde que la vas a ejecutar antes de hacerlo.');
    }
    if (history.length === 0) {
      notes.push('Primer mensaje de la sesión. No te presentes; simplemente responde.');
    }
    if (osContext?.idleSecs > 600) {
      notes.push('El usuario lleva un rato inactivo. Puede estar en modo pensativo.');
    }

    return notes;
  }

  /**
   * Serializa el BehaviorContext como texto para incluir en el system prompt.
   * Llamado por GroqSerializer / GeminiSerializer.
   *
   * @param {object} behaviorCtx
   * @returns {string}
   */
  static serialize(behaviorCtx) {
    if (!behaviorCtx) return '';

    const lines = ['# COMPORTAMIENTO ESTE TURNO'];

    const toneDesc = {
      curious:  'Muestra curiosidad genuina. Haz preguntas si algo no está claro.',
      empathic: 'Empieza reconociendo la situación antes de dar soluciones.',
      dry:      'Sé concisa y directa. El humor seco está bien si el momento lo permite.',
      direct:   'Ve al grano. Sin preámbulos ni relleno.',
      playful:  'Tono relajado. Puedes bromear con mesura.',
      focused:  'Modo técnico. Precisión sobre calidez.',
    };

    lines.push(`Tono: ${toneDesc[behaviorCtx.tone] || 'Natural.'}`);

    const lenDesc = {
      brief:    'Respuesta corta — máximo 2-3 oraciones.',
      normal:   'Longitud normal — lo que el tema necesite.',
      detailed: 'Respuesta extensa — el usuario quiere detalle.',
    };
    lines.push(`Extensión: ${lenDesc[behaviorCtx.responseLength] || 'Normal.'}`);

    if (behaviorCtx.useTools) {
      lines.push(`Herramienta sugerida: ${behaviorCtx.toolHint || 'general'}. Anuncia la acción antes de ejecutarla.`);
    }

    if (behaviorCtx.notes?.length) {
      behaviorCtx.notes.forEach(n => lines.push(`- ${n}`));
    }

    return lines.join('\n');
  }
}

module.exports = { BehaviorModel };
