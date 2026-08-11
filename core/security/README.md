# Seguridad y permisos (`core/security/`)

Control granulado de qué herramientas puede usar el agente, sobre qué rutas y con qué nivel de
consentimiento, en el patrón de opencode: `allow` / `ask` / `deny`.

## `PermissionManager.js`

`class PermissionManager` — reglas **allow/ask/deny por tool + path**, persistidas en JSON
(never-throw; cae a memoria si la escritura falla y nunca rompe el arranque).

Resolución por especificidad, de más a menos concreta:

1. tool + prefijo de ruta exacto
2. tool exacta
3. `*` + ruta
4. `*` (global)
5. default (configuración)

Las reglas se gestionan desde el panel de permisos del chat y la Control API
(`core/core/permissions.js`: `permissionsSetRule` · `permissionsRemoveRule` · `permissionsList`).

## Etiqueta

```
core/security
        ├── PermissionManager.js   # Reglas allow/ask/deny por tool+path
        └── README.md
```

Verificación: `test_server_security`, `test_untrusted_content`. Juntos con la whitelist/blocklist de
rutas sensibles confinan las herramientas del agente al workspace activo.
