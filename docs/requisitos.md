# Requisitos de hardware de Kaoru

Estas cifras son **mínimos provisionales**, no una certificación multiplataforma. Se basan en una
medición local de Linux x64 y en el tamaño de una carpeta empaquetada. Una tarea real, Chromium,
modelos de voz o LLM local pueden aumentar mucho el consumo. Faltan muestras en equipos externos,
Windows y macOS antes de llamar a estos requisitos definitivos.

| Experiencia | RAM mínima provisional | RAM recomendada | CPU mínima / recomendada | Disco libre mínimo / recomendado | GPU |
| --- | --- | --- | --- | --- | --- |
| CLI de agente y conversación (`npm run cli -- chat`) sin ventanas, voz ni avatar | 4 GB | 8 GB | 2 núcleos / 4 núcleos | 2 GB / 4 GB al instalar desde fuente | No requiere GPU dedicada; LLM remoto o endpoint local aparte. |
| Aplicación de escritorio con chat, memoria y Live2D; voz opcional | 8 GB | 16 GB | 2 núcleos / 4 núcleos | 3 GB / 5 GB para instalación y cachés | No requiere GPU dedicada: probada con renderizado por software; se recomienda aceleración gráfica para el avatar. |

Una GPU puede ser necesaria **para el modelo local elegido**, no para el agente con proveedor remoto.
Su VRAM y memoria de sistema dependen del modelo y del motor de inferencia: no hay un requisito
universal verificable de Kaoru para LLM local. Vosk utiliza un modelo ASR separado; el tamaño y el
consumo de ese modelo dependen del idioma y deben medirse antes de anunciar un mínimo para voz.

Los binarios actuales se generan para Windows x64, Linux x64, macOS x64 y macOS arm64. En macOS no
hay paridad de controles semánticos de escritorio y el paquete actual no está firmado ni notarizado.
En Linux, ciertas aplicaciones necesitan AT-SPI2 y los comandos usan `bwrap` cuando está disponible;
el estado efectivo del sandbox debe revisarse al arrancar.

## Cómo se obtuvo la línea base

Medición: 14 de septiembre de 2026, AMD Athlon Silver 3050U de dos núcleos, 17 GiB de RAM,
Arch Linux x64, Electron 28.3.3. Cuenta limpia con configuración de prueba, workspace vacío, sin
credenciales ni llamadas LLM. Se sumó `VmRSS` de `/proc/<pid>/status` para el proceso y sus
descendientes; RSS suma algunas páginas compartidas y **no equivale** a memoria física exclusiva.

| Muestra | Resultado observado | Qué falta medir |
| --- | --- | --- |
| CLI, 20 s de sesión vacía | ~380 MB RSS agregado, hasta 3 procesos; servicio OpenClaw no disponible en ese entorno. | Tarea real, navegador, workspace grande, proveedor local y sesiones largas. |
| Desktop Electron, 20 s de arranque/idle | 16 procesos al final; ~2.7 GB RSS medio de los segundos 11–20 y ~2.94 GB de pico. El canvas Live2D estaba presente; GPU desactivada en el lanzamiento de prueba. | Voz activa, tarea con herramientas, Chromium administrado, recuperación tras horas de uso y otras GPU. |
| Linux x64, carpeta `linux-unpacked` | ~740 MB ocupados. Empaquetado `dir` llegó a crear `app.asar`, pero la fase final quedó interrumpida: no es una validación del instalador. | Tamaño de instalación final por plataforma, Vosk, caché ONNX/Chromium y actualización. |

El startup del escritorio consumió aproximadamente 1–1.7 núcleos durante varios segundos y bajó al
final de la muestra. Es una observación local y no una garantía de rendimiento. El mínimo de RAM
incluye margen sobre el RSS medido para el sistema operativo y las aplicaciones del usuario.

Para confirmar estos requisitos necesitamos al menos tres equipos por plataforma con sesiones de
reposo, chat, tareas de agente, navegador, voz y Live2D. La plantilla
[`Informe de prueba externa`](../.github/ISSUE_TEMPLATE/external-test.yml) recoge equipo,
configuración y medidas. Hasta entonces, reserva más memoria y disco si usarás modelos locales o
workspaces grandes.
