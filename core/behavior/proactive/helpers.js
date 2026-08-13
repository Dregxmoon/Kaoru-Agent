// @ts-nocheck
// helpers.js — funciones puras del ProactiveEngine (sin estado de instancia).

const { getIdentity } = require('../../grounding/GroundingEngine.js');
const { LOW_VALUE_MSGS, MEDIA_PLATFORMS } = require('./config.js');
const { extractThemeTerms } = require('../../core/misc.js');

function _isLowValueMessage(msg) {
  const norm = msg
    .toLowerCase()
    .trim()
    .replace(/[¿?¡!.,:;]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (LOW_VALUE_MSGS.has(norm)) return true;
  if (norm.length < 8) return true; // filler demasiado corto para tener sustancia
  return false;
}

/**
 * Extrae SOLO el mensaje final de una respuesta del LLM, descartando cualquier
 * bloque de razonamiento/chain-of-thought que el modelo haya vuelto en el
 * content (modelos de razonamiento tipo qwen: "Here's a thinking process...",
 * "Analyze User Input:...", secciones "Draft", "Constraints", etc.).
 *
 * Esos bloques pueden filtrar datos internos del sistema (score del gate,
 * umbrales, contexto crudo del trigger) que el usuario jamás debe ver: aquí se
 * eliminan y se conserva únicamente el texto que Kaoru le diría a la persona.
 *
 * @param {*} text  respuesta cruda del LLM
 * @returns {string} mensaje final limpio (o '' si no hay nada aprovechable)
 */
function _extractFinalMessage(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text.trim();
  if (!out) return '';

  // Respuesta directa sin razonamiento → devolver tal cual (caso común).
  if (
    !/thinking process|analy(z|s)e|draft|constraints|I (must|need to|should|'ll)/i.test(
      out.slice(0, 600)
    )
  ) {
    return out;
  }

  // Bloques de razonamiento conocidos a recortar por marcador de cabecera.
  const CUT_MARKERS = [
    /^Here('| i)?s a thinking process/i,
    /^Let me think/i,
    /^I need to think/i,
    /^Thought:\s*$/m,
    /^Thought process:/i,
    /^Analy(se|ze) the/i,
    /^Analyze user input/i,
    /^Current Context:/i,
    /^Open Apps:/i,
    /^Trigger\/Reason:/i,
    /^Constraints:/i,
    /^Memory\/Projects:/i,
    /^Identify Key Contextual Hooks:/i,
    /^Draft[ -]/i,
    /^Check constraints:/i,
    /^Let's verify/i,
    /^Let’s verify/i,
  ];

  for (const marker of CUT_MARKERS) {
    const m = out.match(marker);
    if (m) {
      out = out.slice(0, m.index).trim() + '\n' + out.slice(m.index).replace(marker, ' ').trim();
      // sigue el mismo barrido para encadenar recortes
      out = out.trim();
    }
  }

  // Separar párrafos y quedarse con el último que parezca un mensaje real
  // (decisión/cadena de razonamiento breve excluida).
  const paras = out
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  // Al final del razonamiento suele venir el mensaje como último párrafo.
  let last = paras.length ? paras[paras.length - 1] : '';
  if (last && last.length < 8) {
    // párrafo de cierre demasiado corto (p.ej. "Better.") → probar el anterior
    if (paras.length > 1) last = paras[paras.length - 2];
  }
  if (last && /^(Better|Yes|No|Wait|Hmm|Ok|OK|Check|Let's|Let’s)/i.test(last)) {
    last = paras.length > 2 ? paras[paras.length - 3] : last;
  }

  if (last && last.length >= 8) {
    // quitar restos de razonamiento inline dentro del párrafo elegido
    last = last
      .split('\n')
      .filter(
        (line) =>
          !/^(Here('| i)?s a thinking process|Let me think|Analy(se|ze)|Draft|Constraint|Check:|Let's verify|Let’s verify|I must|I need to|I should|I'll|Wait|Hmm|Better|Yes|No\.?$|Ok\.?$)/i.test(
            line.trim()
          )
      )
      .join('\n')
      .trim();
  }

  return last && last.length >= 8 ? last : out.split('\n').pop() || out;
}

function _monthName(monthIndex) {
  const months = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  return months[monthIndex];
}

function _triggerDescription(trigger) {
  if (trigger.forcedMismatch) {
    return `Esto es una prueba de testing forzada manualmente y NO corresponde con la realidad actual (revisa la hora real arriba). No actúes como si la premisa del trigger fuera cierta. En vez de eso, puedes comentar algo genuino sobre el momento actual real, hacer un chiste sobre la prueba si te parece natural, o simplemente decir algo que se te haya quedado pensando de la memoria. Si nada de esto se siente genuino, responde NO.`;
  }

  switch (trigger.type) {
    case 'late_night':
      return `Son las ${trigger.hour}am y el usuario sigue despierto frente al PC. Esto te preocupa un poco — no le sermonees, pero puedes decir algo que muestre que te importa que duerma, o preguntarle qué lo tiene despierto a estas horas.`;
    case 'long_silence':
      return `Llevan ${trigger.hours} horas sin hablar. Si hay algo de las sesiones recientes que se te quedó pensando, retómalo. Si no, un comentario casual también vale — no necesita ser sobre el proyecto.`;
    case 'special_date':
      return `Hoy es una fecha especial: ${trigger.node}. Reacciona de forma natural, no exagerada.`;
    case 'sustained_focus':
      return `El usuario lleva ${trigger.elapsedFormatted || 'un buen rato'} ${trigger.label || 'enfocado'} en ${trigger.friendlyName || 'una aplicación'}${trigger.title ? ` (título de la ventana: "${trigger.title.slice(0, 80)}")` : ''}. Si el título te da una pista concreta de lo que está haciendo, úsala — sé específica, no genérica ("¿cómo va el código?" es el tipo de pregunta que NO quieres repetir siempre). Puedes preguntar algo puntual, comentar el tiempo que lleva metido en esto, o simplemente no decir nada si no tienes algo genuino.`;
    case 'focus_block_end':
      return `El usuario acaba de terminar un bloque de ${Math.round((trigger.streakSec || 0) / 60)} minutos ${trigger.label || 'de enfoque'}${trigger.title ? ` (estaba en: "${trigger.title.slice(0, 80)}")` : ''}. Es el borde natural del bloque — el momento humano para comentar lo que estuvo haciendo: un logro, preguntar cómo le fue, o simplemente quedarse en silencio. No interrumpas nada: ya cambió de tarea. Si no tienes algo concreto y genuino, responde NO.`;
    case 'context_switch_thrash':
      return `El usuario cambió de aplicación ${trigger.switchCount} veces en pocos minutos, saltando entre: ${trigger.categories?.join(', ')}${trigger.apps?.length ? ` (apps: ${trigger.apps.join(', ')})` : ''}.${trigger.title ? ` Ahora mismo la ventana activa es: "${trigger.title.slice(0, 80)}".` : ''} Esto puede ser una señal de que está atorado, distraído, o buscando algo que no encuentra. Usa los datos REALES (apps y ventana actual) para decir algo específico y natural — nada de genéricos tipo "¿andas buscando algo?" por enésima vez. No lo regañes ni asumas lo peor: puedes comentar lo que ves con curiosidad genuina, ofrecer ayuda si el título sugiere un problema, o simplemente no decir nada si no se siente genuino. Si no hay algo concreto que decir, responde NO.`;
    case 'media_watching':
      return `El usuario está viendo o escuchando: "${trigger.title}"${trigger.platform ? ` (${trigger.platform})` : ''}. Puedes OPINAR o hacer un comentario casual sobre ese contenido — no hace falta que termines en pregunta. Si en la memoria hay gustos relacionados (música, anime, género...), conéctalos: p.ej. "ah, ese es de los que te gustan". Si NO sabes nada de sus gustos sobre este contenido, pregúntale con curiosidad genuina qué es o si le gusta — es una buena forma de conocerle. NUNCA afirmes datos del usuario que no estén respaldados por la memoria del prompt. Un comentario vacío o genérico es peor que no decir nada: si no hay nada genuino, responde NO.`;
    case 'return_from_break':
      return `El usuario estuvo fuera de la PC unos ${Math.round((trigger.gapSec || 0) / 60)} minutos y acaba de volver. Un comentario breve y casual de bienvenida puede ser genuino aquí — pero no es obligatorio, si no tienes algo natural que decir responde NO.`;
    case 'session_end':
      return `El usuario venía de una sesión de ${Math.round((trigger.streakSec || 0) / 60)} minutos en una categoría de trabajo y acaba de cambiar a otra cosa. Puedes comentar algo sobre lo que estaba haciendo, preguntar cómo le fue, o simplemente no decir nada si no se siente genuino.`;
    case 'git_redflag':
      return `Hay una alerta de git en el repositorio del usuario: ${trigger.context} Si es algo que de verdad vale la pena señalar (p. ej. secretos a punto de filtrarse), dilo con naturalidad y sin regaños; si no es el momento o no es genuino, responde NO.`;
    case 'system_warning':
      return `Hay una advertencia del sistema: ${trigger.context} Avisa de forma breve y natural si lo amerita, sin sermonear ni repetir lo obvio. Si no hay nada genuino que decir, responde NO.`;
    case 'error_title':
      return `La ventana activa del usuario parece mostrar un error. Puedes ofrecer ayuda concreta, pero NO asumas que está frustrado ni inventes detalles que no ves. Si no se siente genuino, responde NO.`;
    case 'clipboard_context':
      return `El usuario acaba de copiar contenido de alto valor al portapapeles. Si es un error/stacktrace, puedes ofrecerte a ayudarle con él de forma natural. No menciones que lees el portapapeles. Si no es genuino, responde NO.`;
    case 'upcoming_event':
      return `Hay un recordatorio cercano que el usuario pidió que guardaras. Recuérdaselo de forma breve y natural, sin dramatismo.`;
    case 'lsp_error':
      return `El LSP detectó un error de código en el archivo que el usuario trabaja. Puedes avisarle con naturalidad y ofrecer el parche si es genuino; no inventes el error ni exageres su gravedad. Si no se siente genuino, responde NO.`;
    default:
      return trigger.context;
  }
}

function _safeGetIdentity() {
  try {
    return getIdentity();
  } catch (_) {
    return {
      core: 'Eres la asistente personal. Tienes carácter propio y eres cercana a la persona con quien hablas.',
    };
  }
}

/**
 * Detecta contenido de media (video/canción) en el título de una ventana.
 * Cubre dos vías:
 *   - apps de media por categoría del OSSensor (`media`: Spotify, VLC...) — el
 *     título ES el contenido ("Canción - Artista").
 *   - navegador con plataforma reconocible al final del título ("X - YouTube",
 *     "X - Twitch"...). Devuelve el título limpio (sin la plataforma) y el
 *     nombre de la plataforma, o null si no hay contenido reconocible.
 * @param {string} title  título de la ventana activa (ya sin el navegador)
 * @param {string} category  categoría del OSSensor ('media', 'browser', ...)
 * @returns {{ title: string, platform: string } | null}
 */
function _detectMediaTitle(title, category) {
  if (!title) return null;
  const t = String(title).trim();
  if (!t) return null;

  if (category === 'media') {
    // Spotify/VLC: limpiar sufijos de reproductor y quedarnos con el contenido.
    const cleaned = t
      .replace(/\s*[-–—]\s*VLC media player\s*$/i, '')
      .replace(/\s*[-–—]\s*Spotify\s*$/i, '')
      .trim();
    if (!cleaned) return null;
    return { title: cleaned, platform: /spotify/i.test(t) ? 'spotify' : 'media' };
  }

  if (category === 'browser') {
    for (const { platform, re } of MEDIA_PLATFORMS) {
      const m = re.exec(t);
      if (m) {
        const clean = t
          .slice(0, m.index)
          .replace(/\s*[-–—]\s*$/, '')
          .trim();
        if (!clean) return null;
        return { title: clean, platform };
      }
    }
  }

  return null;
}

/**
 * Busca en la memoria real de gustos los nodos relacionados con el título de
 * contenido en pantalla (video/canción). Compara por términos significativos
 * compartidos: si el título trae "G2 Shanks" y la memoria tiene
 * `musica_favorita: "G2 Shanks"`, hay match y Kaoru puede decir "ah, ese es
 * de los que te gustan".
 * @param {string} title  título de media ya limpio (sin la plataforma)
 * @param {Array<any>} nodes  nodos de memoria real (ya filtrados por identidad)
 * @returns {Array<{ label: string, content: string, score: number }>}
 */
function _matchMediaTaste(title, nodes) {
  const titleTerms = extractThemeTerms(title);
  if (!titleTerms.length || !Array.isArray(nodes) || !nodes.length) return [];
  const matches = [];
  for (const node of nodes) {
    const content = String(node?.content || '').trim();
    if (!content) continue;
    const haystack = content.toLowerCase();
    const shared = titleTerms.filter((t) => haystack.includes(t)).length;
    if (shared > 0) {
      matches.push({ label: node.label || '', content: content.slice(0, 140), score: shared });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

// ── Helpers de Fase C ─────────────────────────────────────────────────────────

function _localDayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 0 = mismo día, 1 = mañana, -1 = ayer... (día calendario local). */
function _dayOffset(tsA, tsB) {
  const a = new Date(tsA),
    b = new Date(tsB);
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da - db) / 86400000);
}

function _friendlyWhen(ts) {
  const offset = _dayOffset(ts, Date.now());
  const time = new Date(ts).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  if (offset === 0) return `hoy a las ${time}`;
  if (offset === 1) return `mañana a las ${time}`;
  return new Date(ts).toLocaleDateString('es-MX', { day: 'numeric', month: 'long' });
}

/**
 * Fase D: extrae el JSON `{ changes: [...] }` de la respuesta del LLM de
 * parches. Defensivo: soporta JSON puro, bloques ```json y el caso de que el
 * modelo envuelva el objeto con texto.
 */
function _extractPatch(response) {
  if (!response) return null;
  let text = String(response).trim();
  if (!text) return null;

  // Quitar fences de código.
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {}

  // Fallback: capturar el objeto JSON más externo con "changes".
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {}

  return null;
}

/**
 * Regla de lenguaje para el prompt de parche: evita que el LLM use sintaxis de
 * un lenguaje distinto al del archivo. El caso típico: un `.js` bajo checkJs
 * reporta `implicit any` (7006) "en TS", y un LLM sin contexto anota
 * `a: number` — sintaxis inválida en JS. Aquí se le dice explícitamente.
 */
function _patchLanguageRule(fileType) {
  const t = String(fileType || '').toLowerCase();
  if (t === '.ts' || t === '.tsx' || t === '.mts' || t === '.cts') {
    return '5. El archivo es TypeScript: las anotaciones de tipos (a: number) son válidas.';
  }
  if (t === '.js' || t === '.jsx' || t === '.mjs' || t === '.cjs') {
    return '5. El archivo es JavaScript: PROHIBIDO usar anotaciones de tipos de TypeScript (a: number) — es sintaxis inválida en JS y rompería el archivo. Los errores de tipos (implicit any) se resuelven con comentarios JSDoc (`/** @param {number} a */`) o simplemente dejando la firma sin tipos.';
  }
  if (t === '.py') {
    return '5. El archivo es Python: respeta la sintaxis de Python (sin tipos TS, sin puntos y comas).';
  }
  return '';
}

module.exports = {
  _isLowValueMessage,
  _extractFinalMessage,
  _monthName,
  _triggerDescription,
  _safeGetIdentity,
  _detectMediaTitle,
  _matchMediaTaste,
  _localDayString,
  _dayOffset,
  _friendlyWhen,
  _extractPatch,
  _patchLanguageRule,
};
