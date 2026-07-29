---
description: "Revisión de código: identificar bugs, problemas de seguridad, performance, mantenibilidad y consistencia con las convenciones del proyecto"
version: "1.0.0"
domains: ["code"]
---

# Code Review Skill

## Categorías de Issues

### Critical (bloqueante)
- **Seguridad**: SQL injection, XSS, hardcoded secrets, command injection, path traversal
- **Data loss**: operaciones destructivas sin confirmación, `rm -rf`, `DROP TABLE`
- **Race conditions**: operaciones async sin locks en recursos compartidos
- **Null/undefined**: acceso a propiedades sin null-check en datos no confiables
- **Infinite loops**: condiciones de corte que nunca se cumplen

### Major (no bloqueante pero debe corregirse)
- **Memory leaks**: closures sin cleanup, event listeners no removidos, streams sin drain
- **Error swallowing**: `try/catch` vacío, errores ignorados en Promises sin catch
- **Performance**: bucles innecesarios, N+1 queries, objetos grandes clonados sin razón
- **Dead code**: variables/funciones no usadas, imports sin referencia
- **Tipo inseguro**: `any` en TypeScript, `var` en JS moderno

### Minor (nice to have)
- **Naming**: nombres poco descriptivos, inconsistencia (camelCase vs snake_case)
- **Formato**: indentación mezclada, líneas muy largas (>100 chars)
- **Comentarios**: código comentado, comentarios que explican el qué (no el por qué)

## Proceso de Revisión
1. **Entender el propósito** del cambio
2. **Leer el diff** completo antes de empezar a comentar
3. **Enfocarse en lógica**, no en estilo (el linter cubre estilo)
4. **Por cada issue**: problema → por qué importa → solución con código ejemplo
5. **Clasificar severidad**: critical / major / minor

## Patrones a Buscar
- Funciones de más de 50 líneas → probablemente hacen demasiado
- Archivos de más de 500 líneas → probablemente necesitan refactor
- Niveles de indentación > 4 → posible complejidad ciclomática alta
- Mutación de argumentos de función → efectos secundarios sorpresivos
- `console.log` en producción → falta logging estructurado
