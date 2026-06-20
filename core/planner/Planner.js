/**
 * Planner.js — Fase 3 v7
 *
 * Fix v6 → v7:
 *   code_execution — nuevo patrón en ActionParser: detecta instrucciones
 *                    como "ejecuta este código: `print('hola')`" y las
 *                    despacha a la herramienta code_execution.
 *
 *   apply_patch — nuevo patrón: "aplica este patch a app.js: ```...```"
 *                 despacha a apply_patch con el contenido del diff.
 *
 *   isHighImpact — code_execution y apply_patch ahora requieren
 *                  aprobación del usuario, igual que edit_file/create_file.
 *
 *   web_search/browser — sin cambios en Planner.js; la implementación
 *   real (Playwright headless) vive en BrowserBridge.js, conectado vía
 *   OpenClawBridge.js. Planner solo detecta la intención y construye el plan.
 *
 * Cambios mantenidos de v6:
 *   _executeStep única definición (antes había una duplicada — bug crítico).
 *   create_file — llm → write → verify para archivos nuevos.
 *   edit_file   — read → llm_transform → write → verify para archivos existentes.
 *   Chunking dinámico para archivos grandes según el proveedor LLM activo.
 */

'use strict';

const path = require('path');
const { getOpenClawBridge } = require('./OpenClawBridge.js');

// ── CWD del proyecto ──────────────────────────────────────────────────────────
let PROJECT_CWD = process.cwd();

function setProjectCWD(cwd) {
  if (cwd && typeof cwd === 'string') {
    PROJECT_CWD = cwd;
    console.log('[planner] CWD del proyecto:', PROJECT_CWD);
  }
}

// ── LLM Provider ──────────────────────────────────────────────────────────────
let _llmComplete = null;

function _getLLMComplete() {
  if (_llmComplete) return _llmComplete;
  try {
    const LLMProvider = require('../llm/LLMProvider.js');
    if (typeof LLMProvider.completeTask === 'function') {
      return LLMProvider.completeTask.bind(LLMProvider);
    }
    return LLMProvider.complete.bind(LLMProvider);
  } catch (e) {
    throw new Error(
      'LLMProvider no encontrado. Asegúrate de que ../llm/LLMProvider.js existe, ' +
      'o usa setLLMProvider(fn) para inyectar tu propio cliente.'
    );
  }
}

function setLLMProvider(fn) {
  if (typeof fn !== 'function') throw new Error('setLLMProvider: se esperaba una función');
  _llmComplete = fn;
  console.log('[planner] LLMProvider personalizado configurado');
}

// ── Límites de contexto por proveedor (chars de INPUT seguros) ────────────────
const PROVIDER_LIMITS = {
  groq:    8_000,
  gemini: 100_000,
  openai:  80_000,
  default:  8_000,
};

function _getProviderLimit() {
  try {
    const LLMProvider = require('../llm/LLMProvider.js');
    const provider    = LLMProvider.getActiveProvider() || 'default';
    return PROVIDER_LIMITS[provider] ?? PROVIDER_LIMITS.default;
  } catch {
    return PROVIDER_LIMITS.default;
  }
}

