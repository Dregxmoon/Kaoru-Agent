# Revisión interna de seguridad: 14 de septiembre de 2026

**Alcance:** lectura de caminos de Electron/IPC, permisos, sandbox Linux/Windows, ejecutor, plugins,
MCP, navegador, rutas y recuperación. Se ejecutaron pruebas focales después del cambio. Esta es una
revisión **interna**: todavía hace falta una revisión externa independiente, especialmente en Windows
y macOS. Los hallazgos indican precondición, impacto, mitigación y prueba pendiente.

## Hallazgos

### Alto · canal IPC heredado permitía mutar Git sin aprobación del agente — corregido

En `ipc/init-vectors-handlers.js`, el canal `exec-command` permitía exactamente
`git reset --soft HEAD~1`. `src/chat/preload.js` lo exponía al renderer y `/undo` en
`core/commands/dev.js` lo invocaba. **Precondición:** una llamada desde el chat, manual o desde un
renderer comprometido. **Impacto:** cambiar el HEAD del repositorio de la aplicación fuera de
`AgentLoop`, `PermissionManager` y su tarjeta de consentimiento; los archivos seguían en staging,
pero el historial Git se alteraba. **Mitigación anterior:** allowlist de strings exactos que impedía
inyección de shell, pero no imponía permiso sobre esta mutación. **Confianza:** alta, ruta ejecutable
confirmada por código.

**Corrección:** la allowlist conserva lectura del último commit y lint; `/undo` dirige a
`/revertir-tarea` y no ejecuta `reset`. Probar que el handler rechaza el string antiguo y conserva
los comandos de lectura es obligatorio antes de release.

### Medio · Linux degrada el sandbox de comandos si `bwrap` falta — riesgo residual

En `openclaw-server.js:_initSandbox`, sin `bwrap` o con self-test fallido, el servidor puede
continuar con `_sandboxEnabled=false`. **Precondición:** Linux sin namespaces/bubblewrap funcionales y
una ejecución permitida por política. **Impacto:** el comando tiene más acceso al host que en el
perfil aislado, pese a los controles de herramienta/ruta. **Mitigación:** detección del estado efectivo
en `/health`, política de permisos, `PathGuard` para herramientas de archivos. **Confianza:** alta para
la degradación, impacto dependiente del comando autorizado.

**Propuesta:** advertencia visible antes de ejecutar y opción fail-closed para instalaciones que lo
requieran; tests en host sin `bwrap`. El sandbox del renderer de Electron no sustituye este aislamiento.

### Medio · aprobación depende de la integridad del renderer — defensa adicional pendiente

`ipc/openclaw-handlers.js` resuelve `agent-approval-response` según el `actionId` sin comprobar el
`event.sender` contra la ventana de chat activa. **Precondición:** un renderer con acceso a ese canal
o ejecución de script dentro del chat y conocimiento del `actionId` recibido. **Impacto:** una página
de chat comprometida puede simular una aceptación; la tarjeta sola no prueba que hubo clic humano.
**Mitigación:** scripts y navegación locales, `contextIsolation`, preload con allowlist, identificador
aleatorio, timeout y rechazo de approvals expirados. **Confianza:** alta para ausencia de validación
de emisor; explotación remota directa no demostrada.

**Propuesta:** validar `event.sender === chatWindow.webContents` y asociar aprobación a run, acción y
params inmutables; test con segundo emisor IPC. El compromiso del propio chat requiere aislamiento
y tratamiento de contenido externo aunque se valide el emisor.

### Medio · control de navegador/desktop y plugins necesitan evaluación externa

`IrreversiblePolicy.js` reconoce transacciones por texto/ruta y comandos destructivos, pero documenta
que no infiere un pago oculto tras coordenadas ni todos los idiomas. Plugins y MCP extienden la
superficie de ejecución. **Precondición:** UI no accesible, resultado externo malicioso o extensión de
terceros con permisos. **Impacto:** acción más amplia que la intención del usuario o salida del modelo
tratada como instrucción. **Mitigación:** política allow/ask/deny, wraps de contenido no confiable en
rutas revisadas, navegador administrado con perfil separado, preferencias `Always` y autoApprove
bloqueadas para acciones irreversibles reconocidas. **Confianza:** alta para límite declarado, sin
vulnerabilidad universal demostrada.

**Propuesta:** revisar conectores uno por uno, prueba de compra simulada con controles visuales y
consentimiento ligado a tarea/host/aplicación. No prometer inmunidad frente a prompt injection.

## Superficies positivas verificadas y límites

- `main.js` crea renderers con `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` y
  `webSecurity:true`; navegación remota y `window.open` se bloquean. El canal IPC debe verificarse
  por handler, no únicamente por allowlist.
- `PathGuard.js` resuelve ancestros reales para rutas inexistentes y rechaza escapes por symlink en
  los paths donde se aplica. Entre validación y uso quedan posibles carreras; comandos y extensiones
  tienen otros límites de filesystem.
- Windows AppContainer documenta rechazo de comandos si la inicialización falla; macOS no tiene
  sandbox adicional del ejecutor. Estos paths no se ejercitaron localmente en esta revisión.
- Credenciales de LLM se resuelven por keychain/config/entorno; las transferencias de contexto al
  proveedor elegido siguen siendo parte de la función, no datos confinados al equipo.
- Checkpoint y verificación son mecanismos distintos; cambios remotos y efectos externos no quedan
  dentro de un rollback transaccional.

## Pendientes antes de una edición de pago

1. Revisar y corregir riesgos de alto impacto en una auditoría externa con reproducibles redactados.
2. Validar Linux con y sin `bwrap`, AppContainer real en Windows y paths/IPC en macOS.
3. Publicar evidencia de testers independientes sin credenciales ni datos privados.
4. Confirmar que una aprobación y su preview describen la acción realmente ejecutada.

Canal para reportes privados y acuerdos de divulgación: [`SECURITY.md`](../SECURITY.md).
