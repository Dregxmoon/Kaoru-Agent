'use strict';

const path = require('path');

const DOMAINS = {
  CODE: { id: 'code', label: 'Código y programación' },
  FILESYSTEM: { id: 'filesystem', label: 'Archivos y directorios' },
  GIT: { id: 'git', label: 'Control de versiones (Git)' },
  SHELL: { id: 'shell', label: 'Comandos de terminal' },
  WEB: { id: 'web', label: 'Navegación y búsqueda web' },
  SYSTEM: { id: 'system', label: 'Sistema operativo' },
  MULTIMEDIA: { id: 'multimedia', label: 'Multimedia (imagen, video, audio)' },
  MCP: { id: 'mcp', label: 'Herramientas MCP externas' },
  PACKAGE: { id: 'package', label: 'Gestión de paquetes' },
  DOCKER: { id: 'docker', label: 'Contenedores Docker' },
  NETWORK: { id: 'network', label: 'Red y conectividad' },
  DATA: { id: 'data', label: 'Datos y archivos de datos' },
};

const ART = '(un|una|el|la|este|esta|los|las)';

const TASK_PATTERNS = [
  {
    domain: DOMAINS.CODE,
    weight: 10,
    patterns: [
      /escrib(e|ir|o|ió)\s+(un|el|este|un)\s+(código|script|función|programa|algoritmo|clase|método)/i,
      new RegExp(
        'crea(r|)\\s+' +
          ART +
          '\\s+(código|script|función|programa|clase|plugin|módulo|api|endpoint)',
        'i'
      ),
      new RegExp(
        'implementa(r|)\\s+' +
          ART +
          '\\s+(funció|clase|método|algoritmo|api|endpoint|lógica|integración)',
        'i'
      ),
      new RegExp(
        'refactoriza(r|)\\s+' + ART + '\\s+(código|función|clase|módulo|archivo|componente)',
        'i'
      ),
      new RegExp('programa(r|)\\s+' + ART + '\\s+(funció|script|algoritmo|solución|programa)', 'i'),
      /traduce\s+(este|el)\s+(código|script|programa|función)\s+(a|de)/i,
      /convierte\s+(este|el)\s+(código|script)\s+(a|de)/i,
      /optimiza(r|)\s+(el|la|este)\s+(código|función|consulta|algoritmo|rendimiento)/i,
      new RegExp(
        'añade\\s+' + ART + '\\s+(funció|característica|feature|línea|lógica|validación)',
        'i'
      ),
      new RegExp(
        'agrega\\s+' + ART + '\\s+(funció|característica|feature|línea|lógica|validación)',
        'i'
      ),
      new RegExp('modifica\\s+' + ART + '\\s+(código|función|clase|comportamiento|lógica)', 'i'),
      new RegExp('actualiza\\s+' + ART + '\\s+(código|función|clase|script|versión)', 'i'),
      new RegExp(
        '(dame|da\\s*me|pasa\\s*me|muestra)\\s+(el|un)\\s+(c[oó]digo|script|programa)',
        'i'
      ),
    ],
  },
  {
    domain: DOMAINS.FILESYSTEM,
    weight: 9,
    patterns: [
      new RegExp('crea(r|)\\s+' + ART + '\\s+(archivo|fichero|documento|carpeta|directorio)', 'i'),
      new RegExp(
        '(lee|leer|abr(e|ir)|mostrar|muestra|muéstrame?)\\s+' +
          ART +
          '\\s+(archivo|fichero|documento)',
        'i'
      ),
      new RegExp(
        '(escribe|escribir|guarda|guardar|salva)\\s+(en\\s+)?' + ART + '\\s+(archivo|fichero)',
        'i'
      ),
      new RegExp('elimina(r|)\\s+' + ART + '\\s+(archivo|fichero|carpeta|directorio)', 'i'),
      new RegExp('borra(r|)\\s+' + ART + '\\s+(archivo|fichero|carpeta|directorio)', 'i'),
      new RegExp('mueve(r|)\\s+' + ART + '\\s+(archivo|fichero|carpeta)\\s+(a|hacia)', 'i'),
      new RegExp('copia(r|)\\s+' + ART + '\\s+(archivo|fichero|carpeta)\\s+(a|hacia)', 'i'),
      new RegExp('renombra(r|)\\s+' + ART + '\\s+(archivo|fichero|carpeta)', 'i'),
      /lista(r|)\s+(los|el|un|el|los)\s+(archivos|directorio|carpeta|contenido|archivo)/i,
      /busca(r|)\s+(un|el|este|archivos?|un)\s+(archivo|fichero)/i,
      /encuentra(r|)\s+(un|el|este)\s+(archivo|fichero)/i,
      /dond[eé]\s+est[áa]\s+(el|ese|un)\s+(archivo|fichero)/i,
    ],
  },
  {
    domain: DOMAINS.GIT,
    weight: 10,
    patterns: [
      /git\s+(init|clone|add|commit|push|pull|fetch|merge|rebase|branch|checkout|stash|log|diff|status|reset|revert|tag|cherry|remote)/i,
      /haz\s+(un|el)\s+(commit|push|pull|merge|rebase)/i,
      /hacer\s+(un|el)\s+(commit|push|pull|merge|rebase)/i,
      /sube\s+(el|los|mis)\s+(código|cambios|archivos?)\s+(a|al|en)/i,
      /subir\s+(el|los|mis)\s+(código|cambios|archivos?)\s+(a|al|en)/i,
      /crea\s+(una|un)\s+(rama|branch|pull request|pr)/i,
      /crear\s+(una|un)\s+(rama|branch|pull request|pr)/i,
      /fusi[oó]n(a|ar)\s+(rama|branch)/i,
      /conflicto(s|)\s+(de|en)\s+(merge|fusión)/i,
      /deshaz\s+(el|un|último)\s+(commit|cambio)/i,
      /revisa\s+(el|los|mis)\s+(historial|log|commits|cambios|diff)/i,
      /baja(r|)\s+(el|un|este)\s+(repo|repositorio|proyecto)/i,
      /clona(r|)\s+(el|un|este)\s+(repo|repositorio|proyecto)/i,
      /github/i,
    ],
  },
  {
    domain: DOMAINS.SHELL,
    weight: 8,
    patterns: [
      new RegExp('ejecuta(r|)\\s+' + ART + '\\s+(comando|script|orden|programa)', 'i'),
      new RegExp('corre(r|)\\s+' + ART + '\\s+(comando|script|orden|programa)', 'i'),
      new RegExp('(corre|ejecuta|lanza|inicia|arranca|instala|desinstala|compila)\\s+', 'i'),
      /terminal/i,
      /(bash|shell|zsh|sh|cmd|powershell|consola)/i,
      /npm\s+(install|run|start|build|test|publish|init|add|remove|update|audit|lint|format)/i,
      /yarn\s+(install|add|run|start|build|test|publish)/i,
      /pnpm\s+(install|add|run|start|build|test)/i,
      new RegExp('pip\\s+(install|uninstall|freeze|list|show)\\s+', 'i'),
      /^npm\s/i,
      /^yarn\s/i,
      /^pip\s/i,
      /^pnpm\s/i,
      /^npx\s/i,
      /^cargo\s/i,
      /^make\s/i,
      /^cmake\s/i,
      /instala(r|)\s+(un|el|la|una)\s+(paquete|dependencia|librería|biblioteca|módulo|aplicación)/i,
      /instala(r|)\s+\w+\s+(con|via|usando|desde)\s+(npm|pip|yarn|pnpm|apt|brew|choco|pacman|dnf)/i,
      /(npm|yarn|pnpm|pip)\s+install\s+\w+/i,
    ],
  },
  {
    domain: DOMAINS.WEB,
    weight: 7,
    patterns: [
      /busca\s+(en\s+)?(internet|la web|google|bing|duckduckgo|información)/i,
      /búsca(me|)\s+(en\s+)?(internet|la web|google|bing)/i,
      /investiga\s+(sobre|acerca de|qué es|quién es)/i,
      /(abre|navega|ve|visita)\s+(a|a la|al|el|la|la página|el sitio|la url|el enlace)\s+/i,
      /ábreme\s+(la|el|la página|el sitio)\s+/i,
      /bájame\s+(de|desde)\s+(internet|la web|esta url|este enlace)/i,
      /descarga\s+(de|desde)\s+(internet|la web|esta url|este enlace)/i,
      /scrape(a|r)\s+(la|esta|esa)\s+(p[áa]gina|web|url|p[áa]gina web)/i,
      /qué\s+(hay|pasa|se dice)\s+(en|de|sobre)\s+(internet|la web|las noticias)/i,
      /noticias\s+(de|sobre|acerca de|recientes|hoy)/i,
      /tráeme\s+(información|datos|resultados|noticias)\s+(de|sobre|acerca de)/i,
    ],
  },
  {
    domain: DOMAINS.SYSTEM,
    weight: 7,
    patterns: [
      /(qué|qué\s+procesos|muestra|lista|muéstrame)\s+(los|las|el|la|al|)\s*(procesos|servicios|aplicaciones)/i,
      /(cuánta|qué\s+tanta|muestra|revisa|muéstrame)\s+(de|la|el|)\s*(memoria|ram|cpu|disco|procesador|almacenamiento)/i,
      /apaga\s+(el|la|este)\s+(computador|pc|ordenador|sistema|equipo)/i,
      /reinicia\s+(el|la|este)\s+(computador|pc|ordenador|sistema|equipo)/i,
      /cierra\s+(el|la|este)\s+(programa|aplicación|ventana|proceso|navegador|explorador|terminal)/i,
      /abre\s+(el|la|este)\s+(programa|aplicación|ventana|configuración|panel|navegador|terminal)/i,
      /configura\s+(el|la|las|los)\s+(sistema|red|wifi|bluetooth|pantalla|sonido|teclado)/i,
      /variables?\s+de\s+entorno/i,
      /(path|ruta)\s+del\s+sistema/i,
      /variables?\s+de\s+(entorno|sistema|configuración)/i,
      /qu[eé]\s+(tan|tanta)\s+(grande|rápido|potente|veloz|capacidad)\s+(es|tiene)\s+(mi|la|el)\s+/i,
    ],
  },
  {
    domain: DOMAINS.PACKAGE,
    weight: 8,
    patterns: [
      /instala\s+(el|la|un|una|este|esta)\s+(paquete|librería|dependencia|biblioteca|módulo)/i,
      /instalar\s+(el|la|un|una|este|esta)\s+(paquete|librería|dependencia|biblioteca|módulo)/i,
      /desinstala\s+(el|la|un|una|este|esta)\s+(paquete|librería|dependencia|biblioteca|módulo)/i,
      /actualiza\s+(el|la|los|las)\s+(paquete|dependencia|librería)/i,
      /agrega\s+(el|la|una|un)\s+(paquete|dependencia|librería)/i,
      /npm\s+(install|add)\s+[\w@/\-.]/i,
      /pip\s+install\s+[\w\-.]/i,
      /yarn\s+add\s+[\w@/\-.]/i,
      /package\.json/i,
      /requirements\.txt/i,
      /gemfile/i,
      /cargo\.toml/i,
    ],
  },
  {
    domain: DOMAINS.DOCKER,
    weight: 8,
    patterns: [
      /docker\s+(run|build|pull|push|compose|ps|exec|logs|stop|start|restart|rm|images|volume|network)/i,
      /docker-compose/i,
      /contenedor(es)?\s+(de|en)\s+docker/i,
      /imagen\s+(de\s+)?docker/i,
      /dockerfile/i,
      /docker\s+(build|compose|container)/i,
      /levanta\s+(los\s+)?(contenedores|servicios|docker)/i,
      /construye\s+(la\s+)?(imagen|contenedor)\s+docker/i,
      /docker.*(imagen|contenedor|servicio|volumen|red)/i,
    ],
  },
  {
    domain: DOMAINS.MULTIMEDIA,
    weight: 5,
    patterns: [
      /convierte\s+(este|el|la|un|una)\s+(archivo|imagen|video|audio|música|canción)\s+(a|de)/i,
      /conversi[oó]n\s+(de|del|de la)\s+(imagen|video|audio|formato)/i,
      /(redimensiona|cambia\s+el\s+tamaño|escala|reduce)\s+(la|esta|el)\s+(imagen|foto)/i,
      /(edita|recorta|rota|voltea)\s+(la|esta|el|este)\s+(imagen|foto)/i,
      /(extrae|saca)\s+(el|la|los|las)\s+(audio|sonido|pista)\s+(de|del)/i,
      /cambia\s+el\s+(formato|codec|bitrate|resolución|fps)\s+(de|del|al)/i,
      /comprime\s+(la|el|este|esta)\s+(imagen|video|audio|archivo)/i,
      /miniaturas?\s+(de|para|desde)\s+/i,
    ],
  },
  {
    domain: DOMAINS.MCP,
    weight: 6,
    patterns: [
      /(usa|utiliza|conecta|llama)\s+(una|la|el)\s+(herramienta|tool|servicio)\s+(mcp|extern)/i,
      /mcp/i,
      /model\s+context\s+protocol/i,
      /herramientas?\s+(mcp|externas|disponibles)/i,
      /servidores?\s+(mcp|externos)/i,
    ],
  },
  {
    domain: DOMAINS.DATA,
    weight: 6,
    patterns: [
      /(parsea|parse|analiza|procesa)\s+(este|el|un|archivo|documento|json|xml|csv|yaml|datos)/i,
      /transforma\s+(estos|los|este)\s+(datos|archivo|información)\s+(a|en|de)/i,
      /convierte\s+(este|el)\s+(json|csv|xml|yaml|tsv)\s+(a|en)/i,
      /base\s+de\s+datos/i,
      /(sql|query|consulta)\s+(para|a|en|de)\s+(la|una)\s+(base|bd|db|tabla)/i,
      /(exporta|importa|migra)\s+(los|estos|las|datos|información|registros)/i,
      /limpia\s+(los|estos|las)\s+(datos|información|registros|csv)/i,
      /genera\s+(un|unos|datos|informe|reporte|report|resumen)\s+(de|con|a\s+partir)/i,
    ],
  },
];

