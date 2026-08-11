// config.js — constantes y mapas de configuración del ProactiveEngine.
// Se mantienen fuera de la clase para poder testear umbrales y cooldowns
// sin instanciar el engine, y para que cada mixin importe solo lo que usa.

const { DEFAULT_POLICY } = require('../../decision/DecisionCore.js');

// ── Configuración general ───────────────────────────────────────────────────

const EVAL_INTERVAL_MS = 5 * 60 * 1000; // heartbeat para triggers temporales
const GLOBAL_MIN_GAP_MS = 25 * 60 * 1000; // colchón mínimo entre CUALQUIER mensaje autónomo
const SILENCE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
const LATE_NIGHT_START = 0;
const LATE_NIGHT_END = 5;
const MAX_IDLE_TO_INTERRUPT = 30 * 60; // segundos — no interrumpir si lleva más de esto AFK
const RECENT_CHAT_MS = 2 * 60 * 1000; // no interrumpir si el usuario conversó hace < 2 min
const FOLLOWUP_MULTIPLIER = 3; // cuántas veces el minSec antes de un follow-up
const SESSION_END_MIN_SEC = 20 * 60; // mínimo de racha para trigger "fin de sesión"

// Presupuesto diario de iniciativas proactivas ENVIADAS. Ya NO es un tope duro
// en el gate: el techo real lo impone el presupuesto DINÁMICO del núcleo
// (F-1), que oscila entre budget.min y budget.max según la receptividad del
// usuario (receptividad buena → hasta 20/día). DAILY_BUDGET queda como
// referencia del valor base (receptividad neutra) y se mantiene alineado con
// `DEFAULT_POLICY.budget.base` para que no haya dos números que desincronizar.
const DAILY_BUDGET = DEFAULT_POLICY.budget.base;
const PENDING_LOOKAHEAD_MS = 45 * 60 * 1000; // pendientes a <45 min para el recap de arranque

// ── Curiosidad sobre la memoria (presupuesto PROPIO) ─────────────────────────
// Preguntas sobre hechos sospechosos (F3.1 'stale'), inferencias de confianza
// media (Fase 4) y contradicciones vivas (getTensions). Viven en un cupo
// diario SEPARADO del presupuesto general (DAILY_BUDGET/dinámico): un día con
// mucha proactividad de código no agota la curiosidad, y viceversa. El gate
// (ContextGate) rechaza (DROP) cuando se alcanza el cupo, sin importar cuánto
// quede del presupuesto general.
const CURIOSITY_DAILY_CAP = 2;
const CURIOSITY_TYPES = new Set([
  'memory_stale',
  'pattern_uncertain',
  'memory_tension',
  'intention_stale',
]);

// Una intención activa con `last_progress_at` más viejo que esto (días) se
// considera ABANDONADA y genera un candidato de curiosidad con el texto REAL
// de la meta ("dijiste que ibas a X, ¿cómo va?").
const INTENTION_STALE_DAYS = 5;

// G.1: proactividad de alta calidad. Mensajes "relleno" que no aportan nada
// (saludos vacíos, check-ins genéricos) se descartan en modo producción (gate
// admitió). El gate ya validó relevancia; el mensaje debe tener sustancia.
const LOW_VALUE_MSGS = new Set([
  'hola',
  'hey',
  'hi',
  'holi',
  'saludos',
  'buenas',
  'buenas tardes',
  'buenos dias',
  'cómo estas',
  'como estas',
  'cómo va',
  'como va',
  'cómo va el proyecto',
  'como va el proyecto',
  'cómo va todo',
  'como va todo',
  'cómo va tu dia',
  'como va tu dia',
  'todo bien',
  'todo bien?',
  'que tal',
  'qué tal',
  'que haces',
  'qué haces',
  'sigues ahi',
  'sigues ahí',
  'estas ahi',
  'estás ahí',
  'ya atorada',
  'ya atorado',
  'en qué puedo ayudarte',
  'en que puedo ayudarte',
]);

