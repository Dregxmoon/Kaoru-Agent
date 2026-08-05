# Integración con GitHub (`core/github/`)

Cliente REST nativo de GitHub para el agente — tool propia (no `exec` crudo).
Cubre issues, pull requests y acciones de CI. Toda respuesta mutadora pasa por
aprobación explícita; el transporte de red es inyectable para tests herméticos.

---

## `GitHubManager.js` — cliente REST

| Método | Recurso | Alto impacto |
|---|---|---|
| `whoami()` | usuario autenticado | no |
| `repoInfo(repo)` | metadatos del repo | no |
| `issueList(repo, {state, limit})` | issues abiertos/cerrados | no |
| `issueCreate(repo, {title, body, labels})` | crear issue | **sí** |
| `issueComment(repo, {issue_number, body})` | comentar issue | **sí** |
| `issueClose(repo, {issue_number})` | cerrar issue | **sí** |
| `prList(repo, {state, limit})` | PRs | no |
| `prCreate(repo, {title, head, base, body})` | crear PR | **sí** |
| `prReview(repo, {pull_number, event, body})` | aprobar/requerir/comentar | **sí** |
| `actionsStatus(repo, {limit})` | runs de Actions | no |

- `MAX_LIST = 30` acota listas; `_httpError` traduce 401/403/404 a mensajes accionables.
- Validaciones: `SAFE_REPO_RE` (`owner/repo`), `SAFE_REVIEW_EVENTS`
  (`APPROVE | REQUEST_CHANGES | COMMENT`), `SAFE_ISSUE_STATE` / `SAFE_PR_STATE`,
  `VALID_LABEL_RE`.
- Credencial: PAT bajo la key `github_token` del `KeychainManager`. Resolución
  aislada en `_resolveToken()` para permitir el futuro flujo OAuth sin tocar las tools.

## `OAuthDeviceFlow.js` — conexión de cuenta (device flow)

| Método | Rol |
|---|---|
| `start(scope)` | pide `device_code` y `user_code` (imprime la URL de verificación) |
| `poll(deviceCode)` | consulta el token mientras el usuario autoriza (intervalo + expiración) |

Permite vincular la cuenta de GitHub desde el chat (`/github login`) sin
exponer el PAT; el token resultante se guarda en el llavero.

## `net.js` — transporte

`getRendererFetch()` devuelve `fetch` usable desde el renderer de Electron
(entorno de la app), inyectable en el manager para pruebas.

---

## Cómo se integra

1. `AgentLoop.GITHUB_TOOLS` define el set despachado a `_executeGitHubTool`:
   `github_repo_info, github_issue_list, github_issue_create, github_issue_comment,
   github_issue_close, github_pr_list, github_pr_create, github_pr_review, github_actions_status`.
2. Sin token → la tool devuelve error explícito con instrucción de configuración.
3. Comando de chat `/github` (ver `core/commands/github.js`) enlaza la UI con el manager.
4. `ActionParser.isHighImpact` marca como mutadoras las tools que crean/comentan/cierran.

## Verificación

`tests/test_github_manager.js`, `tests/test_github_command.js`,
`tests/test_oauth_device_flow.js`, `tests/test_agent_loop_git.js` — ver `tests/README.md`.