const GREETING_PATTERNS = [
  /^(hola|buenas|buen[ao]s|hey|ey|saludos|qué tal|qué onda|qué hay|hello|hi)\b/i,
  /^(buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)/i,
  /^(cómo\s+est[áa]s|cómo\s+te\s+va|qui[ée]n\s+eres|qu[eé]\s+eres|qu[eé]\s+haces)/i,
  /^(presentate|pres[eé]ntate|qui[ée]n\s+te\s+cre[oó])/i,
  /^gracias\s*$/i,
  /^ok\s*$/i,
  /^vale\s*$/i,
  /^si\s*$/i,
  /^no\s*$/i,
];

const IDENTITY_QUESTION_PATTERNS = [
  /qui[ée]n\s+(eres|soy|es|son|somos)/i,
  /qu[eé]\s+(eres|soy|es|son|somos|haces|puedes)/i,
  /c[óo]mo\s+te\s+llamas/i,
  /cu[aá]l\s+es\s+tu\s+(nombre|propósito|función|rol|identidad)/i,
  /puedes\s+(hacer|ayudar|decirme|contarme)/i,
  /descr[ií]bete|pres[eé]ntate/i,
  /cu[eé]ntame\s+(de|sobre)\s+ti/i,
  /qu[eé]\s+tipo\s+de\s+(asistente|ia|inteligencia|sistema)\s+eres/i,
  /est[aá]s?\s+(ah[ií]|listo|disponible|conectado)/i,
  /(eres|ser[aá]s)\s+como\s+/i,
];

