# Agente de código de Kaoru

Este documento describe el flujo ejecutado por Kaoru para una tarea de ingeniería. La interfaz
Live2D es la presencia del producto; la autoridad sobre archivos, procesos y servicios permanece en
las capas de política y ejecución.

## Flujo conectado

1. `Core.runAgent` registra o retoma un objetivo durable en el workspace activo.
2. `RepositoryIntelligence` indexa metadatos del repositorio de forma asíncrona: archivos,
   dependencias locales, manifiestos, scripts y candidatos relacionados con la petición.
3. `SymbolIndex` añade símbolos LSP cuando el servidor del lenguaje está disponible.
4. `AgentLoop` crea o retoma un plan con criterios observables y ejecuta una herramienta por ciclo.
5. `PermissionManager` y la aprobación IPC resuelven `allow`, `ask` o `deny` fuera del LLM.
6. `WorkspaceCheckpoint` captura la línea base antes de la primera mutación que puede identificar.
7. Cada resultado real alimenta el ledger del plan, la memoria de trabajo y el siguiente turno.
8. Al cerrar, el índice recalcula el impacto de los archivos mutados. Las pruebas focales reconocidas
   se ejecutan antes de la verificación general del proyecto.
9. Un fallo verificable puede volver al loop para reparación. Si no se resuelve, la tarea queda activa
   con su punto de reanudación; el texto del modelo no puede cerrarla por sí solo.

## Persistencia y privacidad

El índice estructural se guarda en el directorio de datos de la aplicación para reutilizarlo entre
corridas. Contiene rutas relativas, tamaños, fechas y aristas de dependencias; no guarda contenido
fuente. Omite enlaces simbólicos, dependencias vendorizadas, builds, cachés y nombres comunes de
credenciales. Cualquier mutación observada lo invalida.

Los objetivos, pasos, criterios, estados y evidencias se almacenan en `StateGraph` cuando SQLite está
disponible. En modo de respaldo en memoria no sobreviven al cierre del proceso.

## Verificación

La selección focal es conservadora:

- Relaciona tests por dependencias transitivas y nombres de archivo.
- Solo construye comandos focales para runners que conoce explícitamente; actualmente
  `tests/run-all.sh`.
- No sustituye `typecheck`, `lint`, `test` o `build` configurados. Los antepone para obtener feedback
  temprano y luego conserva el sello general.
- El resultado incluye archivos cambiados, dependientes, pruebas relacionadas y riesgo estimado.

Un checkpoint no convierte efectos remotos, comandos arbitrarios o cambios externos al workspace en
una transacción reversible. Verificación y rollback son capacidades separadas.

## Subagentes

Los perfiles de investigación `read_only` pueden correr en paralelo. Un subagente con herramientas de
mutación se ejecuta de forma serial y hereda permisos, verificación y checkpoint. No hay escritura
paralela anunciada: faltan worktrees aislados, importación de parches y fusión con detección de
conflictos. Mantener ese límite evita que dos agentes sobrescriban el mismo árbol.

## Escritorio, visión y voz

Las capturas de navegador o escritorio se transportan como contenido multimodal cuando el proveedor
seleccionado admite visión. La acción semántica usa AT-SPI2 en Linux o UI Automation en Windows; un
clic visual se liga a una captura efímera y obliga a observar de nuevo.

La interfaz de chat ofrece voz de salida mediante TTS. La entrada por micrófono no está disponible
en la interfaz actual. El código de transcripción local con Vosk permanece como capacidad interna,
sin escucha ambiental permanente.

## Límites actuales

- macOS no tiene paridad de automatización semántica con Linux y Windows.
- La visión depende de que el modelo configurado acepte imágenes.
- Runners de pruebas desconocidos requieren configuración manual para un comando focal seguro.
- Los escritores paralelos continúan deshabilitados hasta disponer de aislamiento y fusión verificable.
- Los efectos fuera del workspace pueden no ser reversibles aunque su ejecución esté autorizada.

Estas limitaciones son deliberadamente visibles: Kaoru debe conservar una tarea pendiente cuando no
puede demostrar su terminación.
