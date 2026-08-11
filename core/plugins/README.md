# Plugins locales (`core/plugins/`)

Carga plugins del usuario desde `plugins/<nombre>/` (un `plugin.json` + `index.js`) y los registra
como herramientas `plugin.<nombre>.<tool>` y hooks del pipeline. Un fallo de carga **nunca** bloquea
el arranque: se loguea y se salta.

## `PluginManager.js`

Singleton (`getPluginManager`) que gestiona el ciclo de vida: carga, registro de tools en el
`AgentLoop`, suscripción de hooks (`beforeAgentRun`, …) y `dispose()` ordenado al cerrar.

## `PluginSandbox.js`

Aislamiento de ejecución: el `index.js` del plugin corre en un contexto `vm` de V8 con un `require`
**mediado** — whitelist de builtins + un `fs` restringido al directorio del plugin (anti
path-traversal). Es una capa de contención, no una frontera criptográfica.

## `PluginMarketplace.js`

Marketplace local **firmado**: `PluginSigner` crea claves Ed25519, firma paquetes (manifiesto menos
la firma + sha256 de todos los archivos); `install()` verifica la firma de `index.json` y la huella
de cada paquete antes de copiar a `plugins/`.

## `PluginSigner.js`

`generateKeyPair` / `signPlugin` / `verifyPlugin` — firma/verificación Ed25519 de paquetes de
plugins (requisito del pipeline firmado del marketplace).

## Etiqueta

```
core/plugins
        ├── PluginManager.js      # Carga, registro de tools y hooks
        ├── PluginMarketplace.js  # Instalación firmada (Ed25519 + sha256)
        ├── PluginSandbox.js      # vm aislado + require mediado (fs confinado)
        ├── PluginSigner.js       # Firma/verificación de paquetes
        └── README.md
```

Verificación: `test_plugin_manager`, `test_plugin_hooks_live`, `test_plugin_sandbox`.