// ── Pre-filtro barato para triggers basados en actividad del OS ─────────────
// (reemplaza las INITIATIVE_RULES de InitiativeEngine.js — mismo umbral por
// categoría, pero aquí solo decide si vale la pena PREGUNTARLE al LLM, no
// qué decir)
const FOCUS_RULES = {
  code: { minSec: 5 * 60, label: 'programando' },
  terminal: { minSec: 3 * 60, label: 'en la terminal' },
  docs: { minSec: 10 * 60, label: 'metido en documentos' },
  design: { minSec: 10 * 60, label: 'diseñando' },
  browser: { minSec: 15 * 60, label: 'navegando' },
  // Antes 'game' ni existía como categoría (ver fix en OSSensor.js) — sin
  // esto, jugar era invisible para toda la proactividad sin importar
  // cuánto tiempo llevaras. 40 min porque una sesión de juego típica es
  // más larga que una racha de código antes de que valga la pena comentar.
  game: { minSec: 40 * 60, label: 'jugando' },
};

const THRASH_WINDOW_MS = 10 * 60 * 1000; // ventana para detectar "salto entre apps"
const THRASH_MIN_SWITCHES = 6; // mínimo de cambios de app en la ventana
const THRASH_MIN_DISTINCT_CATEGORY = 3; // mínimo de categorías distintas involucradas

// ── Contenido en pantalla (media) ────────────────────────────────────────────
// El trigger `media_watching` comenta lo que el usuario está viendo/escuchando
// (YouTube, Twitch, Netflix, Spotify, VLC...). Se dispara una vez por video/
// canción tras unos minutos de racha sobre el MISMO título, conectándolo con
// los gustos que haya en memoria (o preguntando con curiosidad si no hay).
const MEDIA_MIN_SEC = 2 * 60; // racha mínima sobre el mismo título para comentar
// Plataformas de video/streaming detectables en el título de una ventana del
// navegador ("Título - YouTube - Google Chrome"). `media` (Spotify/VLC) se
// detecta por categoría del OSSensor, sin necesidad de patrón.
const MEDIA_PLATFORMS = [
  { platform: 'youtube', re: /\s*[-–—]\s*(youtube|ytmusic)\s*$/i },
  { platform: 'twitch', re: /\s*[-–—]\s*twitch\s*$/i },
  { platform: 'netflix', re: /\s*[-–—]\s*netflix\s*$/i },
  { platform: 'spotify', re: /\s*[-–—]\s*spotify\s*$/i },
];

const RETURN_MIN_GAP_SEC = 15 * 60; // mínimo de ausencia para que valga la pena comentar
const RETURN_MAX_GAP_SEC = 3 * 60 * 60; // más que esto ya es más parecido a "long_silence"

const WORK_CATEGORIES = new Set(['code', 'terminal', 'docs', 'design']);

// ── Fase A: autonomía con consentimiento ──────────────────────────────────────
// El mensaje proactivo pasa de comentario a *propuesta*: además del texto del
// LLM, el payload lleva un bloque `proposal` determinista (NUNCA inventado por
// el modelo) con un título, un preview de qué pasaría y — si aplica — una
// acción declarada que en la Fase B ejecutará un executor whitelisted tras la
// confirmación del usuario. Hoy la acción se registra (feedback), no se ejecuta.
//
// La escalera: observar → informar → proponer → actuar. El slider de autonomía
// (config `autonomy`) controla cuánto sube el engine en esa escalera:
//   observe → ni informa (sensores corren, cero mensajes proactivos)
//   suggest → informa + propone botones (default)
//   act     → en Fase B habilita ejecutar tras confirmación; hoy = suggest.
const AUTONOMY_MODES = ['observe', 'suggest', 'act'];

