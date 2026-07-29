---
description: "Operaciones con git: commits, branches, merges, rebase, resolución de conflictos, y flujo de trabajo recomendado para el proyecto"
version: "1.0.0"
domains: ["git"]
---

# Git Workflow Skill

## Commit Messages
Usar **Conventional Commits**:
- `feat:` — nueva funcionalidad
- `fix:` — corrección de bug
- `chore:` — tareas de mantenimiento
- `docs:` — documentación
- `refactor:` — refactorización sin cambio funcional
- `test:` — tests
- `style:` — formato, whitespace

Formato:
```
<tipo>(<scope opcional>): <descripción corta (max 50 chars)>

<opcional: cuerpo con motivación y contexto>
```

## Branch Strategy
- `main` — código listo para producción
- `develop` — integración
- `feature/<nombre>` — nuevas features
- `fix/<nombre>` — bug fixes

## Operaciones Seguras vs. Peligrosas

### Seguras (no requieren aprobación extra)
- `git status`, `git log`, `git diff`
- `git add <file>`
- `git commit`
- `git branch` (crear, listar)
- `git checkout <branch>` (si no hay cambios sin commit)
- `git stash`
- `git fetch`

### Requieren aprobación
- `git push --force` / `git push origin +branch`
- `git reset --hard`
- `git rebase` (reescribe historia)
- `git merge --no-ff` (merge condicional)
- `git revert` (cambia historia remota)
- `git clean -fd`

## Resolución de Conflictos
1. `git merge <branch>` → si hay conflicto, `git status` muestra los archivos
2. Leer ambas versiones (ours/theirs)
3. Editar para resolver
4. `git add <file>` + `git commit`
5. Verificar con `git log --oneline -5`
