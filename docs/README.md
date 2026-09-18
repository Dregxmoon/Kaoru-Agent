<div align="center">

# Documentación de Kaoru

**Una entrada clara al producto, su arquitectura y sus límites.**

**Español** · [日本語](./i18n/ja/README.md) · [English](./i18n/en/README.md)

</div>

---

## Empieza aquí

La [web pública](./web/index.html) y su [guía de uso](./web/guide.html) están disponibles en
español, inglés y japonés. Consulta [cómo mantener la web](./web/README.md) para actualizar el diseño
compartido y generar las páginas.

| Quiero…                          | Documento                                              |
| -------------------------------- | ------------------------------------------------------ |
| conocer el proyecto o instalarlo | [README principal](../README.md)                       |
| entender procesos, Core y flujos | [Arquitectura](./arquitectura.md)                      |
| entender el agente de ingeniería | [Agente de código](./agente-codigo.md)                 |
| distribuir a testers o usuarios  | [Distribución](./distribucion.md)                      |
| trabajar en el núcleo            | [Core](../core/README.md)                              |
| revisar renderer, preload e IPC  | [Interfaz](../src/README.md) y [IPC](../ipc/README.md) |
| entender sensores y servicios    | [Infraestructura](../infrastructure/README.md)         |
| revisar control del escritorio   | [Automatización desktop](../core/desktop/README.md)    |
| conocer qué datos usa Kaoru      | [Aviso de privacidad](./web/privacy.html)              |
| consultar las condiciones de uso | [Términos de uso](./web/terms.html)                    |
| ejecutar o ampliar pruebas       | [Estrategia de pruebas](../tests/README.md)            |
| contribuir en otro idioma        | [Política de localización](./i18n/README.md)           |

## Principio documental

La implementación y las pruebas tienen prioridad sobre este texto. El español es la fuente canónica; las traducciones resumen la entrada pública sin duplicar todos los READMEs internos. Las afirmaciones dependientes de plataforma, configuración o fallback deben conservar esos calificadores.

La documentación distingue almacenamiento local de transferencias externas. La memoria, los embeddings y la telemetría se almacenan en el dispositivo; el proveedor LLM configurado y las integraciones que el usuario activa pueden recibir el contenido estrictamente necesario para ejecutar una tarea. Consulta el aviso de privacidad antes de habilitar capturas, integraciones, plugins o servidores MCP de terceros.

[Volver a la portada →](../README.md)