// Propuestas por tipo de trigger (+kind del sensor). `action` es declarativo:
// define QUÉ se haría, pero en Fase A no ejecuta nada. `kind: 'info'` = solo
// informar/confirmar; `kind: 'action'` = tiene una acción concreta detrás.
const PROPOSAL_HINTS = {
  git_redflag: {
    env_unignored: {
      title: 'Añadir el archivo sensible a .gitignore',
      preview:
        'Añadir a .gitignore el archivo que parece contener secretos, para que no se suba por accidente.',
      kind: 'action',
      action: { tool: 'gitignore_add', params: {} },
    },
    merge_conflict: {
      title: 'Ver los archivos en conflicto',
      preview: 'Ejecutar git status para listar los archivos que quedaron en conflicto.',
      kind: 'action',
      action: { tool: 'git_status', params: {} },
    },
    uncommitted: {
      title: 'Ver qué hay sin commitear',
      preview: 'Ejecutar git status para revisar los cambios pendientes.',
      kind: 'action',
      action: { tool: 'git_status', params: {} },
    },
    default: {
      title: 'Ver el estado del repositorio',
      preview: 'Revisar el estado actual de git en tu workspace.',
      kind: 'action',
      action: { tool: 'git_status', params: {} },
    },
  },
  system_warning: {
    default: {
      title: 'Ver el detalle de la advertencia',
      preview: 'Revisar qué recurso del sistema está al límite y qué puedes hacer.',
      kind: 'info',
      action: null,
    },
  },
  error_title: {
    default: {
      title: 'Abrir el chat y verlo juntos',
      preview: 'Te cuento lo que se ve en tu pantalla y vemos si puedo ayudar con el error.',
      kind: 'info',
      action: null,
    },
  },
  clipboard_context: {
    default: {
      title: 'Trabajar sobre lo que copiaste',
      preview: 'Si es un error o una URL, seguimos desde ahí en el chat.',
      kind: 'info',
      action: null,
    },
  },
  upcoming_event: {
    default: {
      title: 'Confirmar que lo tengo presente',
      preview: 'Anotado — te lo recuerdo cuando toque.',
      kind: 'info',
      action: null,
    },
  },
  pending_recap: {
    default: {
      title: 'Retomar lo pendiente',
      preview: 'Recordarte lo que me pediste tener presente al arrancar.',
      kind: 'info',
      action: null,
    },
  },
  // Curiosidad sobre una inferencia de confianza media (Fase 4): la respuesta
  // (aceptar/descartar) confirma o archiva el nodo inferido vía
  // UserModelBuilder.confirmInferred() — además del feedback general.
  pattern_uncertain: {
    default: {
      title: 'Aclarar esa conclusión',
      preview: 'Confirmas o corriges si lo que asumí sobre ti sigue siendo cierto o no.',
      kind: 'info',
      action: null,
    },
  },
  // Curiosidad sobre un hecho sospechoso (F3.1 'stale'): la respuesta CIERRA el
  // lazo de revalidación — aceptar refresca verified_at y quita el tag 'stale',
  // rechazar archiva el dato caduco (curiosity._connectCuriosityOutcome).
  memory_stale: {
    default: {
      title: 'Confirmar que sigue vigente',
      preview: 'Confirmas si el dato que me contaste antes sigue siendo cierto o si ya cambió.',
      kind: 'info',
      action: null,
    },
  },
  // Curiosidad sobre una contradicción viva (getTensions): aceptar conserva la
  // primera versión, rechazar la segunda; la descartada se archiva y el par
  // CONTRADICES deja de aparecer en el siguiente barrido.
  memory_tension: {
    default: {
      title: 'Cuál de las dos es la correcta',
      preview: 'Eliges cuál de las dos versiones contradictorias se queda en mi memoria.',
      kind: 'info',
      action: null,
    },
  },
  // Curiosidad sobre una intención abandonada: el mensaje real lo arma el LLM
  // con el TEXTO REAL de la meta (message-gen). Este bloque solo es el título/
  // preview determinista de la propuesta en el chat.
  intention_stale: {
    default: {
      title: 'Retomar esa meta',
      preview: 'Preguntarte cómo va lo que me pediste hacer hace días.',
      kind: 'info',
      action: null,
    },
  },
  // Fase D: error de código detectado por el LSP. La propuesta pide un parche;
  // si el LLM no logra generar uno válido, cae a informativa (ver el error).
  lsp_error: {
    default: {
      title: 'Proponer un parche para el error',
      preview: 'Generar y proponer un parche que corrija el error detectado por el LSP.',
      kind: 'action',
      action: { tool: 'apply_patch', params: {} },
    },
    no_patch: {
      title: 'Ver el error de código',
      preview: 'Te enseño dónde está el error en tu código y vemos cómo resolverlo.',
      kind: 'info',
      action: null,
    },
  },
};

