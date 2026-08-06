// @ts-check
'use strict';

const TOOLS = {
  saludo: {
    description: 'Genera un saludo personalizado para un nombre.',
    params: [
      {
        name: 'nombre',
        type: 'string',
        description: 'Nombre de la persona a saludar',
        required: true,
      },
    ],
    run: async ({ nombre }) => {
      if (!nombre) return { ok: false, error: 'nombre requerido' };
      return { ok: true, result: `¡Hola, ${nombre}! Este es un saludo del plugin hello-world.` };
    },
  },
};

module.exports = {
  tools() {
    return Object.entries(TOOLS).map(([name, def]) => ({
      name,
      description: def.description,
      params: def.params,
    }));
  },

  /** @param {string} toolName @param {object} args */
  async run(toolName, args = {}) {
    const tool = TOOLS[toolName];
    if (!tool) return { ok: false, error: `tool desconocida: ${toolName}` };
    return tool.run(args);
  },

  register(ctx) {
    ctx.logger('plugin registrado');

    ctx.registerHook('beforeAgentRun', async ({ userMessage }) => {
      if (userMessage && userMessage.toLowerCase().includes('saluda')) {
        ctx.logger('detectado "saluda" en el mensaje');
        return {
          systemPrompt:
            'Nota de plugin hello-world: el usuario pidió un saludo — sé especialmente amable y empieza con un saludo animado.',
        };
      }
      return undefined;
    });

    ctx.registerHook('beforeTool', async ({ tool, params }) => {
      const command = (params && (params.command || params.cmd)) || '';
      if (command.includes('rm -rf')) {
        ctx.logger(`bloqueado "rm -rf" en exec (politica del plugin)`);
        return { deny: true, reason: 'comando destructivo bloqueado por el plugin hello-world' };
      }
      return undefined;
    });
  },
};
