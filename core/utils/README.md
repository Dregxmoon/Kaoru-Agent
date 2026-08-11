# Helpers compartidos (`core/utils/`)

Utilidades sin dependencias usadas por varios módulos del núcleo. **Una sola política de entorno para
procesos hijos** y una sola lista de directorios a ignorar.

## `childEnv.js`

- `safeChildEnv(extra)` — para herramientas propias: env estándar (whitelist + filtro) con las
  variables que parezcan credenciales eliminadas.
- `minimalChildEnv(extra)` — para terceros: solo `PATH`/`HOME` + las variables declaradas.

## `format.js`

`formatElapsed(seconds)` — duración legible ("Xs · Xm · Xh Ym"), usada por los serializers de
contexto y los bloques de actividad del agente.

## `fsUtils.js`

- `readJsonFile(filePath, fallback)` — lectura JSON never-throw.
- `appendJsonLine(filePath, obj)` — append JSONL never-throw.
- `delay(ms)` — promesa de espera.

## `ignoreDirs.js`

`PROJECT_IGNORE_DIRS` + `dirSet(extras)` / `dirRegexes(extras)` — la lista central de directorios a
ignorar en búsquedas/reconocimiento (`node_modules`, `dist`, `build`, …), en forma de nombres exactos
y de segmentos de ruta.

## Etiqueta

```
core/utils
        ├── childEnv.js   # Env seguro para procesos hijos
        ├── format.js     # formatElapsed
        ├── fsUtils.js    # JSON/JSONL never-throw + delay
        ├── ignoreDirs.js # Directorios a ignorar (exacto + regex)
        └── README.md
```
