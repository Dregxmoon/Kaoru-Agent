# Integración nativa con Git (`core/git/`)

Operaciones de Git del agente **sin depender de `exec` crudo**: un wrapper tipado
sobre `git` que valida entrada (ramas, paths), parsea salida y normaliza errores.
Las tools del agente (`git_status`, `git_diff`, …) se despachan desde
`core/planner/AgentLoop.js` hacia `GitManager` en vez del puente OpenClaw.

---

## `GitManager.js` — wrapper de git

| Método | Operación | Notas de seguridad |
|---|---|---|
| `getRepoRoot(cwd)` | `git rev-parse --show-toplevel` | falla si `cwd` no existe / no es dir |
| `isRepo(cwd)` | ¿`cwd` está dentro de un repo? | no lanza, devuelve `false` |
| `status(cwd)` | `git status --porcelain=v1 -b` | parsea staged / unstaged / untracked / conflictos / ahead-behind |
| `diff(cwd, {file, staged})` | `git diff [--staged] [-- file]` | `file` validado (sin globs peligrosos) |
| `log(cwd, {count, file})` | `git log --oneline` | límite `count` acotado |
| `branch(cwd)` | `git branch` (rama actual + lista) | — |
| `add(cwd, paths)` | `git add` | `paths` pasa por `_validPaths` |
| `commit(cwd, {message})` | `git commit -m` | mensaje no vacío; *mutador → requiere aprobación* |
| `stash(cwd, {action, message})` | `git stash push/list/pop` | `action` en allowlist |
| `merge(cwd, {branch, message})` | `git merge` | `branch` valida `_validBranch`; detecta conflictos |
| `rebase(cwd, {branch})` | `git rebase` | `branch` validada |
| `push(cwd, {remote, branch, force})` | `git push` | `force` nunca se auto-habilita; requiere aprobación |

### Validación de entrada

- `SAFE_BRANCH_RE` (`/^[A-Za-z0-9._/-]{1,200}$/`): ramas sin espacios, sin `..`,
  sin `-` inicial (evita flags).
- `_validPaths`: solo paths planos, sin `../`, sin `~`.
- `_assertDir`: toda operación exige un `cwd` real.
- Errores normalizados con `_toError` (mensaje, `exitCode`, `gitOutput`, `gitStderr`).

### Push con token

`push` resuelve credenciales vía `_resolveToken` + `_writeAskpass` (token del
`KeychainManager`), con limpieza `_cleanupAskpass` en `finally`. Así el agente
puede `git push` en remotos HTTPS sin dejar credenciales en `~/.git-credentials`.

---

## Cómo se integra

1. `AgentLoop._executeGitTool` (`core/planner/AgentLoop.js`) recibe `git_*` y llama al `GitManager`.
2. `AgentLoop.GIT_TOOLS` define el set: `git_status, git_diff, git_log, git_branch, git_commit, git_stash, git_merge, git_rebase, git_push`.
3. Los sensores proactivos de higiene del repo (`GitWatcher`) consumen `status()`
   para detectar `.env` sin ignorar, conflictos y commits sin push.
4. Los mutadores (`commit`, `merge`, `rebase`, `push`, `add`) marcan alto impacto
   en `ActionParser.isHighImpact` → requieren aprobación explícita del usuario.

## Verificación

`tests/test_git_manager.js`, `tests/test_agent_loop_git.js` — ver `tests/README.md`.
