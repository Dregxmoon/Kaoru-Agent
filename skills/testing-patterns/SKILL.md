---
description: "Patrones y convenciones para escribir tests en este proyecto: estructura de archivos, helpers, assertions, mocks, y ejecución"
version: "1.0.0"
domains: ["code", "test"]
---

# Testing Patterns Skill

## Convención de Tests
- Tests planos en Node.js (sin framework externo: no Jest, Mocha, Vitest)
- Helper global inline:
```js
const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};
let passed = 0, failed = 0;
function assert(condition, label, detail = '') { ... }
```
- Cada archivo en `tests/test_<nombre>.js`
- Ejecutar con `node tests/test_<nombre>.js`

## Patrón de Test por Módulo
1. Tests de funciones individuales (unitarias)
2. Tests de integración (combinación de módulos)
3. Casos borde (null, undefined, vacío, valores extremos)
4. Regresión (bugs ya corregidos)

## Mocking
- Para módulos internos: reemplazar con objetos planos inline
- Para LLM/API externas: funciones que devuelven respuestas fijas
- Para sistema de archivos: directorios temporales con `fs.mkdtempSync()`, cleanup con `fs.rmSync(dir, { recursive: true, force: true })`

## Cobertura Mínima por Feature
- Happy path: flujo normal
- Error path: cada posible error
- Edge cases: valores límite, vacío, nulo
- Concurrencia si aplica: llamadas paralelas, estados inconsistentes

## Integración con CI
- Todos los tests pasan antes de mergear
- Los tests no requieren red, API keys, ni GPU
- Usar `assert` simple, no librerías externas de aserción
