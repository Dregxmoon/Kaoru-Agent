// @ts-nocheck
'use strict';

module.exports = function registerCommands(register) {
  register({
    name: 'credenciales',
    description: 'Guarda la API key de un proveedor',
    usage: '/credenciales <provider> <tu-key>',
    handler: async (args, ctx) => {
      const LLMProvider = ctx.LLMProvider;
      if (!LLMProvider || typeof LLMProvider.getAvailableProviders !== 'function')
        return 'No hay proveedores disponibles en este contexto.';
      const providers = LLMProvider.getAvailableProviders();
      if (!providers || !providers.length)
        return 'No hay proveedores disponibles en este contexto.';

      // Sin argumentos: lista los disponibles (discoverabilidad).
      if (args.length === 0) {
        const active =
          typeof LLMProvider.getActiveProvider === 'function'
            ? LLMProvider.getActiveProvider()
            : null;
        const lines = providers.map((p, i) => {
          const connected = p.hasKey ? ' [conectado]' : '';
          const activeMark = p.id === active ? ' ▶' : '';
          return `${i + 1}. ${p.name}${connected}${activeMark}`;
        });
        return [
          'Usa: `/credenciales <provider> <tu-key>` para guardar una API key.',
          '',
          '**Proveedores disponibles:**',
          lines.join('\n'),
        ].join('\n');
      }

      const providerArg = (args[0] || '').toLowerCase();
      const byIndex = /^\d+$/.test(providerArg) ? providers[Number(providerArg) - 1] : null;
      const target =
        byIndex ||
        providers.find((p) => p.id === providerArg || p.name.toLowerCase() === providerArg) ||
        null;

      // Solo el provider, sin key: hint de sintaxis (sin flujo de espera).
      if (args.length === 1) {
        return target
          ? `Pegá la key: /credenciales ${target.id} <tu-key>`
          : `No existe el proveedor \`${providerArg}\`. Escribí \`/credenciales\` para ver la lista.`;
      }

      if (!target)
        return `No existe el proveedor \`${providerArg}\`. Escribí \`/credenciales\` para ver la lista.`;

      const apiKey = (args[1] || '').trim();
      if (!apiKey) return `Pegá la key: /credenciales ${target.id} <tu-key>`;

      // Guardado directo vía el mismo camino que el modal (KeychainManager).
      if (!ctx.ipcRenderer) return 'No hay IPC disponible para guardar la key.';
      try {
        await ctx.ipcRenderer.invoke('save-llm-keys', {
          providers: { [target.id]: apiKey },
          useKeychain: true,
          models: {},
        });
        return `✓ API key de **${target.name}** guardada.`;
      } catch (e) {
        return `Error guardando la key: ${e.message}`;
      }
    },
  });
};