const SIMPLE_CONFIRMATIONS = new Set([
  'si',
  'sí',
  'no',
  'ok',
  'okey',
  'okay',
  'vale',
  'dale',
  'de acuerdo',
  'claro',
  'yes',
  'yep',
  'nope',
  'nah',
  'thanks',
  'gracias',
]);

function _normalize(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function _isGreetingOrIdentity(text) {
  const normalized = _normalize(text);

  if (SIMPLE_CONFIRMATIONS.has(normalized.toLowerCase())) {
    return true;
  }

  for (const p of GREETING_PATTERNS) {
    if (p.test(normalized)) return true;
  }

  for (const p of IDENTITY_QUESTION_PATTERNS) {
    if (p.test(normalized)) return true;
  }

  const lower = normalized.toLowerCase();
  if (lower.length < 8 && !/[áéíóúñü]/.test(lower)) {
    const actionWords = [
      'crea',
      'haz',
      'busca',
      'abre',
      'ejecuta',
      'lee',
      'escribe',
      'instala',
      'configura',
      'modifica',
      'añade',
      'agrega',
      'elimina',
      'borra',
      'mueve',
      'copia',
      'renombra',
      'sube',
      'baja',
      'descarga',
      'convierte',
      'analiza',
      'genera',
      'programa',
      'implementa',
      'refactoriza',
      'traduce',
      'optimiza',
      'actualiza',
      'revisa',
      'investiga',
      'navega',
    ];
    const hasAction = actionWords.some((w) => lower.startsWith(w));
    if (!hasAction) return true;
  }

  return false;
}

function _detectDomainAndGoal(text) {
  const normalized = _normalize(text);

  let bestDomain = null;
  let bestWeight = 0;
  let totalWeight = 0;
  const matchedDomains = [];
  const matches = [];

  for (const category of TASK_PATTERNS) {
    let categoryWeight = 0;
    const categoryMatches = [];

    for (const p of category.patterns) {
      const m = normalized.match(p);
      if (m) {
        const w = category.weight;
        categoryWeight += w;
        categoryMatches.push({ pattern: p.source, match: m[0], weight: w });
      }
    }

    if (categoryWeight > 0) {
      matchedDomains.push({
        domain: category.domain,
        weight: categoryWeight,
        matchCount: categoryMatches.length,
        matches: categoryMatches,
      });
      totalWeight += categoryWeight;

      if (categoryWeight > bestWeight) {
        bestWeight = categoryWeight;
        bestDomain = category.domain;
      }
    }
  }

  if (!bestDomain) return { domain: null, confidence: 'none', goal: null, matchedDomains: [] };

  matchedDomains.sort((a, b) => b.weight - a.weight);

  let confidence;
  if (totalWeight >= 20) confidence = 'high';
  else if (totalWeight >= 10) confidence = 'medium';
  else confidence = 'low';

  let goal = null;
  if (matchedDomains.length > 0) {
    const top = matchedDomains[0];
    const matchExamples = top.matches.slice(0, 3).map((m) => m.match);
    if (matchExamples.length > 0) {
      goal = matchExamples[0].substring(0, 200);
    }
  }

  return {
    domain: bestDomain,
    confidence,
    goal: goal || text.substring(0, 200),
    matchedDomains: matchedDomains.map((d) => ({
      domain: d.domain,
      weight: d.weight,
      matchCount: d.matchCount,
    })),
  };
}

function detect(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { isTask: false, confidence: 'none', domain: null, goal: null, specificity: null };
  }

  const isGreeting = _isGreetingOrIdentity(text);

  if (isGreeting) {
    const result = _detectDomainAndGoal(text);
    if (result.confidence === 'none') {
      return {
        isTask: false,
        confidence: 'none',
        domain: null,
        goal: null,
        specificity: null,
        _debug: { isGreeting: true, matchedDomains: [] },
      };
    }
    if (result.confidence === 'low') {
      return {
        isTask: false,
        confidence: 'low',
        domain: result.domain,
        goal: result.goal,
        specificity: 'vague',
        _debug: { isGreeting: true, matchedDomains: result.matchedDomains },
      };
    }
  }

  const result = _detectDomainAndGoal(text);

  if (result.confidence === 'none') {
    const lower = text.toLowerCase();
    const hasQuestionWord =
      /\b(c[oó]mo|qu[eé]|d[oó]nde|cu[aá]ndo|por qu[eé]|cu[aá]l|qui[eé]n|cu[aá]nt[oa])\b/i.test(
        lower
      );
    const hasDirectAction =
      /^(crea|haz|busca|abre|ejecuta|lee|escribe|instala|configura|modifica|borra|mueve|copia|renombra|sube|baja|descarga|convierte|analiza|genera|programa|necesito|quiero)/i.test(
        lower.trim()
      );
    const hasTaskWord =
      /\b(tarea|trabajo|proyecto|archivo|código|script|programa|comando|función|clase|método|carpeta|directorio|repo|repositorio)\b/i.test(
        lower
      );

    if (hasQuestionWord && hasTaskWord && !hasDirectAction) {
      return {
        isTask: false,
        confidence: 'none',
        domain: null,
        goal: null,
        specificity: null,
        _debug: { interrogativeWithKeyword: true, matchedDomains: [] },
      };
    }

    if (hasTaskWord || hasDirectAction) {
      return {
        isTask: true,
        confidence: 'low',
        domain: null,
        goal: text.substring(0, 200),
        specificity: 'vague',
        _debug: { inferredFrom: 'task_keywords', matchedDomains: [] },
      };
    }

    if (hasQuestionWord) {
      return {
        isTask: false,
        confidence: 'none',
        domain: null,
        goal: null,
        specificity: null,
        _debug: { isQuestion: true, matchedDomains: [] },
      };
    }

    return {
      isTask: false,
      confidence: 'none',
      domain: null,
      goal: null,
      specificity: null,
      _debug: { noMatch: true, matchedDomains: [] },
    };
  }

  const specificity =
    result.matchedDomains.length > 2
      ? 'specific'
      : result.matchedDomains.length > 0
        ? 'vague'
        : null;

  return {
    isTask: true,
    confidence: result.confidence,
    domain: result.domain,
    goal: result.goal,
    specificity,
    _debug: { matchedDomains: result.matchedDomains },
  };
}

module.exports = {
  detect,
  DOMAINS,
  TASK_PATTERNS,
};
