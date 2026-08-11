# Configuración (`core/config/`)

Carga, validación y cache de `config.json` contra un **schema tipado** — la fuente única de
configuración del asistente.

## `ConfigManager.js`

`class ConfigManager` + `SCHEMA` + `validateConfig`:

- Carga `config.json` (en `~/.config/vtuber-overlay/` según SO), valida contra el schema y aplica
  **defaults** para claves ausentes o con valores inválidos; loguea _warning_ en claves top-level
  desconocidas (para no romper configuraciones nuevas).
- Devuelve **clones profundos** (nadie muta la cache) y expone `save()` / `reload()`.

El acceso por dominio sigue siendo directo y por partes: configuración de LLM/MCP/sensores/autonomía
desde `core/core/config.js` (`loadLLMConfig`, `reloadLLMConfig`, `readSensorsConfig`), que mergea las
claves provenientes del llavero del sistema (`infrastructure/keychain/`).

Verificación: `test_config_schema`.
