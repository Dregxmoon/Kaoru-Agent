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
    description: 'Lee el contenido completo de un archivo del sistema de archivos',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta absoluta o relativa del archivo a leer' },
        encoding: { type: 'string', description: 'Codificación del archivo', default: 'utf-8' },
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
      'Navega a una URL y obtiene el contenido de la página. Usa el navegador headless del asistente.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Acción a realizar',
          enum: ['navigate', 'click', 'get_text', 'screenshot'],
          default: 'navigate',
        },
        url: { type: 'string', description: 'URL a navegar (obligatorio para action=navigate)' },
        selector: { type: 'string', description: 'Selector CSS (para action=click o get_text)' },
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
      'Obtiene el contenido de una URL como texto plano (sin navegador). Úsala para leer documentación, noticias o APIs de texto; para JS pesado usa browser',
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
