'use strict';

const TOOL_SCHEMAS = [
  {
    name: 'exec',
    description: 'Ejecuta cualquier comando en la terminal del sistema. Se usa para git, npm, pip, shell, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando completo a ejecutar' },
        cwd: { type: 'string', description: 'Directorio de trabajo (opcional, por defecto el proyecto)' },
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
    description: 'Escribe o sobrescribe el contenido de un archivo. Si el directorio no existe, se crea.',
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
    description: 'Modifica partes específicas de un archivo reemplazando texto exacto. No crea archivos nuevos.',
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
    description: 'Navega a una URL y obtiene el contenido de la página. Usa el navegador headless del asistente.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Acción a realizar', enum: ['navigate', 'click', 'get_text', 'screenshot'], default: 'navigate' },
        url: { type: 'string', description: 'URL a navegar (obligatorio para action=navigate)' },
        selector: { type: 'string', description: 'Selector CSS (para action=click o get_text)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'web_search',
    description: 'Busca información en internet usando Google, devuelve título + URL + snippet de los resultados',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Término de búsqueda' },
        max_results: { type: 'number', description: 'Máximo de resultados a devolver', default: 5 },
      },
      required: ['query'],
    },
  },
  // ── LSP tools (Fase 7) ─────────────────────────────────────────────
  {
    name: 'get_diagnostics',
    description: 'Obtiene diagnósticos (errores, advertencias) de un archivo a través del servidor LSP de TypeScript',
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
    description: 'Encuentra todas las referencias a un símbolo en el proyecto a través del servidor LSP',
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
    description: 'Obtiene la lista de símbolos (funciones, clases, variables) de un archivo a través del servidor LSP',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Ruta del archivo' },
      },
      required: ['filePath'],
    },
  },
];

function getToolSchemas() {
  return TOOL_SCHEMAS.map(s => ({ ...s }));
}

module.exports = { TOOL_SCHEMAS, getToolSchemas };
