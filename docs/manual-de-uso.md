# Manual de uso de Kaoru

Esta guía explica **qué puedes hacer en Kaoru y cómo hacerlo**. Está dirigida a quien usa la
aplicación, no a quien modifica su código. La interfaz puede variar ligeramente según el sistema
operativo, el proveedor de IA y los permisos configurados.

## Índice

1. [Empezar](#1-empezar)
2. [Carpetas, chats y terminales](#2-carpetas-chats-y-terminales)
3. [Conversar y trabajar con Kaoru](#3-conversar-y-trabajar-con-kaoru)
4. [Usar la terminal con el chat](#4-usar-la-terminal-con-el-chat)
5. [Consultar y controlar la memoria](#5-consultar-y-controlar-la-memoria)
6. [Modelo, voz, avatar y sugerencias](#6-modelo-voz-avatar-y-sugerencias)
7. [Permisos y datos](#7-permisos-y-datos)
8. [Atajos de teclado](#8-atajos-de-teclado)
9. [Problemas frecuentes](#9-problemas-frecuentes)

## 1. Empezar

1. Abre Kaoru. En el primer uso, elige un proveedor y un modelo de IA desde **Elegir modelo** si
   quieres conversar o pedirle tareas. Necesitarás una clave válida o un endpoint local compatible,
   según el proveedor. La terminal integrada puede abrirse sin clave de IA.
2. Selecciona una carpeta de trabajo desde **Chats → Abrir carpeta y crear chat**. Esa carpeta es el
   _workspace_: el proyecto en el que Kaoru interpreta `@archivo`, lee archivos y, si lo autorizas,
   ejecuta herramientas. No es necesario mover el proyecto a la carpeta de Kaoru.
3. Escribe una pregunta concreta. Por ejemplo: «Explícame la estructura de este proyecto y dime qué
   archivos debería revisar; no cambies nada todavía». Después puedes pedir un cambio delimitado y
   revisar el resultado.

En Linux, Windows y macOS, el selector de carpetas de la interfaz evita tener que cambiar de directorio
en una terminal externa. Si usas el lanzador `asistente` desde una terminal, Kaoru toma la carpeta
desde la que lo invocas. La disponibilidad del lanzador depende de la instalación.

## 2. Carpetas, chats y terminales

El nombre de la carpeta aparece en la cabecera. Púlsalo, o abre **Chats**, para cambiar de workspace.
El botón **＋** crea otro chat o una terminal en la carpeta actual. En **Chats** también puedes abrir
otra carpeta y crear allí un chat o una terminal. La lista agrupa las sesiones por carpeta; **Mostrar
más** carga las restantes cuando hay muchas.

Cada chat conserva su conversación y queda asociado a una carpeta. Al volver a un chat, Kaoru activa
su workspace. Si la carpeta ya no existe o cambió de ubicación, la interfaz pide elegir otra antes de
abrirlo. Mientras Kaoru responde o usa herramientas, termina o cancela la tarea antes de cambiar de
sesión.

La **×** junto a una sesión sirve para eliminar ese chat o terminal, con confirmación. Eliminar un chat
quita su conversación, **no borra por sí mismo los recuerdos del explorador de memoria** ni los
archivos de tu proyecto. Eliminar una terminal sí cierra su sesión; no uses esta acción para procesos
que necesites conservar. Al cerrar la aplicación terminan los procesos de las terminales; reabrir una
sesión Terminal inicia una shell nueva en la misma carpeta, no restaura el proceso anterior.

## 3. Conversar y trabajar con Kaoru

Escribe en el cuadro inferior y pulsa **Enter** para enviar. **Shift+Enter** inserta una nueva línea.
**＋ Adjuntar** agrega archivos al mensaje; revisa lo adjuntado antes de enviar. Al escribir `@`, Kaoru
ofrece archivos del workspace para referenciarlos en la pregunta. Al escribir `/`, muestra comandos
disponibles. Puedes elegir una sugerencia con el teclado o con el ratón.

La respuesta aparece progresivamente y puede incluir Markdown, bloques de código, actividad del
agente, plan, cambios y resultados de herramientas. **Detener** cancela la generación en curso; una
acción externa que ya terminó no se deshace por pulsar ese botón. La etiqueta **Auto** indica que no
necesitas escoger entre «charla» y «agente»: Kaoru decide internamente cómo atender la petición según
el modelo, las herramientas y los permisos disponibles. Si solo quieres una explicación, dilo; si
quieres que cambie algo, especifica el resultado esperado.

Comandos útiles en el cuadro del chat:

| Escribe       | Para qué sirve                                                                |
| ------------- | ----------------------------------------------------------------------------- |
| `/help`       | Consultar la lista actual de comandos.                                        |
| `/model`      | Ver proveedores/modelos y elegir uno; también puedes usar el selector visual. |
| `/init`       | Analizar el proyecto activo y guardar información del proyecto en memoria.    |
| `/memoria`    | Abrir el explorador de memoria.                                               |
| `/mudo`       | Activar o silenciar la voz de salida.                                         |
| `/stats`      | Consultar estadísticas de uso de herramientas, si están disponibles.          |
| `/telemetria` | Ver la comparación de actividad local entre meses, si hay datos.              |

Usa `/help` como referencia vigente: algunos comandos adicionales dependen de la configuración o
integraciones activas. **Comandos del chat** y **comandos de la terminal** no son lo mismo; por ejemplo,
`/model` va en el chat, mientras que `git status` va en la terminal.

El botón del modelo en el compositor abre el selector de proveedores y modelos. En el código que
Kaoru muestra, los bloques de un solo comando de shell ofrecen **Pegar en terminal** y **Ejecutar…**
cuando hay una terminal vinculada: pegar no pulsa Enter; ejecutar pide confirmación antes de enviarlo.
Revisa siempre el comando, especialmente si modifica archivos o instala software.

## 4. Usar la terminal con el chat

Abre **＋ → Nueva terminal**. La terminal utiliza la shell del sistema en el workspace actual. Admite
las funciones habituales de esa shell, como historial, autocompletado con **Tab** y **Ctrl+C** para
interrumpir, si la shell y el programa activo las admiten. No importa automáticamente el tema ni el
historial de Warp u otra aplicación de terminal; la shell puede cargar sus archivos normales de inicio.

En la barra de la terminal:

- **Buscar** encuentra texto en la salida visible y desplazable, muestra el número de coincidencias y
  permite ir a la anterior o siguiente.
- **Chat** abre una conversación vinculada al lado de la terminal, sin detener la shell.
- **Preguntar a Kaoru** toma el texto seleccionado; si no hay selección, prepara un fragmento reciente
  de salida. Lo muestra en una tarjeta del chat para que lo revises antes de enviarlo.
- **Explicar error** prepara una pregunta y adjunta salida reciente cuando Kaoru detecta un posible
  error. **No se envía automáticamente**.
- **⋯** cambia la vista y el movimiento del avatar y el tamaño del texto de la terminal.
- **Reiniciar shell** aparece si la shell no pudo abrirse o terminó.

En el chat lateral, **Ver terminal completa** vuelve a la vista amplia. La conversación y la terminal
siguen vinculadas dentro del mismo workspace. Al enviar un mensaje con salida adjunta, el mensaje y
la primera respuesta muestran **Ver salida en terminal** para regresar al fragmento relacionado
mientras esté disponible en el buffer. La tarjeta permite quitar el adjunto antes de enviar. El
fragmento reciente es aproximado: Kaoru no conoce necesariamente los límites exactos entre un
comando y el siguiente ni garantiza un código de salida preciso.

**Importante:** la terminal ejecuta con los permisos de tu usuario, sin pasar por los permisos del
agente de Kaoru. La salida no se agrega al chat ni se envía al proveedor de IA hasta que tú la adjuntas
y envías el mensaje. Antes de hacerlo, busca claves, tokens, rutas privadas u otros datos sensibles.

## 5. Consultar y controlar la memoria

Escribe `/memoria` en el chat. El explorador tiene tres vistas: **Grafo** para relaciones, **Lista**
para localizar recuerdos concretos y **Línea temporal** para verlos por fecha. Puedes buscar, filtrar
por tipo y por relación, centrar el grafo, ampliarlo o abrirlo en pantalla completa.

Al seleccionar un recuerdo, el panel de detalle muestra contenido, tipo, confianza, fechas, relaciones
y, cuando existe, evidencia de origen. Distingue entre información inferida, confirmada, posiblemente
desactualizada y registros sin fuente verificable. Desde ahí puedes **Editar**, **Fijar** o **Olvidar**
ese recuerdo. «Olvidar» afecta al recuerdo seleccionado; no equivale a eliminar todos los chats.

La sección **Aún no sé sobre ti** permite marcar temas para que Kaoru no pregunte por ellos o posponer
la pregunta. **Pregúntale a tu memoria** busca coincidencias en el inventario cargado y permite
mostrarlas en el grafo; no es una respuesta nueva generada por el modelo. Si el inventario indica que
está truncado o aparece el aviso **Memoria no persistente**, el resultado no representa toda la memoria
o puede perderse al cerrar la app, respectivamente.

## 6. Modelo, voz, avatar y sugerencias

Elige el modelo de IA desde **Elegir modelo** o con `/model`. La disponibilidad de visión,
herramientas, velocidad, coste y contexto depende del proveedor y modelo elegidos. Un endpoint local
para el modelo no convierte automáticamente en locales la voz, navegación u otras integraciones.

La voz de salida puede silenciarse con `/mudo`; la síntesis Edge TTS utiliza un servicio de Microsoft y
requiere conexión. La interfaz actual no ofrece entrada de voz por micrófono. El avatar Live2D admite
otros modelos compatibles; `/cambio-modelo` muestra los disponibles y permite cambiarlo. Los derechos
de personajes y modelos de terceros son independientes de la licencia del código de Kaoru.

En **Ajustes** puedes elegir el grado de iniciativa (**Observar**, **Sugerir** o **Actuar**) y revisar
permisos. Una sugerencia proactiva no otorga permisos nuevos al modelo: las acciones siguen sujetas a
la política configurada. Si prefieres menos interrupciones, usa un modo menos activo y controla las
preguntas de curiosidad desde el explorador de memoria.

## 7. Permisos y datos

Antes de pedir a Kaoru que cambie archivos o controle el escritorio, revisa **estado → Permisos** y
los ajustes. Las reglas de herramientas pueden permitir, pedir confirmación o denegar. No todas las
acciones muestran una pregunta: depende de la regla aplicable. Las capacidades de pantalla, teclado,
puntero, navegador y otras integraciones tienen controles separados; su funcionamiento también
depende del sistema operativo y de la aplicación de destino.

La memoria se guarda localmente cuando su almacenamiento está disponible, pero el texto de tus
mensajes, archivos adjuntos y salida de terminal que envíes pueden llegar al proveedor de IA que
configures. Las integraciones de terceros tienen sus propias condiciones. Consulta el
[aviso de privacidad](./web/privacy.html) antes de enviar datos sensibles.

## 8. Atajos de teclado

Los atajos de la terminal se aplican **cuando tiene el foco**. «Ctrl/Cmd» significa Ctrl en Linux y
Windows, y Cmd en macOS. Un atajo global puede no registrarse si otra aplicación ya lo ocupa.

| Dónde                             | Tecla                           | Acción                                                           |
| --------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| Chat                              | **Enter**                       | Enviar mensaje o aceptar la sugerencia seleccionada.             |
| Chat                              | **Shift+Enter**                 | Salto de línea sin enviar.                                       |
| Sugerencias `@` o `/`             | **Tab**, **↑**, **↓**           | Recorrer sugerencias; **Enter** inserta la elegida.              |
| Sugerencias o selector de modelos | **Esc**                         | Cerrar el panel.                                                 |
| Selector de modelos               | **↑**, **↓**, **Enter**         | Navegar y elegir o abrir un proveedor/modelo.                    |
| Terminal                          | **Ctrl+F** (o **Cmd+F**)        | Abrir la búsqueda de salida.                                     |
| Búsqueda de terminal              | **Enter** / **Shift+Enter**     | Coincidencia siguiente / anterior; **Esc** cierra.               |
| Terminal                          | **Ctrl+Shift+C / Ctrl+Shift+V** | Copiar selección / pegar en Linux y Windows.                     |
| Terminal en macOS                 | **Cmd+C / Cmd+V**               | Copiar selección / pegar.                                        |
| Shell de terminal                 | **Tab**, **Ctrl+C**             | Completar según la shell / interrumpir proceso activo.           |
| Explorador de memoria             | **Esc**                         | Salir de pantalla completa.                                      |
| Aplicación                        | **Ctrl/Cmd+Shift+Q**            | Cerrar Kaoru por completo, si se pudo registrar el atajo global. |

Si **Ctrl/Cmd+Shift+Q** está ocupado, Kaoru intenta registrar **Alt+Shift+Q**. Si ambos están ocupados,
usa **Cerrar y salir** en la ventana o **Cerrar todo** en el menú del avatar.

## 9. Problemas frecuentes

| Síntoma                                    | Qué revisar                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «Sin API keys» o Kaoru no responde         | Abre **Elegir modelo**, configura el proveedor/clave o endpoint y comprueba la conexión. La terminal puede funcionar aunque el chat con IA no esté configurado. |
| Un chat pide elegir carpeta                | Su workspace anterior ya no está disponible. Selecciona la carpeta correcta; no asumas que Kaoru encontró automáticamente el proyecto movido.                   |
| La terminal no muestra el proceso anterior | Al cerrar Kaoru terminan las shells. La sesión conserva la carpeta, pero no restaura el proceso ni el estado interactivo.                                       |
| `Tab` no completa en terminal              | La expansión depende de la shell y del programa que está recibiendo las teclas; comprueba que la terminal tenga el foco.                                        |
| El chat no conoce una salida de terminal   | Selecciónala o usa **Preguntar a Kaoru**, revisa la tarjeta y envía el mensaje. La terminal no comparte toda su salida automáticamente.                         |
| La memoria no persiste                     | Si aparece el aviso correspondiente, el almacenamiento local está degradado. Evita confiar en recuerdos nuevos para sesiones futuras hasta resolverlo.          |
| Una tarea queda a medias tras **Detener**  | La cancelación frena la generación pendiente, pero no revierte efectos ya completados. Revisa el diff, la terminal y los servicios externos antes de continuar. |

Para instalación y requisitos, consulta el [README principal](../README.md) y los
[requisitos](./requisitos.md). Para información más detallada sobre tratamiento de datos,
lee [Privacidad](./web/privacy.html).
