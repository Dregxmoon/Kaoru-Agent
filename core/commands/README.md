# Comandos (`core/commands/`)

Registro de comandos de chat al estilo `/comando` — el mecanismo para operar March sin depender del
procesamiento de lenguaje natural.

---

## `CommandRegistry.js`

Centraliza el registro, búsqueda y ejecución de comandos. Cada comando tiene:

| Campo | Descripción |
|---|---|
| `id` | Identificador único |
| `category` | Agrupación en la UI (General, Memoria, Sistema, …) |
| `usage` | Sintaxis de uso mostrada al usuario |
| `description` | Qué hace el comando |
| `handler` | Función ejecutora (IPC + lógica) |

Comandos incluidos (entre otros): `/help`, `/model` (cambio de proveedor LLM), `/olvida`,
`/telemetria`, comandos de memoria y de estado del sistema.

## `FileResolver.js`

Resuelve rutas de archivo referidas en comandos y mensajes, con normalización segura (relativas al
workspace activo, sin escapes de directorio).

---

## Integración

`MarchCore` registra los comandos durante `init()`; la UI (`src/chat.html`) detecta mensajes que
empiezan con `/`, los resuelve en `CommandRegistry` y renderiza el resultado directamente.

## Verificación

`test_commands` (97 tests) — registro, ejecución, resolución de archivos y contratos IPC.
