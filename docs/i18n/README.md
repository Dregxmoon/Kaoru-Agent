# Idiomas y mantenimiento

[← Centro de documentación](../README.md)

## Fuente canónica y estado de la migración

Para v2.3, **el inglés es la base canónica de la interfaz y de los comandos nuevos**. `src/chat/i18n.js` contiene el catálogo base y las traducciones española y japonesa; `core/commands/CommandRegistry.js` conserva aliases de comandos anteriores. Esto no significa todavía que todas las pantallas estén traducidas: los textos generados por código, el overlay y los diálogos del proceso principal requieren una auditoría aparte antes de anunciar una aplicación completamente multidioma.

La documentación técnica detallada existente sigue mayoritariamente en español (`README.md`, `docs/arquitectura.md` y READMEs internos). Durante la transición, no se debe describirla como traducida ni usarla como evidencia de paridad EN/ES/JA. La fuente canónica **del producto nuevo** será inglés cuando la revisión de equivalencia termine; la fuente española antigua se mantiene hasta entonces para no perder contenido verificado.

Las portadas localizadas ofrecen una presentación, instalación, arquitectura y modelo de seguridad equivalentes. Cuando un detalle profundo sólo está disponible en español, enlazan a la fuente canónica en lugar de mantener una copia potencialmente obsoleta.

## Ediciones disponibles

- [Español](../../README.md)
- [日本語](./ja/README.md)
- [English](./en/README.md)

## Regla de actualización

1. Cambia primero el catálogo inglés de producto y verifica las afirmaciones contra código y pruebas. Si el documento técnico solo existe en español, actualízalo allí y marca la traducción pendiente.
2. Actualiza las secciones equivalentes en cada portada localizada; no publiques una función en un idioma si falta en los otros.
3. Conserva comandos, rutas, nombres de configuración y símbolos de código sin traducir.
4. No copies cifras volátiles. Enlaza a CI o a comandos reproducibles.
5. Si una traducción no puede verificarse, indícalo y enlaza a la versión española.
6. La web pública mantiene portada, guía, privacidad y términos en español, inglés y japonés con
   una plantilla compartida. Los textos legales existentes siguen indicando que el español es su
   fuente jurídica actual; no se cambia esa declaración sin revisar las tres versiones. No omitas
   transferencias a proveedores o limitaciones en una traducción.
7. Las fuentes de la web viven en `docs/web/content/`; genera las doce páginas con
   `node scripts/build-website.js`. El selector debe conservar la página y la sección entre idiomas.

Las ediciones coreana y portuguesa se retiraron; las variantes inglesa británica y estadounidense
se consolidaron en `en`. Sus versiones anteriores se pueden recuperar desde el historial Git.