const DEFAULT_AUTONOMY_MODE = 'suggest';

// Cooldown por TIPO de trigger — tanto para intentos (se le preguntó al LLM,
// haya dicho sí o no) como, en la práctica, para envíos exitosos.
const TRIGGER_COOLDOWN_MS = {
  special_date: 20 * 60 * 60 * 1000,
  late_night: 2 * 60 * 60 * 1000,
  long_silence: 3 * 60 * 60 * 1000,
  sustained_focus: 45 * 60 * 1000,
  focus_block_end: 45 * 60 * 1000,
  context_switch_thrash: 60 * 60 * 1000,
  return_from_break: 45 * 60 * 1000,
  session_end: 60 * 60 * 1000,
  media_watching: 2 * 60 * 60 * 1000,
  // Señales de sensores — la frecuencia real la marca cada sensor (re-emiten
  // mientras la condición persista); aquí solo se evita consultar al LLM en
  // exceso para el mismo tipo de señal.
  git_redflag: 6 * 60 * 60 * 1000,
  system_warning: 60 * 60 * 1000,
  error_title: 30 * 60 * 1000,
  clipboard_context: 30 * 60 * 1000,
  upcoming_event: 30 * 60 * 1000,
  pending_recap: 60 * 60 * 1000,
  lsp_error: 45 * 60 * 1000,
  // Curiosidad sobre la memoria: cupo bajo (2/día) y cooldown largo por tipo
  // para no repetir la pregunta del mismo tipo varias veces en el día.
  memory_stale: 6 * 60 * 60 * 1000,
  pattern_uncertain: 6 * 60 * 60 * 1000,
  memory_tension: 6 * 60 * 60 * 1000,
  intention_stale: 6 * 60 * 60 * 1000,
};

module.exports = {
  EVAL_INTERVAL_MS,
  GLOBAL_MIN_GAP_MS,
  SILENCE_THRESHOLD_MS,
  LATE_NIGHT_START,
  LATE_NIGHT_END,
  MAX_IDLE_TO_INTERRUPT,
  RECENT_CHAT_MS,
  FOLLOWUP_MULTIPLIER,
  SESSION_END_MIN_SEC,
  DAILY_BUDGET,
  PENDING_LOOKAHEAD_MS,
  CURIOSITY_DAILY_CAP,
  CURIOSITY_TYPES,
  INTENTION_STALE_DAYS,
  LOW_VALUE_MSGS,
  FOCUS_RULES,
  THRASH_WINDOW_MS,
  THRASH_MIN_SWITCHES,
  THRASH_MIN_DISTINCT_CATEGORY,
  MEDIA_MIN_SEC,
  MEDIA_PLATFORMS,
  RETURN_MIN_GAP_SEC,
  RETURN_MAX_GAP_SEC,
  WORK_CATEGORIES,
  AUTONOMY_MODES,
  PROPOSAL_HINTS,
  DEFAULT_AUTONOMY_MODE,
  TRIGGER_COOLDOWN_MS,
};
