'use strict';

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

const TONE_RULES = [
  { pattern: /no\s+(me\s+)?funciona|error|fallo|rompi|bug|crash|exploto/i, tone: 'empathic', score: 5 },
  { pattern: /^(qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|qui[eén])\s+/i,        tone: 'direct',   score: 4 },
  { pattern: /\bpor\s+qu[eé]\b|\bc[oó]mo\s+funciona\b|\bexplica\b/i,      tone: 'curious',  score: 4 },
  { pattern: /\b(código|función|clase|método|variable|import|export|async|await|const|let|var)\b/i, tone: 'focused', score: 3 },
  { pattern: /^(hola|buenas|oye|hey|qu[eé]\s+tal|c[oó]mo\s+est[aá]s)/i,  tone: 'playful',  score: 4 },
  { pattern: /triste|cansad[o,a]|estresad[o,a]|frustrad[o,a]/i,           tone: 'empathic', score: 3 },
  { pattern: /gracias|te\s+agradezco|thanks/i,                            tone: 'playful',  score: 2 },
];

const LENGTH_RULES = [
  { pattern: /^(s[ií]|no|ok|vale|bien|listo|claro|entend[ií])\.?\s*$/i, length: 'brief'    },
  { pattern: /explica(me)?\s+|describe\s+|dame\s+(un\s+)?detalle/i,      length: 'detailed' },
  { pattern: /resume(me)?\s+|en\s+resumen|tl;?dr/i,                       length: 'brief'    },
  { pattern: /doc(umentaci[oó]n)?\s+|tutorial|gu[ií]a\s+paso/i,          length: 'detailed' },
];

class BehaviorModel {
  constructor(stateGraph) {
    this._graph = stateGraph;
    this._lastTone = 'dry';
    this._lastToneCount = 0;
  }

  evaluate(userMessage = '', osContext = null, history = []) {
    const text = userMessage.trim();

    const tone          = this._detectTone(text, osContext, history);
    const responseLength = this._detectLength(text);
    const { useTools, toolHint } = this._detectTools(text);
    const urgency       = this._detectUrgency(text, osContext, history);
    const notes         = this._buildNotes(tone, osContext, history, useTools);
    const proactiveScore = this._computeProactiveScore(osContext, history, urgency);

    this._lastTone = tone;
    this._lastToneCount++;

    const ctx = { tone, responseLength, useTools, toolHint, urgency, notes, proactiveScore };

    console.log(
      `[behavior] tone=${tone} length=${responseLength} tools=${useTools}` +
      (toolHint ? `(${toolHint})` : '') +
      ` urgency=${urgency} proactive=${proactiveScore.toFixed(2)}`
    );

    return ctx;
  }

  _detectTone(text, osContext, history) {
    const scores = {};

    for (const { pattern, tone, score } of TONE_RULES) {
      if (pattern.test(text)) {
        scores[tone] = (scores[tone] || 0) + score;
      }
    }

    // Contexto de código largo → focused
    if (osContext?.category === 'code' && osContext?.elapsed > 600) {
      scores['focused'] = (scores['focused'] || 0) + 2;
    }

    // Conversación larga → empathic
    if (history.length > 12) {
      scores['empathic'] = (scores['empathic'] || 0) + 2;
    }

    if (Object.keys(scores).length === 0) return 'dry';

    const topTone = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

    // Transición suave: si el tono anterior tiene al menos 1 punto, no cambiar
    // abruptamente a menos que el nuevo tono tenga clara ventaja
    if (this._lastTone !== topTone) {
      const currentScore = scores[topTone] || 0;
      const lastScore = scores[this._lastTone] || 0;
      if (currentScore <= lastScore + 1 && this._lastToneCount > 2) {
        return this._lastTone;
      }
    }

    return topTone;
  }

  _detectLength(text) {
    for (const { pattern, length } of LENGTH_RULES) {
      if (pattern.test(text)) return length;
    }
    if (text.length < 20) return 'brief';
    if (text.length > 200) return 'detailed';
    return 'normal';
  }

  _detectTools(text) {
    for (const { pattern, hint } of TOOL_TRIGGERS) {
      if (pattern.test(text)) return { useTools: true, toolHint: hint };
    }
    return { useTools: false, toolHint: null };
  }

  _detectUrgency(text, osContext, history) {
    const urgentWords = /urgente|r[aá]pido|ahora mismo|inmediatamente|ya\s+mismo|ASAP|se\s+rompi[oó]|se\s+cay[oó]/i;
    if (urgentWords.test(text)) return 'high';

    if (osContext?.category === 'terminal') return 'medium';

    // Mensajes muy rápidos (menos de 10s entre el último y este, si hay historial)
    if (history.length >= 2) {
      const gap = Date.now() - (history[history.length - 1]?.timestamp || Date.now());
      if (gap < 10_000) return 'medium';
    }

    // Hora tardía + este es el primer mensaje tras silencio largo → puede ser urgente
    const hour = new Date().getHours();
    if (hour >= 23 || hour < 6) {
      if (history.length <= 1) return 'medium';
    }

    // Mensaje corto después de larga inactividad — el usuario está apurado
    if (history.length >= 1) {
      const lastTs = history[history.length - 1]?.timestamp;
      if (lastTs && (Date.now() - lastTs) > 60 * 60 * 1000 && text.length < 30) {
        return 'medium';
      }
    }

    return 'low';
  }

  _computeProactiveScore(osContext, history, urgency) {
    let score = 0.3; // base

    // Usuario activo en una categoría reconocida → más receptivo
    if (osContext?.category) {
      if (osContext.category === 'code') score += 0.2;
      else if (osContext.category === 'terminal') score += 0.15;
      else if (osContext.category === 'docs') score += 0.1;
      else if (osContext.category === 'browser') score -= 0.1;
      else if (osContext.category === 'game') score -= 0.2;
    }

    // Lleva tiempo en la misma app → buen momento
    if ((osContext?.elapsed || 0) > 300) score += 0.15;
    if ((osContext?.elapsed || 0) > 1800) score += 0.1;

    // Conversación activa → probabilidad media
    if (history.length > 3 && history.length < 15) score += 0.1;

    // Inactividad reciente → muy probable
    if ((osContext?.idleSecs || 0) < 60) score += 0.05;

    // Urgencia alta → no interrumpir
    if (urgency === 'high') score -= 0.4;
    else if (urgency === 'medium') score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  getLastTone() {
    return this._lastTone;
  }

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