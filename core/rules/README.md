# Reglas de proyecto (`core/rules/`)

Inyecta las reglas del proyecto (`.cursorrules`, `CLAUDE.md`, `AGENTS.md`) en el system prompt de
**todos** los modos del agente, de forma automática.

## `ProjectRules.js`

- `readProjectRules(workspace)` — busca y lee los archivos de reglas del workspace activo con
  precedencia **AGENTS.md > CLAUDE.md > .cursorrules**.
- `buildRulesSection(...)` — ensambla la sección de reglas del system prompt, truncada a
  `MAX_RULES_CHARS` (6000).
- `clearRulesCache()` — invalida el cache (por `(workspace, mtime)`); se llama al cambiar de
  workspace (`core/core/workspace.js`) y en tests.

## Etiqueta

```
core/rules
        ├── ProjectRules.js   # Lectura, precedencia y sección del prompt
        └── README.md
```

Verificación: `test_project_rules`.
