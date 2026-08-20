# Seguridad — hallazgos y seguimiento

Documento de seguimiento de hallazgos de seguridad y módulos desconectados
detectados en la auditoría (aug 2026). Severidades confirmadas con reproducción.

## Leyenda

| Severidad | Significado                                                |
| --------- | ---------------------------------------------------------- |
| CRITICA   | RCE remoto o exfiltración sin interacción del usuario      |
| ALTA      | Exfiltración con interacción mínima (mensaje de chat)      |
| MEDIA     | Higiene de credenciales / fuga a terceros sin acceso local |
| BAJA      | Cosmético o requiere otro exploit previo                   |

## Hallazgos

### S1 — FileResolver: path traversal sin contención (ALTA — FIXEADO)

- **Archivos:** `core/commands/FileResolver.js` (resolución de `@archivo`),
  `ipc/chat-handlers.js` (`chat-files-context`/`chat-files-list`).
- **Vulnerabilidad:** `@../../../../etc/passwd` desde un mensaje normal del chat
  resolvía a `/etc/passwd` y el contenido completo se inyectaba al contexto LLM
  (`src/chat/process.js:194-203` → `_compressHistory` → `grounding-build-context`
  → `complete()`), exfiltrándolo al proveedor LLM.
- **Alcance:** alcanzable sin renderer comprometido; requiere que el usuario
  escriba el ref (no remota). Local → proveedor externo.
- **Fix (Cambio 2):** nuevo `core/security/PathGuard.js` (lógica compartida con
  `openclaw-server.js`, sin duplicación) + contención de refs contra el
  workspace real (`getWorkspace() || process.cwd()`) con realpath (cierra escape
  por symlink). El cwd del renderer ya no se confía: solo se acepta dentro del
  root. Tests: `tests/test_file_resolver.js` (34/34, casos traversal, `@../`
  dentro, cwd externo).

### S2 — API key de Gemini en query string (MEDIA — FIXEADO)

- **Archivo:** `core/llm/LLMProvider.js` (callGeminiProvider y callGeminiWithTools).
- **Vulnerabilidad:** la clave viajaba en el query string (`?key=${key}`) de la
  request HTTPS directa a `generativelanguage.googleapis.com` (sin proxy).
  Confirmado que **salía de localhost**. No se logueaba localmente (Logger no
  registra URLs).
- **Impacto previo:** la key quedaba en logs de Google / infraestructura de red
  intermedia (los proxies y servidores registran URLs completas, no headers).
- **Evidencia ANTES (reproducido):** URL armada como
  `.../models/${model}:generateContent?key=${key}${stream ? '&alt=sse' : ''}`
  con headers `{}` (LLMProvider.js:1000 y :1429).
- **Fix (Cambio 3):** la key se mueve al header `x-goog-api-key` (método
  documentado por Google — "All requests to the Gemini API must include a
  `x-goog-api-key` header", ai.google.dev/api). La URL queda
  `.../models/${model}:generateContent${stream ? '?alt=sse' : ''}` y el header
  `{ 'x-goog-api-key': key }`. Aplicado en AMBOS callers (texto plano y
  tool-calling), en streaming (alt=sse) y no-streaming.
- **Evidencia DESPUÉS:** `tests/test_gemini_key_header.js` (10/10) levanta un
  servidor local que captura `req.url` + `req.headers` y verifica que en ningún
  request la key aparece en la URL (`?key=` ausente) y que el header
  `x-goog-api-key` llega con la key, tanto en streaming como no-streaming.

### S3 — Código muerto / módulos desconectados (documentado, fuera de alcance)

- `core/llm/recommend.js` — huérfano (solo tests lo referencian).
- Exports sin consumidores: `removeCustomProvider`, `buildOSContext`,
  `deriveModelCatalog`, `ROLE_ALIASES`.
- `migrateApiKeysToKeychain` (LLMProvider.js:302) duplicado sin llamador vs
  `migratePlaintextApiKeysToKeychain` (main.js:300).
- 17 exports `_debug_*` solo para tests.

### S4 — Otros hallazgos de seguridad (documentado, fuera de alcance)

- Sandbox `bwrap` solo Linux.
- Renderer comprometido ≈ RCE (`chat-tts-stream`/`chat-asr-stream` con
  `pythonBin`).
- `PluginManager.requireSigned:false`.
- API keys en claro en `config.json` sin llavero (opcional por
  `KeychainManager`).

## Cambios aplicados

- **Cambio 1 (completado):** eliminado `core/grounding/serializers/GeminiOpenAISerializer.js`
  (no-op). `ContextAssembler` usa solo `GroqSerializer` con fallback. Tests 30/30.
- **Cambio 2 (completado):** contención de FileResolver vía `PathGuard`.
- **Cambio 3 (completado):** fix de S2 — API key de Gemini en header
  `x-goog-api-key` (ambos callers, streaming y no-streaming). `tests/test_gemini_key_header.js` 10/10.