function _splitIntoSections(content, filePath) {
  const ext   = filePath.split('.').pop().toLowerCase();
  const lines = content.split('\n');

  if (['md', 'markdown', 'txt', 'rst'].includes(ext)) {
    const sections = [];
    let current    = [];
    for (const line of lines) {
      if (/^#\s/.test(line) && current.length > 0) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) sections.push(current.join('\n'));
    return sections.length > 1 ? sections : [content];
  }

  if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'cpp', 'c'].includes(ext)) {
    const SECTION_START = /^(?:function\s|class\s|const\s+\w+\s*=\s*(?:async\s+)?(?:function|\()|async\s+function\s|def\s|public\s|private\s|protected\s|export\s)/;
    const sections = [];
    let current    = [];
    for (const line of lines) {
      if (SECTION_START.test(line) && current.length > 5) {
        sections.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length) sections.push(current.join('\n'));
    return sections.length > 1 ? sections : [content];
  }

  const sections = [];
  for (let i = 0; i < lines.length; i += 200) {
    sections.push(lines.slice(i, i + 200).join('\n'));
  }
  return sections;
}

function _findRelevantSection(sections, instruction) {
  const STOPWORDS = new Set(['el','la','los','las','un','una','en','de','que','y','a','con','por','para','al','del']);
  const keywords  = instruction
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));

  if (!keywords.length) return sections.length - 1;

  let bestIdx   = 0;
  let bestScore = -1;

  for (let i = 0; i < sections.length; i++) {
    const sectionLower = sections[i].toLowerCase();
    const score = keywords.filter(kw => sectionLower.includes(kw)).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  return bestIdx;
}

async function _llmTransform(originalContent, instruction, filePath) {
  const complete = _getLLMComplete();
  const limit    = _getProviderLimit();

  const systemPrompt = [
    'Eres un editor de archivos de texto.',
    'Recibirás el contenido de un archivo (completo o en sección) y una instrucción.',
    'Devuelve ÚNICAMENTE el contenido modificado, sin explicaciones,',
    'sin bloques markdown (no uses ```), sin comentarios adicionales.',
    'El output es exactamente el texto que debe quedar en el archivo.',
    'No agregues nada antes ni después del contenido.',
  ].join(' ');

  if (originalContent.length <= limit) {
    console.log(`[planner] _llmTransform: modo completo (${originalContent.length} chars, límite ${limit})`);

    const userMessage = [
      `Archivo: ${filePath}`,
      '',
      '--- CONTENIDO ACTUAL ---',
      originalContent,
      '--- FIN CONTENIDO ---',
      '',
      `Instrucción: ${instruction}`,
      '',
      'Devuelve el nuevo contenido completo del archivo.',
    ].join('\n');

    const newContent = await complete(
      [{ role: 'user', content: userMessage }],
      systemPrompt
    );

    if (!newContent || !newContent.trim()) {
      throw new Error('El LLM devolvió contenido vacío (modo completo).');
    }

    return newContent;
  }

  console.log(`[planner] _llmTransform: modo chunking (${originalContent.length} chars > límite ${limit})`);

  const sections    = _splitIntoSections(originalContent, filePath);
  const relevantIdx = _findRelevantSection(sections, instruction);

  console.log(`[planner] chunking: ${sections.length} secciones, relevante: #${relevantIdx}`);

  const CONTEXT_SECTIONS = [
    relevantIdx > 0             ? sections[relevantIdx - 1] : null,
    sections[relevantIdx],
    relevantIdx < sections.length - 1 ? sections[relevantIdx + 1] : null,
  ].filter(Boolean);

  const contextContent = CONTEXT_SECTIONS.join('\n');

  const chunkContent = contextContent.length <= limit
    ? contextContent
    : sections[relevantIdx].slice(0, limit);

  const isPartial   = sections.length > 1;
  const sectionInfo = isPartial
    ? `Esta es la sección ${relevantIdx + 1} de ${sections.length} del archivo.`
    : '';

  const userMessage = [
    `Archivo: ${filePath}`,
    sectionInfo,
    '',
    '--- CONTENIDO A MODIFICAR ---',
    chunkContent,
    '--- FIN CONTENIDO ---',
    '',
    `Instrucción: ${instruction}`,
    '',
    isPartial
      ? 'Devuelve ÚNICAMENTE esta sección modificada. No incluyas otras partes del archivo.'
      : 'Devuelve el nuevo contenido completo del archivo.',
  ].filter(Boolean).join('\n');

  const modifiedChunk = await complete(
    [{ role: 'user', content: userMessage }],
    systemPrompt
  );

  if (!modifiedChunk || !modifiedChunk.trim()) {
    throw new Error('El LLM devolvió contenido vacío (modo chunking).');
  }

  if (!isPartial) return modifiedChunk;

  const startIdx = Math.max(0, relevantIdx - 1);
  const endIdx   = Math.min(sections.length - 1, relevantIdx + 1);

  const rebuiltSections = [
    ...sections.slice(0, startIdx),
    modifiedChunk,
    ...sections.slice(endIdx + 1),
  ];

  return rebuiltSections.join('\n');
}

// ── Clasificación de impacto ──────────────────────────────────────────────────
const HIGH_IMPACT_PATTERNS = [
  /\brm\s+-rf?\b/i, /\bdel\s+\/[sqf]/i, /\bformat\b/i,
  /\bshutdown\b/i,  /\breboot\b/i,      /\bpoweroff\b/i,
  /\bkill\s+-9\b/,  /C:\\Windows\\/i,   /\/etc\//,
  /\/sys\//,        /\/boot\//,
];

function isHighImpact(tool, params) {
  if (tool === 'exec' && params.command)
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.command));
  if (tool === 'write' && params.path)
    return HIGH_IMPACT_PATTERNS.some(p => p.test(params.path));
  if (tool === 'edit_file')      return true;
  if (tool === 'create_file')    return true;
  if (tool === 'apply_patch')    return true;
  if (tool === 'code_execution') return true;
  return false;
}

// ── IDs ───────────────────────────────────────────────────────────────────────
let _planCounter = 0, _stepCounter = 0;
function planId() { return `plan_${Date.now()}_${++_planCounter}`; }
function stepId() { return `step_${Date.now()}_${++_stepCounter}`; }

