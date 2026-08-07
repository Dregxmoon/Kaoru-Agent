// helpers.js — funciones puras del ProactiveEngine (sin estado de instancia).

const { getIdentity } = require('../../grounding/GroundingEngine.js');
const { LOW_VALUE_MSGS } = require('./config.js');

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
    case 'context_switch_thrash':
      return `El usuario cambió de aplicación ${trigger.switchCount} veces en pocos minutos, saltando entre: ${trigger.categories?.join(', ')}. Esto puede ser una señal de que está atorado, distraído, o buscando algo que no encuentra. No lo regañes ni asumas lo peor — puedes preguntar con curiosidad genuina si anda buscando algo o si algo no le está saliendo. Si no se siente genuino, responde NO.`;
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
  _monthName,
  _triggerDescription,
  _safeGetIdentity,
  _localDayString,
  _dayOffset,
  _friendlyWhen,
  _extractPatch,
  _patchLanguageRule,
};
