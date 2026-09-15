# Seguridad de Kaoru

Kaoru procesa conversaciones, archivos del workspace y contenido externo. También puede ejecutar
comandos y controlar partes del escritorio cuando el usuario habilita esas capacidades. Los fallos
de autorización, aislamiento o tratamiento de datos se consideran problemas de seguridad.

Kaoru todavía no ha completado una auditoría de seguridad externa. Los controles descritos aquí
reducen riesgo, pero no constituyen una garantía de aislamiento universal.

## Versiones con soporte

Las correcciones de seguridad se preparan sobre la rama `produccion` y se incluyen en la versión
publicada siguiente. Las versiones antiguas y los forks no reciben mantenimiento garantizado.

## Informar una vulnerabilidad

No abras un issue público con detalles explotables, credenciales, datos personales o contenido de un
workspace. Envía el informe a **dregxmoon@gmail.com** con el asunto `Seguridad Kaoru` e incluye:

- versión, commit, sistema operativo y modo de instalación;
- configuración relevante sin claves ni tokens;
- pasos mínimos para reproducir el problema y su impacto;
- logs ya redactados y una prueba de concepto segura, si existe;
- si autorizas que se reconozca públicamente tu contribución.

El proyecto intentará confirmar la recepción, evaluar severidad y acordar una divulgación coordinada.
Los tiempos dependen de la disponibilidad del mantenedor y no constituyen un SLA. Si el informe afecta
a una dependencia, también puede ser necesario coordinar con su responsable.

## Modelo de amenazas

### Activos protegidos

- archivos y cambios no confirmados del workspace;
- credenciales de proveedores, GitHub, Google, MCP y otros servicios;
- conversaciones, memoria local, capturas y contexto del sistema;
- cuentas, sesiones del navegador y servicios conectados;
- integridad del equipo y de los procesos iniciados por Kaoru.

### Entradas no confiables

- prompts y salidas del modelo de lenguaje;
- repositorios, nombres de archivo y reglas de proyecto;
- páginas web, resultados de búsqueda y controles observados en pantalla;
- respuestas de MCP, plugins y servicios conectados;
- modelos Live2D y otros archivos importados por el usuario.

### Límites de confianza

| Límite | Control actual | Riesgo residual |
| --- | --- | --- |
| Renderer → preload → main | `contextIsolation`, sandbox del renderer, canales IPC permitidos y handlers en main | Un canal o payload validado de forma incompleta puede ampliar privilegios. |
| LLM → herramienta | Política `allow`/`ask`/`deny`, aprobaciones acotadas y clasificación fuera del modelo | La clasificación no puede anticipar todo efecto de un comando, plugin o servicio externo. |
| Herramientas → filesystem | Workspace activo y validación de rutas en las herramientas que la aplican | Los comandos arbitrarios y extensiones tienen superficies diferentes; no toda acción es reversible. |
| Proceso → sistema operativo | AppContainer en Windows y `bwrap` en Linux cuando están disponibles | macOS no tiene aislamiento adicional equivalente; deshabilitar el sandbox expone permisos del host. |
| Contenido externo → contexto | Procedencia y delimitación en rutas web, navegador, MCP y UI revisadas | Estos controles reducen prompt injection, pero no prueban inmunidad universal. |
| Equipo → proveedor externo | Proveedor elegido por el usuario y credenciales gestionadas por la aplicación | Prompts, fragmentos del workspace o capturas pueden salir del equipo cuando una función los necesita. |

### Suposiciones y fuera de alcance

- El sistema operativo, Electron y las dependencias instaladas se consideran parte de la base confiable.
- Una cuenta del sistema ya comprometida puede leer o alterar los datos accesibles a ese usuario.
- Un plugin o servidor MCP concede capacidades adicionales y debe tratarse como código de terceros.
- Checkpoints y verificación aportan evidencia de recuperación; no revierten pagos, mensajes enviados,
  cambios remotos ni todos los efectos de comandos arbitrarios.
- El navegador administrado usa un perfil separado. Abrir una URL en el navegador personal no concede
  por sí mismo a Kaoru acceso directo a sus cookies o contraseñas.

## Áreas prioritarias para revisión externa

1. rutas, enlaces simbólicos y carreras entre validación y uso;
2. especificidad y duración de permisos y aprobaciones de sesión;
3. ejecución de comandos y degradación del sandbox por plataforma;
4. IPC, navegación de ventanas y renderizado de contenido generado;
5. plugins, MCP, herencia de entorno y almacenamiento de secretos;
6. SSRF, redirecciones, prompt injection y automatización visual;
7. cobertura real y conflictos de checkpoint, verificación y recuperación.

Consulta la implementación y sus límites en
[`core/security/README.md`](core/security/README.md),
[`core/sandbox/README.md`](core/sandbox/README.md) y
[`docs/agente-codigo.md`](docs/agente-codigo.md).