// ── Helpers de limpieza ───────────────────────────────────────────────────────
function _cleanPath(raw) {
  return (raw || '').trim()
    .replace(/^["'\`]|["'\`]$/g, '')
    .replace(/[.,;:!?]+$/, '');
}

function _cleanCommand(raw) {
  if (!raw) return '';
  let cmd = raw.trim();

  // FIX — el replace anterior `/^["'`]+|["'`]+$/g` quitaba CUALQUIER
  // comilla suelta al inicio o al final, incluso si pertenecía al
  // contenido real del comando (ej. `git commit -m "texto"` termina
  // legítimamente en comilla doble, que es el cierre de -m, no un
  // envoltorio accidental). Eso dejaba el comando con comillas
  // desbalanceadas, y _trimNarrativeOutsideQuotes ya no podía proteger
  // el contenido citado correctamente.
  //
  // Ahora solo se quita el envoltorio si el MISMO carácter de comilla
  // rodea el comando completo en ambos extremos (ej. todo el comando
  // viene entre backticks: `git status`). Si el primer y último
  // carácter no son la misma comilla, se asume que son parte del
  // contenido real y no se tocan.
  if (cmd.length >= 2) {
    const first = cmd[0];
    const last  = cmd[cmd.length - 1];
    if ((first === '`' || first === '"' || first === "'") && first === last) {
      cmd = cmd.slice(1, -1).trim();
    } else if (first === '`') {
      // backtick suelto al inicio sin su par exacto al final — quitar
      // solo backticks sueltos (nunca comillas reales, que sí pueden
      // ser parte del contenido).
      cmd = cmd.replace(/^`+/, '').trim();
    }
  }

  const NARRATIVE_STARTS = [
    /^el\s+comando(?!\s+(?:git|npm|pip|node|python|cd|ls|dir|echo|curl|yarn|npx))\s*/i,
    /^proporcionado\b/i, /^que\s+se\s+/i, /^para\s+/i,
    /^lo\s+siguiente\s*:/i, /^ahora\s+voy\s+/i, /^voy\s+a\s+/i, /^listo\b/i,
  ];
  for (const p of NARRATIVE_STARTS) { if (p.test(cmd)) return ''; }

  // Cortar en el primer salto de línea real ANTES de tocar nada más,
  // y también si aparece otra instrucción "Ejecutar:" pegada en la
  // misma línea (lista multi-comando aplanada). Esto evita que un
  // comando se trague el siguiente cuando vienen varios en una sola
  // respuesta del LLM tipo "Ejecutar: X\nEjecutar: Y\nEjecutar: Z".
  const firstNewline = cmd.search(/\r?\n/);
  if (firstNewline !== -1) cmd = cmd.slice(0, firstNewline);
  cmd = cmd.replace(/\s+ejecutar:\s*.*$/i, '');

  cmd = cmd.replace(/\t+/g, ' ');
  cmd = cmd.replace(/\s{2,}/g, ' ').trim();

  // Las siguientes 3 reglas recortan narrativa que el LLM pudo haber
  // pegado después del comando real ("... . Ahora voy a verificar",
  // "... para asegurar que funciona", "... y ejecutar el siguiente").
  // Se aplican SOLO fuera de comillas — ver _trimNarrativeOutsideQuotes
  // — para no truncar mensajes de commit legítimos que contengan esas
  // mismas palabras dentro de su texto citado (ej. "usando git para
  // versionar").
  cmd = _trimNarrativeOutsideQuotes(cmd);

  cmd = cmd.replace(/[,;:!?]+$/, '').trim();

  cmd = cmd.replace(/`/g, '').trim();

  const doubleQuotes = (cmd.match(/"/g) || []).length;
  if (doubleQuotes % 2 !== 0) cmd = cmd + '"';

  return cmd.length < 2 ? '' : cmd;
}

/**
 * Aplica las reglas de recorte de narrativa residual ("Ahora voy a...",
 * "para verificar...", "y ejecutar...") únicamente sobre los tramos de
 * `cmd` que están FUERA de comillas dobles o simples. Los tramos entre
 * comillas se preservan exactamente como están, sin importar qué
 * palabras contengan — porque ahí vive contenido literal del usuario
 * (mensajes de commit, texto a escribir en un archivo, etc.), no
 * narrativa generada por el LLM que haya que limpiar.
 *
 * Estrategia: dividir `cmd` en tramos alternando "fuera de comillas" /
 * "dentro de comillas" (igual que parseArgs en mock-openclaw.js, pero
 * sin tokenizar — aquí solo se necesita saber qué partes proteger).
 * Las reglas de recorte se aplican solo a los tramos "fuera".
 */
function _trimNarrativeOutsideQuotes(cmd) {
  const QUOTE_SPLIT = /("[^"]*"|'[^']*')/g;
  const segments = cmd.split(QUOTE_SPLIT).filter(s => s !== undefined);

  const NARRATIVE_TAIL_RULES = [
    /\.\s+[A-ZÁÉÍÓÚ][a-z].*$/,
    /\s+para\s+(?:ver|listar|asegurar|verificar|comprobar|ejecutar).*$/i,
    /\s+y\s+(?:ver|ejecutar|listar).*$/i,
  ];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isQuoted = /^"[^"]*"$/.test(seg) || /^'[^']*'$/.test(seg);
    if (isQuoted) continue; // preservar intacto

    let cleaned = seg;
    for (const rule of NARRATIVE_TAIL_RULES) {
      const before = cleaned;
      cleaned = cleaned.replace(rule, '');
      // Si esta regla cortó algo Y había más segmentos después (un
      // tramo citado más adelante en el comando), detenemos el corte
      // en este segmento — el resto del comando, incluida la siguiente
      // parte citada, ya no debería existir si el LLM realmente quiso
      // terminar la frase aquí. Esto reproduce el comportamiento
      // original para el caso normal (sin comillas de por medio).
      if (cleaned !== before) break;
    }
    segments[i] = cleaned;

    // Si este segmento se vació completamente por el recorte, y NO es
    // el último segmento del comando, detener el procesamiento de los
    // segmentos siguientes — significa que la narrativa cortó el
    // comando real aquí mismo, así que todo lo posterior (aunque sea
    // una porción citada) pertenece a la narrativa descartada, no al
    // comando. Esto solo aplica cuando el corte ocurrió ANTES de la
    // primera comilla real del comando (ej. "ejecuta esto para ver
    // `git status`" — raro, pero se maneja de forma segura).
    if (cleaned.length < seg.length && i < segments.length - 1) {
      // Solo truncar el resto si el segmento quedó vacío Y el corte
      // sucedió real mente — si solo se acortó pero no se vació, no
      // hay ambigüedad y seguimos procesando con normalidad.
      if (cleaned.trim() === '') {
        return segments.slice(0, i + 1).join('').trim();
      }
    }
  }

  return segments.join('').trim();
}

function _isValidCommand(cmd) {
  if (!cmd || cmd.length < 2) return false;

  if (/^(?:los|las|el|la|un|una|esto|estos|estas|lo|le|les|se|su|sus)\s/i.test(cmd)) return false;

  const VALID = [
    /^git\s/i, /^npm\s/i, /^pip3?\s/i, /^node\s/i, /^python\s/i,
    /^cd\s/i,  /^ls\b/i,  /^dir\b/i,   /^echo\b/i, /^cat\s/i,
    /^type\s/i,/^mkdir\s/i,/^cp\s/i,   /^mv\s/i,   /^touch\s/i,
    /^curl\s/i,/^wget\s/i, /^yarn\s/i, /^npx\s/i,  /^electron\b/i,
    /^code\s/i,/^pwsh\b/i, /^where\s/i,/^which\s/i,/^set\s/i, /^export\s/i,
  ];
  if (VALID.some(p => p.test(cmd))) return true;

  if (/&&|\|\||[|>]/.test(cmd)) return true;

  // Solo evaluar palabras narrativas FUERA de comillas, para no
  // rechazar comandos git commit válidos cuyo mensaje contenga
  // palabras como "verificar", "antes", "luego", etc.
  const outsideQuotes = cmd.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  if (/\b(voy|ahora|listo|correcto|asegurarme|verificar|antes|después|durante|luego|entonces|siguientes|comandos|archivos|cambios)\b/i.test(outsideQuotes))
    return false;

  return /^[a-zA-Z0-9_\-./\\]{2,30}(\s|$)/.test(cmd) && cmd.length < 40;
}

function _isValidPath(p) {
  if (!p || p.length === 0) return false;
  return !p.includes(' ') || /\.\w{1,5}$/.test(p);
}

/**
 * Separa un comando git capturado por el regex principal en varios
 * comandos independientes, cuando vienen unidos por "y git" SIN coma
 * (ej. "git commit y git push" capturado como un solo match porque
 * el regex de captura es deliberadamente simple/permisivo).
 *
 * A diferencia de intentarlo con lookaheads dentro del regex (que
 * resultó frágil contra comillas — ver historial de fixes arriba),
 * esto escanea el string carácter por carácter respetando comillas
 * dobles y simples, igual que parseArgs() en mock-openclaw.js. Solo
 * se considera "siguiente comando" la secuencia " y git " cuando
 * aparece FUERA de cualquier comilla abierta — así un mensaje de
 * commit como `git commit -m "usando git para versionar"` nunca se
 * corta, porque el "git" ahí vive dentro de comillas.
 *
 * @param {string} raw — el comando capturado completo (puede tener 1+ comandos git)
 * @returns {string[]} — array de 1 o más comandos git independientes
 */
function _splitChainedGitCommand(raw) {
  if (!raw) return [raw];

  const SPLIT_TOKEN = /\by\s+(?=git\b)/i;
  const parts  = [];
  let current  = '';
  let inDouble = false;
  let inSingle = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; i++; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; i++; continue; }

    if (!inDouble && !inSingle) {
      const rest  = raw.slice(i);
      const match = SPLIT_TOKEN.exec(rest);
      // Solo partir si el "y git" aparece justo en esta posición
      // (match.index === 0), no en cualquier parte más adelante —
      // así no cortamos de más por una coincidencia lejana.
      if (match && match.index === 0) {
        parts.push(current.trim());
        current = '';
        i += match[0].length;
        continue;
      }
    }

    current += ch;
    i++;
  }

  if (current.trim()) parts.push(current.trim());

  return parts.length > 0 ? parts : [raw];
}

// ── Carpetas especiales reconocidas (deben coincidir con mock-openclaw.js) ────
const SPECIAL_FOLDER_WORDS = [
  'descargas', 'downloads',
  'escritorio', 'desktop',
  'documentos', 'documents',
  'imagenes', 'imágenes', 'pictures',
  'musica', 'música', 'music',
  'videos', 'video',
];
const SPECIAL_FOLDER_RE = new RegExp(`\\b(${SPECIAL_FOLDER_WORDS.join('|')})\\b`, 'i');

// Delimitadores de acción — marcan dónde termina la frase de la acción
// actual y probablemente empieza otra acción independiente. Se usan
// SOLO para acotar la ventana de búsqueda semántica de carpeta en
// create_file, nunca para tocar el regex principal de detección de
// acciones (ACTION_PATTERNS), que sigue funcionando como antes.
const ACTION_DELIMITER_RE = /(?:\s*,\s*|\s+y\s+luego\s+|\s+y\s+entonces\s+|\s+luego\s+|\s+despu[eé]s\s+|\s+entonces\s+|\s+y\s+(?!el\s|la\s|los\s|las\s)|;|\.\s|$)/i;

/**
 * FASE SEMÁNTICA SEPARADA para detección de carpeta especial en
 * create_file. No es parte del regex principal — se ejecuta DESPUÉS
 * de que CREATE_FILE_PATTERN ya capturó el nombre de archivo, sobre
 * el fragmento de texto que sigue inmediatamente a ese match.
 *
 * Pasos:
 *   1. Tomar todo el texto que sigue al match del nombre de archivo.
 *   2. Cortar esa porción en el primer delimitador de acción
 *      ("y luego", "después", coma, punto, etc.) — todo lo que esté
 *      después de ese delimitador pertenece a OTRA acción y nunca se
 *      inspecciona.
 *   3. Dentro de esa ventana ya acotada, buscar "en <carpeta>" o
 *      "dentro de <carpeta>".
 *   4. Validar que la palabra capturada sea una carpeta especial
 *      conocida (SPECIAL_FOLDER_RE) — si no lo es, no se asume nada;
 *      el archivo se crea relativo al proyecto como comportamiento
 *      por defecto (compatibilidad hacia atrás total).
 *
 * Esto garantiza que "crea nota.txt en Descargas y luego ábrelo"
 * jamás capture "Descargas y luego ábrelo" como nombre de carpeta —
 * el delimitador "y luego" corta la ventana ANTES de que eso ocurra.
 */
function _detectFolderForCreateFile(fullText, matchEndIndex) {
  const remainder = fullText.slice(matchEndIndex);

  const delimMatch = ACTION_DELIMITER_RE.exec(remainder);
  const windowEnd   = delimMatch ? delimMatch.index : remainder.length;
  const window       = remainder.slice(0, windowEnd);

  const folderMatch = /^\s*(?:en|dentro\s+de)\s+(?:la\s+carpeta\s+|el\s+directorio\s+)?([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/i.exec(window);
  if (!folderMatch) return null;

  const candidate = folderMatch[1];
  if (!SPECIAL_FOLDER_RE.test(candidate)) return null;

  return candidate;
}

/**
 * Combina un nombre de archivo con una carpeta especial detectada,
 * sin duplicar la carpeta si el path ya la incluye.
 */
function _withSpecialFolder(filename, folder) {
  if (!folder) return filename;
  const already = new RegExp(`^${folder}[\\\\/]`, 'i');
  if (already.test(filename)) return filename;
  return `${folder}/${filename}`;
}

// ── Detección de intención de edición ────────────────────────────────────────

const EDIT_VERBS_A =
  '(?:modifica(?:r)?|edita(?:r)?|cambia(?:r)?|inserta(?:r)?|' +
  'añad(?:e|ir)?|agreg(?:a|ar)?|reemplaz(?:a|ar)?|' +
  'actualiza(?:r)?|borra(?:r)?|elimina(?:r)?)';

const EDIT_PATTERN_A = new RegExp(
  EDIT_VERBS_A + '(?:[^\\n]{0,80}?)' +
  '([\\w][\\w./\\\\-]{0,150}\\.\\w{2,10})',
  'i'
);

const WRITE_INTENT_B = /(?:escrib(?:e|ir|o|iendo)|pon(?:er|e|ga|go)|coloca(?:r)?|guarda(?:r)?)\b/i;
const FILE_ANYWHERE  = /\b([\w][\w./\\-]{0,150}\.\w{2,10})\b/g;

function _detectEditIntent(text) {
  const mA = EDIT_PATTERN_A.exec(text);
  if (mA) {
    const p = _cleanPath(mA[1]);
    if (_isValidPath(p)) return { path: p, strategy: 'A', match: mA[0] };
  }

  if (WRITE_INTENT_B.test(text)) {
    FILE_ANYWHERE.lastIndex = 0;
    let fm;
    while ((fm = FILE_ANYWHERE.exec(text)) !== null) {
      const p = _cleanPath(fm[1]);
      if (_isValidPath(p)) return { path: p, strategy: 'B', match: text };
    }
  }

  return null;
}

// ── ActionParser ──────────────────────────────────────────────────────────────

const ACTION_PATTERNS = [
  // git — multi: true permite detectar VARIOS comandos git en una sola
  // respuesta (ej. "git status, git add, git commit y git push"). Sin
  // esto, solo se planeaba el primer comando y el resto se perdía.
  // Requiere flag global (g) para que el while en parse() encuentre
  // todas las repeticiones, no solo la primera.
  //
  // El regex de captura en sí es deliberadamente simple — igual de
  // permisivo que en v7 — porque intentar resolver "dónde empieza el
  // siguiente comando" dentro del propio regex (con lookaheads) resultó
  // frágil contra comandos con comillas (ej. mensajes de commit que
  // contienen la palabra "git"). En su lugar, la separación de comandos
  // unidos por "y" sin coma se resuelve en _splitChainedGitCommand(),
  // una fase de post-procesamiento simple sobre el texto ya capturado,
  // que SÍ respeta comillas correctamente porque opera línea por línea
  // en vez de con lookaheads regex anidados.
  {
    pattern: /\b(git\s+(?:add|commit|push|pull|status|log|diff|branch|checkout|merge|stash|clone|init|remote|fetch|reset|rebase)(?:\s+[^\n,;]{1,200})?)/gi,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(_splitChainedGitCommand(m[1])[0]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(_splitChainedGitCommand(m[1])[0])}`,
    validate: (m) => _isValidCommand(_cleanCommand(_splitChainedGitCommand(m[1])[0])),
    multi: true,
    // postMatches: si el match capturado en realidad contiene MÁS de un
    // comando git unido por "y" (sin coma), genera acciones adicionales
    // para los comandos sobrantes. Ver _splitChainedGitCommand más abajo.
    postMatches: (m) => _splitChainedGitCommand(m[1]).slice(1),
  },

  // npm / pip / yarn
  {
    pattern: /\b((?:npm|pip|pip3|yarn|npx)\s+(?:install|uninstall|run|start|build|test|update|init)[^\n]{0,80})/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },

  // exec genérico — requiere backticks para evitar capturar narrativa libre
  {
    pattern: /(?:ejecuta(?:r|ndo)?|corre(?:r)?|lanza(?:r)?)\s+(?:el\s+comando\s+)?[:\-]?\s*`([^`\n]{2,120})`/i,
    tool: 'exec',
    buildParams: (m) => ({ command: _cleanCommand(m[1]), cwd: PROJECT_CWD }),
    description: (m) => `Ejecutar: ${_cleanCommand(m[1])}`,
    validate: (m) => _isValidCommand(_cleanCommand(m[1])),
  },

  // leer archivo
  {
    pattern: /(?:lee(?:r)?|abrir?|mostrar?)\s+(?:el\s+)?archivo\s*[:\-]?\s*`?([^\s`\n]{2,200})`?/i,
    tool: 'read',
    buildParams: (m) => ({ path: _cleanPath(m[1]) }),
    description: (m) => `Leer archivo: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },

  // crear archivo nuevo — REGEX PRINCIPAL SIN CAMBIOS respecto a v7:
  // exige extensión real, permite "llamado"/"named" como relleno
  // opcional. El grupo de captura del nombre de archivo es idéntico
  // al original; la detección de carpeta especial ("en Descargas",
  // "dentro de Escritorio") ocurre en _detectFolderForCreateFile,
  // una FASE SEMÁNTICA SEPARADA que se ejecuta sobre el fragmento ya
  // aislado por este mismo match, nunca ampliando este regex.
  {
    pattern: /crea(?:r)?\s+(?:un\s+)?(?:nuevo\s+)?(?:archivo|fichero)(?:\s+llamado|\s+named)?\s*[:\-]?\s*`?([\w./\\-]+\.\w{1,10})`?/i,
    tool: 'create_file',
    buildParams: (m, fullText) => {
      const filename  = _cleanPath(m[1]);
      const matchEnd   = m.index + m[0].length;
      const folder     = _detectFolderForCreateFile(fullText, matchEnd);
      const fullPath   = _withSpecialFolder(filename, folder);
      return { path: fullPath, instruction: fullText };
    },
    description: (m, fullText) => {
      const filename = _cleanPath(m[1]);
      const matchEnd  = m.index + m[0].length;
      const folder    = _detectFolderForCreateFile(fullText, matchEnd);
      return `Crear archivo: ${_withSpecialFolder(filename, folder)}`;
    },
    validate: (m) => _isValidPath(_cleanPath(m[1])),
  },

  // code_execution — ejecutar código Python con backticks
  {
    pattern: /(?:ejecuta(?:r)?|corre(?:r)?)\s+(?:este\s+|el\s+)?c[oó]digo(?:\s+python)?\s*[:\-]?\s*`([^`\n]{2,2000})`/i,
    tool: 'code_execution',
    buildParams: (m) => ({ code: m[1] }),
    description: () => `Ejecutar código Python`,
    validate: (m) => m[1] && m[1].trim().length > 0,
  },

  // apply_patch — aplicar parche unified diff a un archivo
  {
    pattern: /aplica(?:r)?\s+(?:este\s+|el\s+)?patch\s+a\s+([\w./\\-]+\.\w{1,10})\s*[:\-]?\s*```([\s\S]{2,5000}?)```/i,
    tool: 'apply_patch',
    buildParams: (m) => ({ path: _cleanPath(m[1]), patch: m[2] }),
    description: (m) => `Aplicar patch a: ${_cleanPath(m[1])}`,
    validate: (m) => _isValidPath(_cleanPath(m[1])) && m[2] && m[2].trim().length > 0,
  },

  // web_search — búsqueda real
  {
    pattern: /(?:busca(?:r|me)?\s+en\s+(?:la\s+)?(?:web|internet|google)|voy\s+a\s+buscar\s+en\s+(?:la\s+)?web)\s*[:\-]?\s*(.+?)(?:\.|$)/i,
    tool: 'web_search',
    buildParams: (m) => ({ query: m[1].trim() }),
    description: (m) => `Buscar en la web: "${m[1].trim()}"`,
  },

  // navegar URL
  {
    pattern: /(?:navega(?:r)?\s+a|abre?\s+en\s+(?:el\s+)?navegador|visita(?:r)?)\s*[:\-]?\s*(https?:\/\/[^\s\n]{2,300})/i,
    tool: 'browser',
    buildParams: (m) => ({ action: 'navigate', url: m[1].trim() }),
    description: (m) => `Navegar a: ${m[1].trim()}`,
  },
];

class ActionParser {
  static parse(llmResponse, userGoal) {
    const actions = [];
    const seen    = new Set();
    const text    = llmResponse || '';

    const editSource = userGoal || text;
    const editIntent = _detectEditIntent(editSource);

    if (editIntent) {
      const key = `edit_file:${editIntent.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        actions.push({
          tool:        'edit_file',
          params:      { path: editIntent.path, instruction: editSource },
          description: `Editar archivo: ${editIntent.path}`,
          rawMatch:    editIntent.match,
        });
      }
    }

    for (const { pattern, tool, buildParams, description, validate, multi, postMatches } of ACTION_PATTERNS) {
      const sourceText = (tool === 'create_file' && userGoal) ? userGoal : text;

      let match;
      const re = new RegExp(pattern.source, pattern.flags);
      while ((match = re.exec(sourceText)) !== null) {
        if (validate && !validate(match)) {
          if (multi) continue;
          break;
        }
        try {
          const params = buildParams(match, sourceText);
          if (tool === 'exec' && (!params.command || params.command.trim().length < 2)) {
            if (multi) continue;
            break;
          }

          const key = `${tool}:${params.command || params.path || params.query || ''}`;
          if (seen.has(key)) {
            if (multi) continue;
            break;
          }
          seen.add(key);

          actions.push({ tool, params, description: description(match, sourceText), rawMatch: match[0] });

          // postMatches: el match capturado puede contener varios
          // comandos encadenados (ej. "git commit y git push" detectado
          // como un solo bloque por el regex principal, deliberadamente
          // simple). Aquí se expanden los comandos sobrantes como
          // acciones independientes adicionales, en el mismo orden en
          // que aparecen en el texto original.
          if (postMatches) {
            const extras = postMatches(match, sourceText) || [];
            for (const rawExtra of extras) {
              const extraCmd = _cleanCommand(rawExtra);
              if (!extraCmd || extraCmd.trim().length < 2) continue;
              if (!_isValidCommand(extraCmd)) continue;

              const extraKey = `${tool}:${extraCmd}`;
              if (seen.has(extraKey)) continue;
              seen.add(extraKey);

              actions.push({
                tool,
                params:      { command: extraCmd, cwd: PROJECT_CWD },
                description: `Ejecutar: ${extraCmd}`,
                rawMatch:    rawExtra,
              });
            }
          }
        } catch (e) {
          console.warn('[action-parser] error:', e.message);
        }
        if (!multi) break;
      }
    }

    return actions;
  }
}

// ── Planner ───────────────────────────────────────────────────────────────────

class Planner {
  constructor() {
    this._bridge      = getOpenClawBridge();
    this._activePlan  = null;
    this._history     = [];
    this._maxHistory  = 50;
  }

  planSingleStep(goal, tool, params, description) {
    const step = {
      id:               stepId(),
      tool,
      params,
      description:      description || `${tool}`,
      requiresApproval: isHighImpact(tool, params),
      dependsOn:        [],
      status:           'pending',
      result:           null,
      error:            null,
    };
    return {
      id: planId(), goal, steps: [step],
      status: 'pending', result: null, error: null,
      created: Date.now(), finished: null,
    };
  }

  planMultiStep(goal, stepsConfig) {
    const steps = stepsConfig.map(cfg => ({
      id:               stepId(),
      tool:             cfg.tool,
      params:           cfg.params,
      description:      cfg.description || `${cfg.tool}`,
      requiresApproval: isHighImpact(cfg.tool, cfg.params),
      dependsOn:        cfg.dependsOn || [],
      status:           'pending',
      result:           null,
      error:            null,
    }));
    return {
      id: planId(), goal, steps,
      status: 'pending', result: null, error: null,
      created: Date.now(), finished: null,
    };
  }

  planFromLLMResponse(llmResponse, userGoal) {
    const actions = ActionParser.parse(llmResponse, userGoal);
    if (!actions.length) return null;
    if (actions.length === 1) {
      const { tool, params, description } = actions[0];
      return this.planSingleStep(userGoal, tool, params, description);
    }
    return this.planMultiStep(userGoal, actions);
  }

  async execute(plan, opts = {}) {
    if (this._activePlan) {
      console.warn('[planner] ya hay un plan activo, rechazando:', plan.id);
      return { ...plan, status: 'failed', error: 'Otro plan está en ejecución' };
    }

    plan.status      = 'running';
    this._activePlan = plan;
    const stepResults = {};

    for (const step of plan.steps) {
      const blocked = step.dependsOn.find(id => {
        const dep = plan.steps.find(s => s.id === id);
        return dep && dep.status !== 'done';
      });
      if (blocked) {
        step.status = 'skipped';
        step.error  = `Dependencia ${blocked} no completada`;
        opts.onStepDone?.(step, null);
        continue;
      }

      const resolvedParams = this._resolveParams(step.params, stepResults);
      opts.onStepStart?.(step);
      step.status = 'running';

      if (step.requiresApproval) {
        const approved = opts.onApprovalNeeded
          ? await opts.onApprovalNeeded(step)
          : false;
        if (!approved) {
          step.status = 'skipped';
          step.error  = 'Cancelado por el usuario';
          opts.onStepDone?.(step, null);
          continue;
        }
      }

      console.log(`[planner] ejecutando paso: ${step.description}`);

      let res;
      try {
        res = await this._executeStep(step.tool, resolvedParams);
      } catch (e) {
        res = { ok: false, error: e.message, result: null, tool: step.tool, elapsed: 0 };
      }

      if (!res.ok) {
        step.status = 'failed';
        step.error  = res.error;
        step.result = res.result || null;
        opts.onStepDone?.(step, null);

        plan.status   = 'failed';
        plan.error    = `"${step.description}" falló: ${res.error}`;
        plan.finished = Date.now();
        this._activePlan = null;
        this._archivePlan(plan);
        return plan;
      }

      step.status  = 'done';
      step.result  = res.result;
      stepResults[step.id] = res.result;
      opts.onStepDone?.(step, res.result);
    }

    const anyFailed = plan.steps.some(s => s.status === 'failed');
    plan.status   = anyFailed ? 'failed' : 'done';
    plan.result   = this._aggregateResults(plan.steps);
    plan.finished = Date.now();
    this._activePlan = null;
    this._archivePlan(plan);

    console.log(`[planner] plan ${plan.id} → ${plan.status}`);
    return plan;
  }

  async _executeStep(tool, params) {
    if (tool === 'edit_file')   return this._executeEditFile(params);
    if (tool === 'create_file') return this._executeCreateFile(params);
    return this._bridge.execute(tool, params);
  }

  async _executeEditFile({ path: filePath, instruction }) {
    const start = Date.now();

    console.log(`[planner] paso 1: Leer ${filePath}`);
    const readResult = await this._bridge.execute('read', { path: filePath });

    if (!readResult.ok) {
      return {
        ok:      false,
        error:   `No se pudo leer "${filePath}": ${readResult.error}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    const originalContent = typeof readResult.result === 'string'
      ? readResult.result
      : JSON.stringify(readResult.result);

    console.log(`[planner] paso 2: Generar contenido actualizado para ${filePath}`);
    let newContent;
    try {
      newContent = await _llmTransform(originalContent, instruction, filePath);
    } catch (e) {
      return {
        ok:      false,
        error:   `Error al transformar "${filePath}": ${e.message}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    console.log(`[planner] paso 3: Escribir ${filePath}`);
    const writeResult = await this._bridge.execute('write', {
      path:    filePath,
      content: newContent,
    });

    if (!writeResult.ok) {
      return {
        ok:      false,
        error:   `No se pudo escribir "${filePath}": ${writeResult.error}`,
        result:  null,
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    console.log(`[planner] paso 4: Verificar escritura de ${filePath}`);
    const verifyResult = await this._bridge.execute('read', { path: filePath });

    if (!verifyResult.ok) {
      return {
        ok:     true,
        result: {
          status:  'written_unverified',
          path:    filePath,
          newContent,
          warning: `Archivo escrito pero no verificado: ${verifyResult.error}`,
        },
        tool:    'edit_file',
        elapsed: Date.now() - start,
      };
    }

    const verifiedContent = typeof verifyResult.result === 'string'
      ? verifyResult.result
      : JSON.stringify(verifyResult.result);

    console.log(`[planner] plan completado — ${filePath} modificado correctamente`);

    return {
      ok:     true,
      result: {
        status:          'success',
        path:            filePath,
        originalContent,
        newContent,
        verifiedContent,
        verified:        verifiedContent === newContent,
      },
      tool:    'edit_file',
      elapsed: Date.now() - start,
    };
  }

  async _executeCreateFile({ path: filePath, instruction }) {
    const start = Date.now();

    console.log(`[planner] paso 1: Generar contenido para ${filePath}`);

    const complete = _getLLMComplete();
    const systemPrompt = [
      'Eres un generador de archivos de texto.',
      'Recibirás una instrucción que describe qué archivo crear y con qué contenido.',
      'Devuelve ÚNICAMENTE el contenido que debe tener el archivo nuevo.',
      'Sin explicaciones, sin bloques markdown (no uses ```), sin comentarios.',
      'Si la instrucción incluye texto literal a escribir, usa exactamente ese texto.',
    ].join(' ');

    const userMessage = [
      `Archivo a crear: ${filePath}`,
      '',
      `Instrucción: ${instruction}`,
      '',
      'Devuelve el contenido completo del archivo nuevo.',
    ].join('\n');

    let content;
    try {
      content = await complete([{ role: 'user', content: userMessage }], systemPrompt);
    } catch (e) {
      return {
        ok:      false,
        error:   `Error generando contenido para "${filePath}": ${e.message}`,
        result:  null,
        tool:    'create_file',
        elapsed: Date.now() - start,
      };
    }

    if (!content || !content.trim()) {
      return {
        ok:      false,
        error:   'El LLM devolvió contenido vacío.',
        result:  null,
        tool:    'create_file',
        elapsed: Date.now() - start,
      };
    }

    console.log(`[planner] paso 2: Escribir ${filePath}`);
    const writeResult = await this._bridge.execute('write', { path: filePath, content });

    if (!writeResult.ok) {
      return {
        ok:      false,
        error:   `No se pudo escribir "${filePath}": ${writeResult.error}`,
        result:  null,
        tool:    'create_file',
        elapsed: Date.now() - start,
      };
    }

    console.log(`[planner] paso 3: Verificar ${filePath}`);
    const verifyResult = await this._bridge.execute('read', { path: filePath });

    const verified = verifyResult.ok && verifyResult.result === content;

    console.log(`[planner] plan completado — ${filePath} creado correctamente`);

    return {
      ok:     true,
      result: { status: 'success', path: filePath, content, verified },
      tool:    'create_file',
      elapsed: Date.now() - start,
    };
  }

  cancel() {
    if (!this._activePlan) return;
    this._activePlan.status   = 'cancelled';
    this._activePlan.finished = Date.now();
    this._archivePlan(this._activePlan);
    this._activePlan = null;
  }

  _resolveParams(params, stepResults) {
    const resolved = { ...params };
    for (const [key, val] of Object.entries(resolved)) {
      if (typeof val === 'string' && val.startsWith('$')) {
        const refId = val.slice(1);
        if (stepResults[refId] !== undefined) resolved[key] = stepResults[refId];
      }
    }
    return resolved;
  }

  _aggregateResults(steps) {
    const doneSteps = steps.filter(s => s.status === 'done' && s.result != null);
    if (doneSteps.length === 0) return null;
    if (doneSteps.length === 1) return doneSteps[0].result;
    const results = {};
    for (const s of doneSteps) results[s.description] = s.result;
    return results;
  }

  _archivePlan(plan) {
    this._history.push(plan);
    if (this._history.length > this._maxHistory) this._history.shift();
  }

  getStats() {
    return {
      total:     this._history.length,
      done:      this._history.filter(p => p.status === 'done').length,
      failed:    this._history.filter(p => p.status === 'failed').length,
      cancelled: this._history.filter(p => p.status === 'cancelled').length,
      active:    this._activePlan?.id ?? null,
      bridge:    this._bridge.getStats(),
    };
  }

  getHistory(n = 10) {
    return this._history.slice(-n).map(p => ({
      id:      p.id,
      goal:    p.goal,
      status:  p.status,
      steps:   p.steps.length,
      elapsed: p.finished ? p.finished - p.created : null,
      result:  typeof p.result === 'string' ? p.result.slice(0, 200) : p.result,
      error:   p.error,
    }));
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────
let _plannerInstance = null;
function getPlanner() {
  if (!_plannerInstance) _plannerInstance = new Planner();
  return _plannerInstance;
}

module.exports = {
  _debug_cleanCommand: _cleanCommand,
  _debug_trimNarrative: _trimNarrativeOutsideQuotes,
  _debug_splitChained: _splitChainedGitCommand,
  Planner,
  ActionParser,
  getPlanner,
  isHighImpact,
  setProjectCWD,
  setLLMProvider,
};