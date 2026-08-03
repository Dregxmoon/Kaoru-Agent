'use strict';

module.exports = function registerCommands(register) {
  register({
    name: 'credenciales',
    description: 'Abre la configuracion de API keys',
    usage: '/credenciales',
    handler: async (args, ctx) => {
      if (typeof ctx.openSettings === 'function') {
        ctx.openSettings();
        return 'Abriendo configuracion de credenciales...';
      }
      return 'No se puede abrir la configuracion desde este contexto.';
    },
  });
};