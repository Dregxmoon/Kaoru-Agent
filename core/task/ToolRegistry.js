// @ts-nocheck
'use strict';

const { isMCPToolReadOnly } = require('../planner/ActionParser.js');
const { getSubagentRegistry } = require('../planner/SubagentRegistry.js');

const TOOL_SCHEMAS = [
  {
    id: 'openclaw.exec',
    name: 'exec',
    domain: ['shell', 'system', 'git', 'package', 'docker', 'code'],
    source: 'openclaw',
    description: 'Ejecuta cualquier comando en la terminal del sistema',
    params: [
      { name: 'command', type: 'string', description: 'Comando a ejecutar', required: true },
      { name: 'cwd', type: 'string', description: 'Directorio de trabajo (opcional)' },
      { name: 'timeout', type: 'number', description: 'Timeout en segundos', default: 15 },
      {
        name: 'stdin',
        type: 'string',
        description:
          'Entrada estándar para programas interactivos (readline/prompt-sync). Si el comando pide input del teclado, pásalo aquí en vez de dejar el proceso colgado; si es un programa batch, omítelo.',
      },
      {
        name: 'shell',
        type: 'boolean',
        description:
          'Opcional. El server ya detecta solo la sintaxis de shell (cd, &&, ||, ;, pipes |, redirección >, backgrounding &, $(...) o backticks) y ejecuta vía `sh -c` dentro del sandbox. Mandalo true únicamente si querés forzar shell explícito. false (default) basta para la mayoría de comandos. Si mandás un proceso a background (`cmd > log 2>&1 &`), ese proceso sobrevive a la llamada (p.ej. para levantar un http.server).',
      },
    ],
    examples: [
      { cmd: 'git status', desc: 'Ver estado del repo' },
      { cmd: 'ls -la', desc: 'Listar archivos' },
      { cmd: 'node script.js', desc: 'Ejecutar script' },
      {
        cmd: 'cd src && npm i',
        desc: 'Cambiar de dir y ejecutar en cadena (usa shell: true)',
        shell: true,
      },
      {
        cmd: 'node prompt.js',
        desc: 'Programa interactivo: pasarle el valor en stdin',
        stdin: '5',
      },
    ],
    highImpact: false,
  },
  {
    id: 'openclaw.read',
    name: 'read',
    domain: ['filesystem', 'code', 'data'],
    source: 'openclaw',
    description: 'Lee archivos por rangos de líneas; devuelve next_line para continuar',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      {
        name: 'start_line',
        type: 'number',
        description: 'Línea inicial (base 1)',
        required: false,
      },
      {
        name: 'max_lines',
        type: 'number',
        description: 'Cantidad de líneas (máx. 400)',
        required: false,
      },
    ],
    examples: [
      { cmd: 'README.md', desc: 'Leer README' },
      { cmd: 'src/index.js', desc: 'Leer archivo fuente' },
    ],
    highImpact: false,
  },
  {
    id: 'openclaw.write',
    name: 'write',
    domain: ['filesystem', 'code', 'data'],
    source: 'openclaw',
    description:
      'Escribe o sobreescribe contenido en un archivo (mode "append" para agregar al final en partes)',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'content', type: 'string', description: 'Contenido a escribir', required: true },
      {
        name: 'mode',
        type: 'string',
        description:
          '"write" (default, sobreescribe) | "append" (agrega al final, crea si no existe)',
        default: 'write',
        required: false,
      },
    ],
    examples: [
      { cmd: 'crear index.js con código', desc: 'Crear archivo nuevo' },
      { cmd: 'actualizar config.json', desc: 'Sobreescribir archivo' },
      { cmd: 'escribir un archivo grande en partes con mode append', desc: 'Agregar al final' },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.edit',
    name: 'edit',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Modifica partes específicas de un archivo (reemplazo exacto de texto)',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      {
        name: 'oldString',
        type: 'string',
        description: 'Texto exacto a reemplazar',
        required: true,
      },
      { name: 'newString', type: 'string', description: 'Texto nuevo', required: true },
    ],
    examples: [{ cmd: 'cambiar función X por Y', desc: 'Renombrar función' }],
    highImpact: true,
  },
  {
    id: 'openclaw.apply_patch',
    name: 'apply_patch',
    // 'patch' (no 'filesystem'): el server MCP filesystem NO reemplaza
    // apply_patch (multi-bloque, multi-archivo) y la exclusión por dominio lo
    // sacaba del set cuando ese MCP está activo → el agente perdía el parche
    // nativo y quedaba solo con edit_file por bloques.
    domain: ['patch', 'code'],
    source: 'openclaw',
    description: 'Aplica parches multi-bloque a uno o más archivos',
    params: [
      { name: 'path', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'patch', type: 'string', description: 'Contenido del parche', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.code_execution',
    name: 'code_execution',
    domain: ['code', 'data'],
    source: 'openclaw',
    description: 'Ejecuta código Python',
    params: [
      { name: 'code', type: 'string', description: 'Código Python a ejecutar', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'openclaw.browser',
    name: 'browser',
    domain: ['web'],
    source: 'openclaw',
    description:
      'Controla una sesión web visible o en segundo plano mediante navegación, localizadores semánticos, clic, escritura, teclas y verificación',
    params: [
      {
        name: 'action',
        type: 'string',
        description:
          'navigate, click, type, press, wait_for, get_text, get_url, back, forward, screenshot, snapshot, tabs, new_tab, select_tab, close_tab, select, check, uncheck, hover, scroll, upload, download o dialog',
        default: 'navigate',
      },
      { name: 'mode', type: 'string', description: 'background o managed' },
      { name: 'url', type: 'string', description: 'URL para navegar' },
      { name: 'selector', type: 'string', description: 'Selector CSS opcional' },
      { name: 'role', type: 'string', description: 'Rol accesible del elemento' },
      { name: 'name', type: 'string', description: 'Nombre accesible del elemento' },
      { name: 'text', type: 'string', description: 'Texto visible del elemento' },
      { name: 'label', type: 'string', description: 'Etiqueta accesible del elemento' },
      { name: 'placeholder', type: 'string', description: 'Placeholder visible del campo' },
      { name: 'value', type: 'string', description: 'Texto que se escribirá' },
      { name: 'key', type: 'string', description: 'Tecla que se enviará' },
      { name: 'timeout', type: 'number', description: 'Espera máxima en milisegundos' },
      { name: 'sessionId', type: 'string', description: 'ID de sesión observado' },
      { name: 'pageId', type: 'string', description: 'ID de pestaña observado' },
      { name: 'expectedOrigin', type: 'string', description: 'Origen esperado antes de mutar' },
      { name: 'option', type: 'string', description: 'Opción para select' },
      { name: 'expectedUrl', type: 'string', description: 'URL esperada después del click' },
      { name: 'direction', type: 'string', description: 'Dirección para scroll' },
      { name: 'path', type: 'string', description: 'Archivo/destino dentro del workspace' },
      { name: 'dialogAction', type: 'string', description: 'accept o dismiss' },
    ],
    examples: [{ cmd: 'navegar a github.com', desc: 'Abrir página web' }],
    highImpact: true,
  },
  {
    id: 'desktop.list_apps',
    name: 'list_apps',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description:
      'Lista aplicaciones visibles instaladas para encontrar su nombre exacto. Requiere aprobación por privacidad',
    params: [{ name: 'query', type: 'string', description: 'Filtro opcional por nombre' }],
    highImpact: true,
  },
  {
    id: 'desktop.mission',
    name: 'desktop_mission',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description:
      'Coordina varios resultados de escritorio por aplicaciones, con autorización inicial, observación, verificación y punto de reanudación. Admite peticiones en cualquier idioma.',
    params: [
      { name: 'goal', type: 'string', description: 'Meta completa', required: true },
      {
        name: 'applications',
        type: 'array',
        description: 'Aplicaciones dentro del alcance',
        required: true,
      },
      { name: 'steps', type: 'array', description: 'Resultados y postcondiciones', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.launch_app',
    name: 'launch_app',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description:
      'Abre una aplicación instalada en el escritorio visible. Requiere aprobación del usuario',
    params: [
      {
        name: 'app',
        type: 'string',
        description: 'Nombre exacto o alias de la aplicación',
        required: true,
      },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.open_website',
    name: 'open_website',
    domain: ['desktop', 'web'],
    source: 'desktop',
    description:
      'Abre un sitio HTTPS en el navegador visible del usuario. Admite aliases como drive, youtube o whatsapp',
    params: [
      {
        name: 'target',
        type: 'string',
        description: 'Alias del sitio o URL https completa',
        required: true,
      },
      { name: 'browser', type: 'string', description: 'Navegador opcional permitido' },
      {
        name: 'control',
        type: 'string',
        description: 'external (predeterminado, sesión personal) o managed (aislado y verificable)',
      },
      {
        name: 'needsVerification',
        type: 'boolean',
        description:
          'true cuando hay que leer o comprobar algo dentro de la página; fuerza managed',
      },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.play_media',
    name: 'play_media',
    domain: ['desktop', 'web', 'multimedia'],
    source: 'desktop',
    description:
      'Busca un video en YouTube dentro del navegador visible administrado por Kaoru, pulsa reproducir y verifica el estado real',
    params: [
      {
        name: 'query',
        type: 'string',
        description: 'Video o tema que se debe buscar',
        required: true,
      },
      { name: 'service', type: 'string', description: 'Servicio permitido: youtube' },
      {
        name: 'control',
        type: 'string',
        description: 'managed (control verificable) o external (solo apertura)',
      },
      {
        name: 'browser',
        type: 'string',
        description: 'Navegador permitido, solo para control external',
      },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.snapshot',
    name: 'desktop_snapshot',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description:
      'Observa el árbol accesible del escritorio en Linux o Windows y devuelve referencias efímeras',
    params: [
      { name: 'application', type: 'string', description: 'Filtro por aplicación o ventana' },
      { name: 'maxDepth', type: 'number', description: 'Profundidad máxima' },
      { name: 'maxNodes', type: 'number', description: 'Máximo de elementos' },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.screenshot',
    name: 'desktop_screenshot',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Captura una pantalla o ventana para interfaces sin árbol accesible',
    params: [
      { name: 'sourceId', type: 'string', description: 'ID exacto de la fuente' },
      { name: 'sourceName', type: 'string', description: 'Nombre parcial de ventana' },
      { name: 'width', type: 'number', description: 'Ancho máximo' },
      { name: 'height', type: 'number', description: 'Alto máximo' },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.pointer_click',
    name: 'pointer_click',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Clic visual ligado a una captura vigente; solo para controles sin accesibilidad',
    params: [
      { name: 'captureId', type: 'string', description: 'ID de captura', required: true },
      { name: 'x', type: 'number', description: 'Coordenada X en la captura', required: true },
      { name: 'y', type: 'number', description: 'Coordenada Y en la captura', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.window_list',
    name: 'window_list',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Lista ventanas visibles mediante la API accesible nativa',
    params: [{ name: 'application', type: 'string', description: 'Filtro opcional' }],
    highImpact: true,
  },
  {
    id: 'desktop.ui_get_state',
    name: 'ui_get_state',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Consulta el estado de una referencia UI observada sin mutarla',
    params: [
      { name: 'observationId', type: 'string', description: 'ID de observación', required: true },
      { name: 'ref', type: 'string', description: 'Referencia ui-N', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.ui_wait',
    name: 'ui_wait',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Espera una postcondición observable en la interfaz',
    params: [
      { name: 'application', type: 'string', description: 'Filtro opcional por aplicación' },
      { name: 'timeout', type: 'number', description: 'Espera máxima en milisegundos' },
      { name: 'expected', type: 'object', description: 'Postcondición', required: true },
    ],
    highImpact: true,
  },
  ...[
    ['window_focus', 'Enfoca una ventana o control observado'],
    ['ui_click', 'Invoca un botón o control observado'],
    ['ui_type', 'Escribe en un campo observado'],
    ['ui_press', 'Envía una tecla a un control observado'],
    ['ui_select', 'Selecciona una opción observada'],
    ['ui_scroll', 'Desplaza un control observado'],
    ['window_close', 'Cierra una ventana observada'],
  ].map(([name, description]) => ({
    id: `desktop.${name}`,
    name,
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: `${description}; exige observationId/ref y admite una postcondición expected`,
    params: [
      {
        name: 'observationId',
        type: 'string',
        description: 'ID de la última observación',
        required: true,
      },
      { name: 'ref', type: 'string', description: 'Referencia ui-N observada', required: true },
      { name: 'value', type: 'string', description: 'Texto para ui_type' },
      { name: 'key', type: 'string', description: 'Tecla para ui_press' },
      { name: 'direction', type: 'string', description: 'Dirección para ui_scroll' },
      { name: 'amount', type: 'number', description: 'Pasos para ui_scroll' },
      { name: 'expected', type: 'object', description: 'Postcondición observable' },
    ],
    highImpact: true,
  })),
  {
    id: 'desktop.capabilities',
    name: 'desktop_capabilities',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Informa capacidades disponibles sin ejecutar acciones',
    params: [],
    highImpact: true,
  },
  {
    id: 'desktop.process_list',
    name: 'process_list',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Lista PID y nombre de procesos sin argumentos ni entorno',
    params: [
      { name: 'query', type: 'string', description: 'Filtro opcional por nombre' },
      { name: 'limit', type: 'number', description: 'Máximo de resultados' },
    ],
    highImpact: true,
  },
  {
    id: 'desktop.process_stop',
    name: 'process_stop',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Solicita terminar un PID previamente identificado',
    params: [{ name: 'pid', type: 'number', description: 'PID exacto', required: true }],
    highImpact: true,
  },
  {
    id: 'desktop.camera_status',
    name: 'camera_status',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Consulta permiso de cámara sin capturar video',
    params: [],
    highImpact: true,
  },
  {
    id: 'desktop.open_camera',
    name: 'open_camera',
    domain: ['desktop', 'system'],
    source: 'desktop',
    description: 'Abre una aplicación de cámara conocida sin capturar video',
    params: [],
    highImpact: true,
  },
  {
    id: 'openclaw.web_search',
    name: 'web_search',
    domain: ['web'],
    source: 'openclaw',
    description: 'Busca información en internet usando Google',
    params: [
      { name: 'query', type: 'string', description: 'Término de búsqueda', required: true },
      { name: 'max_results', type: 'number', description: 'Máximo de resultados', default: 5 },
    ],
    examples: [{ cmd: 'buscar "API de node fs"', desc: 'Buscar en Google' }],
    highImpact: false,
  },
  {
    id: 'openclaw.websearch',
    name: 'websearch',
    domain: ['web'],
    source: 'openclaw',
    description:
      'Búsqueda web ligera vía DuckDuckGo (sin navegador, sin API key). Úsalo para consultas rápidas de referencia; para interacción completa con una web usa browser',
    params: [
      { name: 'query', type: 'string', description: 'Término de búsqueda', required: true },
      { name: 'max_results', type: 'number', description: 'Máximo de resultados', default: 5 },
    ],
    examples: [{ cmd: 'buscar en la web "API de node fs"', desc: 'Búsqueda web ligera' }],
    highImpact: false,
  },
  {
    id: 'openclaw.webfetch',
    name: 'webfetch',
    domain: ['web'],
    source: 'openclaw',
    description:
      'Obtiene el contenido de una URL como texto plano (sin navegador). Úsalo para leer documentación, noticias o APIs de texto; para JS pesado usa browser',
    params: [
      { name: 'url', type: 'string', description: 'URL http(s) a leer', required: true },
      { name: 'timeout', type: 'number', description: 'Timeout en segundos', default: 20 },
    ],
    examples: [{ cmd: 'leer https://nodejs.org/api/fs.html', desc: 'Leer página como texto' }],
    highImpact: false,
  },
  {
    id: 'openclaw.grep',
    name: 'grep',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Busca un patrón (regex) dentro del contenido de los archivos del proyecto',
    params: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Patrón regex o texto a buscar',
        required: true,
      },
      {
        name: 'path',
        type: 'string',
        description: 'Directorio o archivo donde buscar',
        required: false,
      },
      {
        name: 'include',
        type: 'string',
        description: 'Glob de archivos a incluir, ej: "*.js"',
        required: false,
      },
      {
        name: 'ignore',
        type: 'string',
        description: 'Directorio/patrón a excluir',
        required: false,
      },
      { name: 'max_results', type: 'number', description: 'Máximo de coincidencias', default: 50 },
    ],
    examples: [{ cmd: 'buscar dónde se usa X en el código', desc: 'Grep en el proyecto' }],
    highImpact: false,
  },
  {
    id: 'openclaw.glob',
    name: 'glob',
    domain: ['filesystem', 'code'],
    source: 'openclaw',
    description: 'Lista archivos que coinciden con un patrón glob',
    params: [
      {
        name: 'pattern',
        type: 'string',
        description: 'Patrón glob, ej: "src/**/*.js"',
        required: true,
      },
      { name: 'path', type: 'string', description: 'Directorio base', required: false },
    ],
    examples: [{ cmd: 'listar los archivos de src', desc: 'Glob' }],
    highImpact: false,
  },
  {
    id: 'openclaw.subagent',
    name: 'subagent',
    domain: ['core'],
    source: 'openclaw',
    description:
      'Lanza un subagente autónomo que resuelve una sub-tarea de forma independiente y devuelve un resumen conciso. Perfiles disponibles:\n' +
      getSubagentRegistry().describeForPrompt(),
    params: [
      {
        name: 'task',
        type: 'string',
        description: 'Sub-tarea concreta a resolver',
        required: true,
      },
      {
        name: 'agent',
        type: 'string',
        description:
          'Perfil del subagente (general, explorador, investigador, o uno definido por el usuario)',
        default: 'general',
        required: false,
      },
      {
        name: 'context',
        type: 'string',
        description: 'Contexto adicional (opcional)',
        required: false,
      },
      {
        name: 'max_iterations',
        type: 'number',
        description: 'Máximo de iteraciones del subagente',
        default: 8,
      },
    ],
    examples: [{ cmd: 'investigar X y resumir', desc: 'Subagente de investigación' }],
    highImpact: false,
  },
  {
    id: 'openclaw.subagent_batch',
    name: 'subagent_batch',
    domain: ['core'],
    source: 'openclaw',
    description:
      'Ejecuta en paralelo de 2 a 4 subagentes con perfiles de solo lectura para investigar subtareas independientes.',
    params: [
      {
        name: 'tasks',
        type: 'array',
        description: 'Lista de subtareas {task, agent, context?, max_iterations?}',
        required: true,
      },
    ],
    highImpact: false,
  },
  // ── LSP tools (Fase 7) ─────────────────────────────────────────────────────
  {
    id: 'lsp.get_diagnostics',
    name: 'get_diagnostics',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Obtiene diagnósticos (errores, advertencias) de un archivo a través del servidor LSP',
    params: [
      {
        name: 'filePath',
        type: 'string',
        description: 'Ruta del archivo a diagnosticar',
        required: true,
      },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.go_to_definition',
    name: 'go_to_definition',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Navega a la definición de un símbolo en una posición específica',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.find_references',
    name: 'find_references',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Encuentra todas las referencias a un símbolo en el proyecto',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
    ],
    highImpact: false,
  },
  ...['go_to_implementation', 'completion', 'signature_help', 'call_hierarchy'].map((name) => ({
    id: `lsp.${name}`,
    name,
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: {
      go_to_implementation: 'Localiza implementaciones concretas de un símbolo',
      completion: 'Obtiene completaciones válidas para una posición',
      signature_help: 'Obtiene firmas y parámetros de una llamada',
      call_hierarchy: 'Obtiene la jerarquía de llamadas entrantes o salientes',
    }[name],
    params: [
      { name: 'filePath', type: 'string', required: true },
      { name: 'line', type: 'number', required: true },
      { name: 'character', type: 'number', required: true },
      ...(name === 'call_hierarchy'
        ? [{ name: 'direction', type: 'string', required: false }]
        : []),
    ],
    highImpact: false,
  })),
  {
    id: 'lsp.get_symbols',
    name: 'get_symbols',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description: 'Obtiene la lista de símbolos (funciones, clases, variables) de un archivo',
    params: [{ name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true }],
    highImpact: false,
  },
  {
    id: 'lsp.workspace_symbols',
    name: 'workspace_symbols',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Busca símbolos por nombre en todo el proyecto (útil para localizar un símbolo sin saber su archivo)',
    params: [
      {
        name: 'query',
        type: 'string',
        description: 'Nombre o parte del nombre del símbolo (ej: "buildContext")',
        required: true,
      },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.hover',
    name: 'hover',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Información de tipo y documentación de un símbolo en una posición específica (como el hover del editor)',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'lsp.rename',
    name: 'rename',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Renombra un símbolo en todo el proyecto de forma segura vía LSP (actualiza todas las referencias)',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
      { name: 'newName', type: 'string', description: 'Nuevo nombre del símbolo', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'lsp.code_actions',
    name: 'code_actions',
    domain: ['code', 'lsp'],
    source: 'lsp',
    description:
      'Consulta acciones rápidas disponibles en una posición (quickfix, refactor, imports faltantes)',
    params: [
      { name: 'filePath', type: 'string', description: 'Ruta del archivo', required: true },
      { name: 'line', type: 'number', description: 'Línea (0-indexed)', required: true },
      { name: 'character', type: 'number', description: 'Columna (0-indexed)', required: true },
      {
        name: 'context',
        type: 'string',
        description: 'Filtro opcional (ej: "quickfix", "refactor", "source")',
        required: false,
      },
    ],
    highImpact: false,
  },
  // ── Git nativo (§10) ───────────────────────────────────────────────────────
  {
    id: 'git.git_status',
    name: 'git_status',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Estado del repo git: rama actual, ahead/behind, cambios staged/unstaged, untracked y conflictos',
    params: [
      {
        name: 'cwd',
        type: 'string',
        description: 'Directorio de trabajo (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_diff',
    name: 'git_diff',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Diff de cambios no confirmados; con staged=true muestra lo que ya fue agregado',
    params: [
      {
        name: 'file',
        type: 'string',
        description: 'Archivo específico (opcional)',
        required: false,
      },
      {
        name: 'staged',
        type: 'boolean',
        description: 'Diff de lo staged (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_log',
    name: 'git_log',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Historial de commits recientes (hash, autor, fecha, subject)',
    params: [
      {
        name: 'count',
        type: 'number',
        description: 'Cantidad de commits (máx 50)',
        default: 20,
        required: false,
      },
      {
        name: 'file',
        type: 'string',
        description: 'Filtrar por archivo (opcional)',
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'git.git_branch',
    name: 'git_branch',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Lista las ramas locales con su upstream y desfase ahead/behind',
    params: [],
    highImpact: false,
  },
  {
    id: 'git.git_add',
    name: 'git_add',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Stagea archivos en git. Sin paths hace git add -A (todo). Con paths, stagea solo esos (REQUIERE APROBACIÓN)',
    params: [
      {
        name: 'paths',
        type: 'array',
        description: 'Archivos/rutas a stagear (opcional; sin esto stagea todo)',
        required: false,
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Directorio de trabajo (opcional)',
        required: false,
      },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_commit',
    name: 'git_commit',
    domain: ['git', 'code'],
    source: 'git',
    description: 'Hace git add -A y commit con el mensaje dado (REQUIERE APROBACIÓN)',
    params: [
      { name: 'message', type: 'string', description: 'Mensaje del commit', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_stash',
    name: 'git_stash',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Lista stashes (list, lectura) o ejecuta push/pop/apply/drop (muta, requiere aprobación)',
    params: [
      {
        name: 'action',
        type: 'string',
        description: 'list | push | pop | apply | drop',
        default: 'list',
        required: true,
      },
      {
        name: 'message',
        type: 'string',
        description: 'Mensaje para action=push (opcional)',
        required: false,
      },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_merge',
    name: 'git_merge',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Fusiona una rama en la actual; detecta conflictos y los devuelve estructurados (REQUIERE APROBACIÓN)',
    params: [
      { name: 'branch', type: 'string', description: 'Rama a fusionar', required: true },
      {
        name: 'message',
        type: 'string',
        description: 'Mensaje del merge (opcional)',
        required: false,
      },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_rebase',
    name: 'git_rebase',
    domain: ['git', 'code'],
    source: 'git',
    description:
      'Reaplica los commits de la rama actual sobre otra; detecta conflictos estructurados (REQUIERE APROBACIÓN)',
    params: [
      { name: 'branch', type: 'string', description: 'Rama base del rebase', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'git.git_push',
    name: 'git_push',
    domain: ['git', 'code', 'github'],
    source: 'git',
    description:
      'Sube los commits de la rama actual al remoto (origin). Usa el token de GitHub conectado si está (REQUIERE APROBACIÓN)',
    params: [
      {
        name: 'remote',
        type: 'string',
        description: 'Remoto (opcional, por defecto origin)',
        required: false,
      },
      {
        name: 'branch',
        type: 'string',
        description: 'Rama a pushear (opcional, por defecto la actual)',
        required: false,
      },
      { name: 'force', type: 'boolean', description: 'Push forzado (peligroso)', required: false },
    ],
    highImpact: true,
  },
  // ── GitHub nativo (§10) ─────────────────────────────────────────────────────
  {
    id: 'github.github_repo_info',
    name: 'github_repo_info',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description:
      'Información de un repo de GitHub (descripción, default branch, estrellas, license)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_issue_list',
    name: 'github_issue_list',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Lista issues de un repo filtrados por estado',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      {
        name: 'state',
        type: 'string',
        description: 'open | closed | all',
        default: 'open',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Máx resultados',
        default: 10,
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_issue_create',
    name: 'github_issue_create',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Crea un issue en un repo (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'title', type: 'string', description: 'Título del issue', required: true },
      { name: 'body', type: 'string', description: 'Cuerpo del issue (opcional)', required: false },
      { name: 'labels', type: 'array', description: 'Labels (opcional)', required: false },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_issue_comment',
    name: 'github_issue_comment',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Comenta en un issue (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'issue_number', type: 'number', description: 'Número del issue', required: true },
      { name: 'body', type: 'string', description: 'Cuerpo del comentario', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_issue_close',
    name: 'github_issue_close',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Cierra un issue (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'issue_number', type: 'number', description: 'Número del issue', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_pr_list',
    name: 'github_pr_list',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Lista pull requests de un repo filtrados por estado',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      {
        name: 'state',
        type: 'string',
        description: 'open | closed | all',
        default: 'open',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Máx resultados',
        default: 10,
        required: false,
      },
    ],
    highImpact: false,
  },
  {
    id: 'github.github_pr_create',
    name: 'github_pr_create',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Crea una pull request (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'title', type: 'string', description: 'Título de la PR', required: true },
      { name: 'head', type: 'string', description: 'Rama origen', required: true },
      { name: 'base', type: 'string', description: 'Rama destino', required: true },
      { name: 'body', type: 'string', description: 'Descripción (opcional)', required: false },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_pr_review',
    name: 'github_pr_review',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description:
      'Envía una review a una PR (APPROVE | REQUEST_CHANGES | COMMENT) (REQUIERE APROBACIÓN)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'pull_number', type: 'number', description: 'Número de la PR', required: true },
      {
        name: 'event',
        type: 'string',
        description: 'APPROVE | REQUEST_CHANGES | COMMENT',
        default: 'COMMENT',
        required: true,
      },
      { name: 'body', type: 'string', description: 'Cuerpo de la review', required: true },
    ],
    highImpact: true,
  },
  {
    id: 'github.github_actions_status',
    name: 'github_actions_status',
    domain: ['github', 'git', 'code'],
    source: 'github',
    description: 'Estado de las GitHub Actions de un repo (runs recientes, status, conclusion)',
    params: [
      { name: 'repo', type: 'string', description: 'Repo en formato "owner/repo"', required: true },
      { name: 'limit', type: 'number', description: 'Máx runs', default: 10, required: false },
    ],
    highImpact: false,
  },
  // ── Memory tools ───────────────────────────────────────────────────────────
  {
    id: 'memory.memory_search',
    name: 'memory_search',
    domain: ['memory', 'data'],
    source: 'memory',
    description:
      'Busca en la memoria de Kaoru (nodos de conocimiento, episodios, preferencias, interacciones)',
    params: [
      { name: 'query', type: 'string', description: 'Texto de búsqueda semántica', required: true },
      {
        name: 'type',
        type: 'string',
        description:
          'Tipo de nodo: User, Episode, Belief, Preference, Project, Emotion, Interaction, Pattern, Relation',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Número máximo de resultados',
        default: 10,
        required: false,
      },
    ],
    examples: [
      { cmd: '¿Qué sé sobre el usuario?', desc: 'Buscar todo el conocimiento del usuario' },
      { cmd: 'proyectos del usuario', desc: 'Buscar proyectos conocidos' },
      { cmd: 'preferencias musicales', desc: 'Buscar preferencias musicales' },
      { cmd: 'historial de interacciones', desc: 'Buscar interacciones pasadas' },
    ],
    highImpact: false,
  },
  {
    id: 'memory.memory_log_interaction',
    name: 'memory_log_interaction',
    domain: ['memory', 'data'],
    source: 'memory',
    description: 'Registra una interacción del usuario en la memoria',
    params: [
      {
        name: 'type',
        type: 'string',
        description:
          'Tipo de interacción: liked, disliked, followed_suggestion, ignored_suggestion, asked_question, provided_info',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description: 'Contenido de la interacción',
        required: true,
      },
      {
        name: 'metadata',
        type: 'object',
        description: 'Metadata adicional (opcional)',
        required: false,
      },
    ],
    examples: [
      { cmd: ' liked_response', desc: 'Registrar que al usuario le gustó una respuesta' },
      { cmd: ' disliked_response', desc: 'Registrar que al usuario no le gustó una respuesta' },
      { cmd: ' followed_suggestion', desc: 'Registrar que el usuario siguió una sugerencia' },
    ],
    highImpact: false,
  },
];

class ToolRegistry {
  constructor() {
    this._mcpManager = null;
    this._bridge = null;
    this._lspManager = null;
    /** @type {Array<object>} Tools de plugins registradas dinámicamente */
    this._pluginTools = [];
    // Subagentes por perfil (F1): configurable en config.json →
    // agent.subagent.enabled. Apagado deja la tool fuera del catálogo.
    this._subagentsEnabled = true;
  }

  /**
   * Activa/desactiva la tool subagent (config agent.subagent.enabled).
   * @param {boolean} enabled
   */
  setSubagentsEnabled(enabled) {
    this._subagentsEnabled = enabled !== false;
  }

  setMCPManager(mcp) {
    this._mcpManager = mcp;
  }

  setOpenClawBridge(bridge) {
    this._bridge = bridge;
  }

  setLSPManager(lsp) {
    this._lspManager = lsp;
  }

  /**
   * Registra una tool de plugin (o reemplaza una existente con el mismo id).
   * Formato id: `plugin.<nombre-plugin>.<tool>` (namespaced, patrón MCP).
   * @param {object} tool - { id, name, domain, source, description, params, highImpact, available }
   */
  registerPluginTool(tool) {
    if (!tool || !tool.id || !tool.name) return;
    const idx = this._pluginTools.findIndex((t) => t.id === tool.id);
    if (idx >= 0) this._pluginTools[idx] = { ...tool, source: 'plugin' };
    else this._pluginTools.push({ ...tool, source: 'plugin' });
  }

  /** @param {Array<object>} tools */
  registerPluginTools(tools) {
    for (const t of tools) this.registerPluginTool(t);
  }

  /** @returns {Array<object>} */
  _getPluginTools() {
    return this._pluginTools.map((t) => ({ ...t, available: t.available !== false }));
  }

  _getOpenClawTools() {
    let available = false;
    if (this._bridge) {
      try {
        const stats = this._bridge.getStats?.();
        available = stats?.available ?? false;
      } catch (e) {}
    }
    return TOOL_SCHEMAS.filter((s) => (s.source || 'openclaw') === 'openclaw')
      .filter((s) => this._subagentsEnabled || !['subagent', 'subagent_batch'].includes(s.name))
      .map((s) => ({
        ...s,
        available,
      }));
  }

  _getDesktopTools() {
    return TOOL_SCHEMAS.filter((s) => s.source === 'desktop').map((s) => ({
      ...s,
      available: true,
    }));
  }

  _getLSPTools() {
    const lspAvailable = this._lspManager?.isRunning || false;
    return TOOL_SCHEMAS.filter((s) => s.source === 'lsp').map((s) => ({
      ...s,
      available: lspAvailable,
    }));
  }

  _getGitTools() {
    return TOOL_SCHEMAS.filter((s) => s.source === 'git').map((s) => ({ ...s, available: true }));
  }

  _getGitHubTools() {
    return TOOL_SCHEMAS.filter((s) => s.source === 'github').map((s) => ({
      ...s,
      available: true,
    }));
  }

  _getMCPTools() {
    if (!this._mcpManager) return [];
    try {
      const tools = this._mcpManager.listAllTools();
      return tools.map((t) => ({
        id: `mcp.${t.server}.${t.tool}`,
        name: t.tool,
        domain: ['mcp'],
        source: 'mcp',
        server: t.server,
        description: t.description || `Tool MCP del servidor ${t.server}`,
        params: t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties).map(([k, v]) => ({
              name: k,
              type: v.type || 'any',
              description: v.description || '',
              required: t.inputSchema.required?.includes(k) || false,
            }))
          : [],
        // Coherente con ActionParser.isHighImpact: una tool MCP de solo
        // lectura (read_file, list_directory, get_*, ...) no se marca como
        // alto impacto; el resto puede requerir aprobación según args.
        highImpact: !isMCPToolReadOnly(t.tool),
        available: true,
      }));
    } catch (e) {
      return [];
    }
  }

  getCatalog(domain = null) {
    const openclaw = this._getOpenClawTools();
    const desktop = this._getDesktopTools();
    const lsp = this._getLSPTools();
    const git = this._getGitTools();
    const github = this._getGitHubTools();
    const mcp = this._getMCPTools();
    const plugin = this._getPluginTools();
    let all = [...openclaw, ...desktop, ...lsp, ...git, ...github, ...mcp, ...plugin];

    if (domain && domain.id) {
      all = all.filter((t) => t.domain.includes(domain.id));
    }

    return {
      tools: all,
      total: all.length,
      openclawAvailable: openclaw.some((t) => t.available),
      desktopAvailable: desktop.some((t) => t.available),
      lspAvailable: lsp.some((t) => t.available),
      mcpAvailable: mcp.length > 0,
      pluginAvailable: plugin.length > 0,
      bySource: {
        openclaw: openclaw.length,
        desktop: desktop.length,
        lsp: lsp.length,
        git: git.length,
        github: github.length,
        mcp: mcp.length,
        plugin: plugin.length,
      },
    };
  }

  getDomainCatalog(domain) {
    return this.getCatalog(domain);
  }

  getToolById(id) {
    const all = this._getOpenClawTools()
      .concat(this._getDesktopTools())
      .concat(this._getLSPTools())
      .concat(this._getGitTools())
      .concat(this._getGitHubTools())
      .concat(this._getMCPTools())
      .concat(this._getPluginTools());
    return all.find((t) => t.id === id) || null;
  }

  serializeToPrompt(domain = null, maxTools = 30, allowedNames = null) {
    const catalog = this.getCatalog(domain);
    if (catalog.tools.length === 0) return null;
    if (allowedNames instanceof Set) {
      catalog.tools = catalog.tools.filter((t) => allowedNames.has(t.name));
    }
    if (catalog.tools.length === 0) return null;

    // Render único compartido (CatalogRenderer.js): mismo texto que antes.
    const { renderToolCatalog } = require('./CatalogRenderer.js');
    return renderToolCatalog(catalog.tools, {
      domainLabel: domain ? domain.label : null,
      openclawUnavailableNote: !catalog.openclawAvailable,
      lspUnavailableNote: !catalog.lspAvailable,
      openclawTitleSuffix: true,
      mcpStyle: 'flat-capped',
      maxTools,
      includePlugins: true,
      usageStyle: 'legacy',
      rulesSection: true,
    });
  }
}

let _instance = null;
function getToolRegistry() {
  if (!_instance) _instance = new ToolRegistry();
  return _instance;
}

module.exports = { ToolRegistry, getToolRegistry };
