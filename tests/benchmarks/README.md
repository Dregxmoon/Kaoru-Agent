# Benchmark de éxito de tareas — Kaoru

Distinto del resto de `tests/`: esas suites verifican módulos aislados (con mocks o con la pieza
real de producción). Esto mide **comportamiento end-to-end de la app corriendo de verdad**, contra
LLMs reales, con toda la variabilidad que eso implica — igual que las pruebas manuales de hoy, pero
con criterios objetivos en vez de lectura a ojo.

## Cómo correrlo

1. Arrancá la app normalmente.
2. Pegá cada prompt de `scenarios.json` en el chat, uno a la vez (podés saltear los que no
   apliquen a esa sesión — T04 solo dispara si el log muestra fallback a texto sin tools).
3. Por cada uno, guardá en un archivo `runs/<algo>.json` un array con:
   - `scenario_id` — el id de `scenarios.json`.
   - `log` — el fragmento de terminal correspondiente a ese turno (buscá la línea
     `agent-run-metrics` como ancla, es la más importante).
   - `response_text` — lo que Kaoru respondió en el chat (para T03/T04/T06/T07).
   - `response_text_per_turn` — array de respuestas, solo para T08 (secuencia de 3 turnos).
4. `node tests/benchmarks/grade_run.js tests/benchmarks/runs/<algo>.json`

## Por qué semi-manual y no 100% automatizado

Automatizarlo del todo requeriría poder mandarle mensajes al chat real programáticamente (no solo
al AgentLoop con mocks, que es lo que ya hace `tests/e2e/test_chat_to_agent_loop.js`) y capturar la
respuesta — ahí entra en juego el costo/latencia real de los providers. Vale la pena si esto se
corre seguido; por ahora, pegar log + respuesta a mano es rápido y ya da resultados objetivos, no
solo impresión subjetiva.

## Ejemplo

`runs/ejemplo-sesion-hoy.json` tiene dos entradas armadas con el log real de la sesión de prueba de
hoy (el caso del directorio `pacman/` fantasma y el `git_stash` disparado por lenguaje figurado).
Corré `node tests/benchmarks/grade_run.js tests/benchmarks/runs/ejemplo-sesion-hoy.json` para ver
cómo se ve un resultado en rojo — sirve como referencia de formato.

## Agregar un escenario nuevo

1. Agregalo a `scenarios.json` con `id`, `category`, `prompt`, `success_criteria`, `grading`.
2. Escribí la función `gradeTNN(entry, ctx)` en `grade_run.js` — debe devolver
   `{ pass: true|false|null, detail: string }` (`null` = no aplica a esta entrada).
3. Registrala en el objeto `GRADERS` al final del archivo.

## Limitación conocida

Los patrones de `FABRICATION_TOOL_PATTERNS` y `LITERAL_FEELING_PATTERNS` son heurísticas de texto,
no comprensión semántica — igual que cualquier regex, van a tener falsos negativos si Kaoru fabrica
o cede el límite con palabras distintas a las que ya vimos. Cuando aparezca un caso nuevo que el
grader no cache, agregá el patrón — este catálogo crece con lo que se va encontrando, no pretende
ser exhaustivo desde el día uno.