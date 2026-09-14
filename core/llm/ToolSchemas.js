'use strict';

const TOOL_SCHEMAS = [
  {
    name: 'exec',
    description:
      'Ejecuta cualquier comando en la terminal del sistema. Se usa para git, npm, pip, shell, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando completo a ejecutar' },
        cwd: {
          type: 'string',
          description: 'Directorio de trabajo (opcional, por defecto el proyecto)',
        },
        timeout: { type: 'number', description: 'Timeout de ejecución en segundos', default: 15 },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description:
      'Lee un archivo. Para archivos grandes usa start_line y max_lines y continúa desde next_line hasta eof=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta absoluta o relativa del archivo a leer' },
        encoding: { type: 'string', description: 'Codificación del archivo', default: 'utf-8' },
        start_line: {
          type: 'number',
          description: 'Primera línea a devolver (base 1). Opcional.',
          minimum: 1,
        },
        max_lines: {
          type: 'number',
          description: 'Máximo de líneas a devolver (1-400). Opcional.',
          minimum: 1,
          maximum: 400,
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description:
      'Escribe o sobrescribe el contenido de un archivo. Si el directorio no existe, se crea.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta absoluta o relativa del archivo' },
        content: { type: 'string', description: 'Contenido completo a escribir' },
        encoding: { type: 'string', description: 'Codificación', default: 'utf-8' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description:
      'Modifica partes específicas de un archivo reemplazando texto exacto. No crea archivos nuevos.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo a editar' },
        old_text: { type: 'string', description: 'Texto exacto existente que se reemplazará' },
        new_text: { type: 'string', description: 'Texto nuevo que reemplazará a old_text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Aplica un parche diff/unified a un archivo. Usa el formato unificado de diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo a parchear' },
        patch: { type: 'string', description: 'Contenido del parche en formato unificado' },
      },
      required: ['path', 'patch'],
    },
  },
  {
    name: 'code_execution',
    description: 'Ejecuta código Python y devuelve stdout, stderr y código de salida',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Código Python a ejecutar' },
        timeout: { type: 'number', description: 'Timeout en segundos', default: 10 },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser',
    description:
      'Controla una sesión web: navegar, localizar por atributos visibles, hacer clic, escribir, enviar teclas, esperar, leer y verificar URL. mode=managed muestra el navegador controlable de Kaoru; background lo mantiene oculto. IMPORTANTE: solo usá URLs que aparecieron en la conversación.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Acción a realizar',
          enum: [
            'navigate',
            'click',
            'type',
            'press',
            'wait_for',
            'get_text',
            'get_url',
            'back',
            'forward',
            'screenshot',
            'snapshot',
            'tabs',
            'new_tab',
            'select_tab',
            'close_tab',
            'select',
            'check',
            'uncheck',
            'hover',
            'scroll',
            'upload',
            'download',
            'dialog',
          ],
          default: 'navigate',
        },
        mode: {
          type: 'string',
          enum: ['background', 'managed'],
          default: 'background',
          description: 'managed abre la sesión visible que Kaoru puede controlar y verificar',
        },
        url: { type: 'string', description: 'URL a navegar (obligatorio para action=navigate)' },
        selector: { type: 'string', description: 'Selector CSS opcional' },
        role: { type: 'string', description: 'Rol accesible, por ejemplo button o textbox' },
        name: { type: 'string', description: 'Nombre accesible asociado al role' },
        text: { type: 'string', description: 'Texto visible del elemento' },
        label: { type: 'string', description: 'Etiqueta visible del campo' },
        placeholder: { type: 'string', description: 'Placeholder visible del campo' },
        value: { type: 'string', description: 'Texto para action=type' },
        key: { type: 'string', description: 'Tecla para action=press, por ejemplo Enter' },
        timeout: { type: 'number', description: 'Espera máxima para action=wait_for' },
        sessionId: { type: 'string', description: 'Sesión devuelta por snapshot/tabs' },
        pageId: { type: 'string', description: 'Pestaña devuelta por snapshot/tabs' },
        expectedOrigin: {
          type: 'string',
          description: 'Origen observado que debe seguir activo antes de mutar la página',
        },
        option: { type: 'string', description: 'Valor o etiqueta para action=select' },
        expectedUrl: {
          type: 'string',
          description: 'Fragmento de URL esperado después de un click para verificar su intención',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Dirección para action=scroll',
        },
        path: {
          type: 'string',
          description: 'Archivo del workspace para upload o destino para download',
        },
        dialogAction: {
          type: 'string',
          enum: ['accept', 'dismiss'],
          description: 'Respuesta para action=dialog',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'web_search',
    description:
      'Busca información en internet usando Google, devuelve título + URL + snippet de los resultados',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Término de búsqueda' },
        max_results: { type: 'number', description: 'Máximo de resultados a devolver', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_apps',
    description:
      'Lista aplicaciones instaladas y visibles. Úsala cuando no conozcas el nombre exacto antes de launch_app. Requiere aprobación por privacidad.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filtro opcional por nombre de aplicación' },
      },
      required: [],
    },
  },
  {
    name: 'launch_app',
    description:
      'Abre una aplicación, juego o launcher instalado en el escritorio visible. Requiere aprobación. No admite comandos ni argumentos arbitrarios.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Nombre exacto o alias, por ejemplo firefox o steam' },
      },
      required: ['app'],
    },
  },
  {
    name: 'open_website',
    description:
      'Abre un sitio en el navegador visible del usuario. Usa un alias conocido (drive, youtube, whatsapp, gmail) o una URL https completa. Requiere aprobación.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Alias del sitio o URL https completa' },
        browser: {
          type: 'string',
          enum: ['brave', 'chrome', 'chromium', 'edge', 'firefox'],
          description: 'Navegador opcional; si se omite usa el predeterminado',
        },
        control: {
          type: 'string',
          enum: ['managed', 'external'],
          default: 'external',
          description:
            'external (predeterminado) usa el navegador personal con sus sesiones; managed usa un Chromium aislado controlable',
        },
        needsVerification: {
          type: 'boolean',
          description:
            'Ponlo true cuando debas leer, buscar o comprobar algo DENTRO de la página (precio, disponibilidad, texto). Fuerza managed aunque pidas external: con external quedarías ciega.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'play_media',
    description:
      'Para órdenes compuestas como "abre YouTube, busca un video de guitarra y reprodúcelo". Usa por defecto el navegador visible administrado por Kaoru, pulsa reproducir y verifica que el video esté reproduciéndose. Requiere aprobación.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Tema o video solicitado' },
        service: { type: 'string', enum: ['youtube'], default: 'youtube' },
        control: {
          type: 'string',
          enum: ['managed', 'external'],
          default: 'managed',
          description:
            'managed permite controlar y verificar; external solo abre el navegador elegido y no puede garantizar reproducción',
        },
        browser: {
          type: 'string',
          enum: ['brave', 'chrome', 'chromium', 'edge', 'firefox'],
          description: 'Navegador opcional, usado únicamente con control=external',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'desktop_snapshot',
    description:
      'Observa la interfaz accesible del escritorio en Linux o Windows y devuelve referencias efímeras. Debe ejecutarse antes de cualquier acción UI.',
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'Aplicación o ventana que se quiere observar' },
        maxDepth: { type: 'number', description: 'Profundidad máxima del árbol accesible' },
        maxNodes: { type: 'number', description: 'Máximo de elementos devueltos' },
      },
      required: [],
    },
  },
  {
    name: 'desktop_screenshot',
    description:
      'Captura una pantalla o ventana visible en Linux o Windows como imagen JPEG para interfaces sin accesibilidad.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'ID exacto de pantalla/ventana, si se conoce' },
        sourceName: { type: 'string', description: 'Nombre parcial de la ventana' },
        width: { type: 'number', description: 'Ancho máximo, hasta 1920' },
        height: { type: 'number', description: 'Alto máximo, hasta 1080' },
      },
      required: [],
    },
  },
  {
    name: 'pointer_click',
    description:
      'Fallback visual para canvas o juegos: hace clic en coordenadas de una desktop_screenshot vigente. Debe observarse otra vez inmediatamente.',
    inputSchema: {
      type: 'object',
      properties: {
        captureId: { type: 'string', description: 'ID efímero de desktop_screenshot' },
        x: { type: 'number', description: 'Coordenada X dentro de la imagen capturada' },
        y: { type: 'number', description: 'Coordenada Y dentro de la imagen capturada' },
      },
      required: ['captureId', 'x', 'y'],
    },
  },
  {
    name: 'window_list',
    description: 'Lista ventanas visibles mediante AT-SPI2 en Linux o UI Automation en Windows.',
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'Filtro opcional por aplicación o ventana' },
      },
      required: [],
    },
  },
  {
    name: 'ui_get_state',
    description: 'Consulta sin mutar el estado de una referencia de la observación más reciente.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'string', description: 'ID de la última observación' },
        ref: { type: 'string', description: 'Referencia ui-N de esa observación' },
      },
      required: ['observationId', 'ref'],
    },
  },
  {
    name: 'ui_wait',
    description: 'Espera hasta que una postcondición sea observable y devuelve evidencia nueva.',
    inputSchema: {
      type: 'object',
      properties: {
        application: { type: 'string', description: 'Filtro opcional por aplicación' },
        timeout: { type: 'number', description: 'Espera máxima en milisegundos, hasta 30000' },
        expected: {
          type: 'object',
          description: 'Postcondición observable: name, role, state o absent',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            state: { type: 'string' },
            absent: { type: 'boolean' },
          },
        },
      },
      required: ['expected'],
    },
  },
  ...[
    ['window_focus', 'Enfoca una ventana o control previamente observado.'],
    ['ui_click', 'Invoca un botón o control previamente observado.'],
    ['ui_type', 'Introduce texto en un campo editable previamente observado.'],
    ['ui_press', 'Envía una tecla permitida al elemento previamente observado.'],
    ['ui_select', 'Selecciona una opción o elemento previamente observado.'],
    ['ui_scroll', 'Desplaza un control previamente observado.'],
    ['window_close', 'Cierra una ventana previamente observada.'],
  ].map(([name, description]) => ({
    name,
    description: `${description} Requiere observationId y ref vigentes; expected permite verificar la postcondición.`,
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'string', description: 'ID de la última observación' },
        ref: { type: 'string', description: 'Referencia ui-N de esa observación' },
        value: { type: 'string', description: 'Texto para ui_type' },
        key: { type: 'string', description: 'Tecla para ui_press' },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'Dirección para ui_scroll',
        },
        amount: { type: 'number', description: 'Cantidad de pasos para ui_scroll, de 1 a 10' },
        expected: {
          type: 'object',
          description: 'Postcondición observable: name, role, state o absent',
          properties: {
            name: { type: 'string' },
            role: { type: 'string' },
            state: { type: 'string' },
            absent: { type: 'boolean' },
          },
        },
      },
      required: ['observationId', 'ref'],
    },
  })),
  {
    name: 'desktop_capabilities',
    description:
      'Informa qué familias de control de escritorio admite la plataforma, sin ejecutar acciones.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'process_list',
    description:
      'Lista una cantidad acotada de procesos por PID y nombre. No devuelve argumentos ni variables de entorno.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filtro opcional por nombre' },
        limit: { type: 'number', description: 'Máximo de procesos, hasta 250' },
      },
      required: [],
    },
  },
  {
    name: 'process_stop',
    description:
      'Solicita terminar un proceso por PID con SIGTERM. Requiere aprobación específica y no admite PID 1 ni el proceso de Kaoru.',
    inputSchema: {
      type: 'object',
      properties: { pid: { type: 'number', description: 'PID exacto previamente observado' } },
      required: ['pid'],
    },
  },
  {
    name: 'camera_status',
    description: 'Consulta el estado de acceso a cámara del sistema. No enciende ni captura video.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_camera',
    description:
      'Abre una aplicación de cámara conocida. No captura ni transmite video y requiere aprobación.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'websearch',
    description:
      'Búsqueda web ligera vía DuckDuckGo (sin navegador, sin API key). Úsala para consultas rápidas de referencia; para interactuar con una página usa browser o webfetch',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Término de búsqueda' },
        max_results: { type: 'number', description: 'Máximo de resultados a devolver', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'webfetch',
    description:
      'Obtiene el contenido de una URL como texto plano (sin navegador). Úsala para leer documentación, noticias o APIs de texto; para JS pesado usa browser. IMPORTANTE: solo usá URLs que aparecieron en la conversación — nunca inventes URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL http(s) a leer' },
        timeout: { type: 'number', description: 'Timeout en segundos', default: 20 },
      },
      required: ['url'],
    },
  },
  {
    name: 'grep',
    description:
      'Busca un patrón (regex) dentro del contenido de los archivos del proyecto y devuelve las coincidencias con ruta, línea y texto',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Patrón regex o texto a buscar' },
        path: {
          type: 'string',
          description: 'Directorio o archivo donde buscar (por defecto la raíz del proyecto)',
        },
        include: {
          type: 'string',
          description: 'Glob de archivos a incluir, ej: "*.js" (opcional)',
        },
        ignore: {
          type: 'string',
          description: 'Directorio o patrón a excluir, ej: "node_modules" (opcional)',
        },
        max_results: {
          type: 'number',
          description: 'Máximo de coincidencias a devolver',
          default: 50,
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description:
      'Lista archivos y directorios que coinciden con un patrón glob dentro del proyecto',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Patrón glob, ej: "src/**/*.js"' },
        path: { type: 'string', description: 'Directorio base (por defecto la raíz del proyecto)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'subagent',
    description:
      'Lanza un subagente autónomo que resuelve una sub-tarea concreta (investigar, buscar, redactar) de forma independiente y devuelve un resumen conciso. Útil para tareas largas que pueden paralelizarse o delegarse.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Sub-tarea concreta y autocontenida que debe resolver el subagente',
        },
        agent: {
          type: 'string',
          description:
            'Perfil del subagente: general (default), explorador (solo lectura), investigador (búsqueda web), o un perfil definido por el usuario',
        },
        context: {
          type: 'string',
          description: 'Contexto o restricciones adicionales para el subagente (opcional)',
        },
        max_iterations: {
          type: 'number',
          description: 'Máximo de iteraciones del subagente',
          default: 8,
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'subagent_batch',
    description:
      'Ejecuta en paralelo entre 2 y 4 subagentes de solo lectura para investigar partes independientes y devuelve todos sus reportes.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              task: { type: 'string' },
              agent: { type: 'string', description: 'Perfil read_only' },
              context: { type: 'string' },
              max_iterations: { type: 'number', default: 8 },
            },
            required: ['task', 'agent'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  // ── LSP tools (Fase 7) ─────────────────────────────────────────────
  {
    name: 'get_diagnostics',
    description:
      'Obtiene diagnósticos (errores, advertencias) de un archivo a través del servidor LSP de TypeScript',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo a diagnosticar' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'go_to_definition',
    description: 'Navega a la definición de un símbolo en una posición específica del código',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo donde está el símbolo' },
        line: { type: 'number', description: 'Línea (0-indexed) del símbolo' },
        character: { type: 'number', description: 'Columna (0-indexed) del símbolo' },
      },
      required: ['filePath', 'line', 'character'],
    },
  },
  {
    name: 'find_references',
    description:
      'Encuentra todas las referencias a un símbolo en el proyecto a través del servidor LSP',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo donde está el símbolo' },
        line: { type: 'number', description: 'Línea (0-indexed) del símbolo' },
        character: { type: 'number', description: 'Columna (0-indexed) del símbolo' },
      },
      required: ['filePath', 'line', 'character'],
    },
  },
  ...['go_to_implementation', 'completion', 'signature_help', 'call_hierarchy'].map((name) => ({
    name,
    description: {
      go_to_implementation: 'Localiza implementaciones concretas de una interfaz o símbolo vía LSP',
      completion: 'Obtiene completaciones válidas en una posición vía LSP',
      signature_help: 'Obtiene firmas y parámetros de la llamada actual vía LSP',
      call_hierarchy: 'Obtiene llamadas entrantes o salientes de un símbolo vía LSP',
    }[name],
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo' },
        line: { type: 'number', description: 'Línea (0-indexed)' },
        character: { type: 'number', description: 'Columna (0-indexed)' },
        ...(name === 'call_hierarchy'
          ? { direction: { type: 'string', enum: ['incoming', 'outgoing'] } }
          : {}),
      },
      required: ['filePath', 'line', 'character'],
    },
  })),
  {
    name: 'get_symbols',
    description:
      'Obtiene la lista de símbolos (funciones, clases, variables) de un archivo a través del servidor LSP',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'workspace_symbols',
    description:
      'Busca símbolos (funciones, clases, variables) por nombre en TODO el proyecto vía LSP — útil para localizar dónde vive un símbolo sin saber el archivo',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nombre o parte del nombre del símbolo a buscar (ej: "buildContext")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'hover',
    description:
      'Obtiene información de tipo y documentación de un símbolo (como el hover del editor) a través del LSP',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo donde está el símbolo' },
        line: { type: 'number', description: 'Línea (0-indexed) del símbolo' },
        character: { type: 'number', description: 'Columna (0-indexed) del símbolo' },
      },
      required: ['filePath', 'line', 'character'],
    },
  },
  {
    name: 'rename',
    description:
      'Renombra un símbolo en todo el proyecto de forma segura vía LSP (actualiza todas las referencias)',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo donde está el símbolo' },
        line: { type: 'number', description: 'Línea (0-indexed) del símbolo' },
        character: { type: 'number', description: 'Columna (0-indexed) del símbolo' },
        newName: { type: 'string', description: 'Nuevo nombre para el símbolo' },
      },
      required: ['filePath', 'line', 'character', 'newName'],
    },
  },
  {
    name: 'code_actions',
    description:
      'Consulta acciones rápidas disponibles en una posición (quickfix de errores, refactor, imports faltantes) vía LSP',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo' },
        line: { type: 'number', description: 'Línea (0-indexed)' },
        character: { type: 'number', description: 'Columna (0-indexed)' },
        context: {
          type: 'string',
          description:
            'Filtro opcional sobre la acción buscada (ej: "quickfix", "refactor", "source")',
        },
      },
      required: ['filePath', 'line', 'character'],
    },
  },
  // ── Git nativo (§10) ─────────────────────────────────────────────────────
  {
    name: 'git_status',
    description:
      'Estado del repo git: rama actual, ahead/behind, cambios staged/unstaged, untracked y conflictos. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directorio de trabajo (opcional, por defecto el proyecto)',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_diff',
    description:
      'Diff de cambios no confirmados; con staged=true muestra lo que ya fue agregado. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Archivo específico (opcional)' },
        staged: { type: 'boolean', description: 'Diff de lo staged (opcional)' },
      },
      required: [],
    },
  },
  {
    name: 'git_log',
    description: 'Historial de commits recientes (hash, autor, fecha, subject). Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Cantidad de commits (máx 50)', default: 20 },
        file: { type: 'string', description: 'Filtrar por archivo (opcional)' },
      },
      required: [],
    },
  },
  {
    name: 'git_branch',
    description: 'Lista las ramas locales con su upstream y desfase ahead/behind. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'git_commit',
    description:
      'Hace git add -A y commit con el mensaje dado. MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Mensaje del commit' },
      },
      required: ['message'],
    },
  },
  {
    name: 'git_add',
    description:
      'Stagea archivos en el index de git. Sin paths hace git add -A (todo). MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Archivos/rutas a stagear (opcional; sin esto stagea todo)',
        },
      },
      required: [],
    },
  },
  {
    name: 'git_stash',
    description:
      'Lista stashes (action=list, lectura) o ejecuta push/pop/apply/drop (muta, requiere aprobación).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'list | push | pop | apply | drop',
          default: 'list',
        },
        message: { type: 'string', description: 'Mensaje para action=push (opcional)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'git_merge',
    description:
      'Fusiona una rama en la actual; detecta conflictos y los devuelve estructurados. MUTADOR: requiere aprobación.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Rama a fusionar' },
        message: { type: 'string', description: 'Mensaje del merge (opcional)' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'git_rebase',
    description:
      'Reaplica los commits de la rama actual sobre otra; detecta conflictos estructurados. MUTADOR: requiere aprobación.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Rama base del rebase' },
      },
      required: ['branch'],
    },
  },
  {
    name: 'git_push',
    description:
      'Sube los commits de la rama actual al remoto (por defecto origin). Usa el token de GitHub conectado (github_token) si está. MUTADOR: requiere aprobación.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: 'Remoto (opcional, por defecto origin)' },
        branch: { type: 'string', description: 'Rama a pushear (opcional, por defecto la actual)' },
        force: { type: 'boolean', description: 'Push forzado (opcional, peligroso)' },
      },
      required: [],
    },
  },
  // ── GitHub nativo (§10) ─────────────────────────────────────────────────────
  {
    name: 'github_repo_info',
    description:
      'Información de un repo de GitHub (descripción, default branch, estrellas, license). Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'github_issue_list',
    description: 'Lista issues de un repo filtrados por estado. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        state: { type: 'string', description: 'open | closed | all', default: 'open' },
        limit: { type: 'number', description: 'Máx resultados', default: 10 },
      },
      required: ['repo'],
    },
  },
  {
    name: 'github_issue_create',
    description: 'Crea un issue en un repo. MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        title: { type: 'string', description: 'Título del issue' },
        body: { type: 'string', description: 'Cuerpo del issue (opcional)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels (opcional)' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'github_issue_comment',
    description: 'Comenta en un issue. MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        issue_number: { type: 'number', description: 'Número del issue' },
        body: { type: 'string', description: 'Cuerpo del comentario' },
      },
      required: ['repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'github_issue_close',
    description: 'Cierra un issue. MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        issue_number: { type: 'number', description: 'Número del issue' },
      },
      required: ['repo', 'issue_number'],
    },
  },
  {
    name: 'github_pr_list',
    description: 'Lista pull requests de un repo filtrados por estado. Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        state: { type: 'string', description: 'open | closed | all', default: 'open' },
        limit: { type: 'number', description: 'Máx resultados', default: 10 },
      },
      required: ['repo'],
    },
  },
  {
    name: 'github_pr_create',
    description: 'Crea una pull request. MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        title: { type: 'string', description: 'Título de la PR' },
        head: { type: 'string', description: 'Rama origen' },
        base: { type: 'string', description: 'Rama destino' },
        body: { type: 'string', description: 'Descripción (opcional)' },
      },
      required: ['repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'github_pr_review',
    description:
      'Envía una review a una PR (APPROVE | REQUEST_CHANGES | COMMENT). MUTADOR: requiere aprobación del usuario.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        pull_number: { type: 'number', description: 'Número de la PR' },
        event: {
          type: 'string',
          description: 'APPROVE | REQUEST_CHANGES | COMMENT',
          default: 'COMMENT',
        },
        body: { type: 'string', description: 'Cuerpo de la review' },
      },
      required: ['repo', 'pull_number', 'event', 'body'],
    },
  },
  {
    name: 'github_actions_status',
    description:
      'Estado de las GitHub Actions de un repo (runs recientes, status, conclusion). Solo lectura.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo en formato "owner/repo"' },
        limit: { type: 'number', description: 'Máx runs', default: 10 },
      },
      required: ['repo'],
    },
  },
];

function getToolSchemas() {
  return TOOL_SCHEMAS.map((s) => ({ ...s }));
}

module.exports = { TOOL_SCHEMAS, getToolSchemas };
