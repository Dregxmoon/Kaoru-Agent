# Contribuir a Kaoru

Gracias por ayudar a probar y mejorar Kaoru. Son especialmente útiles las reproducciones en equipos
distintos, las mejoras pequeñas con pruebas y las revisiones independientes de seguridad.

## Antes de empezar

- Usa un repositorio de prueba y una cuenta sin datos sensibles para experimentar con herramientas.
- Revisa [`SECURITY.md`](SECURITY.md). Los problemas explotables se informan en privado.
- No incluyas claves, tokens, conversaciones privadas, capturas sensibles ni modelos sin derechos.
- Busca primero un issue relacionado y describe el comportamiento observado antes de proponer una
  reescritura amplia.

## Entorno de desarrollo

Kaoru requiere Git, Node.js 18 o posterior y npm 9 o posterior. Después de clonar:

```sh
npm install
npm run rebuild
npm run init-db
```

Los módulos SQLite se compilan para Electron. Ejecuta las pruebas mediante el runner del proyecto:

```sh
npm test
node scripts/electron-node.js tests/test_nombre.js
npm run lint
npm run typecheck
npm run format:check
```

Antes de enviar un cambio, ejecuta `npm run format` y las suites relevantes. Los módulos nuevos del
pipeline usan CommonJS, `// @ts-check` y JSDoc estricto; el proyecto no incorpora una compilación de
TypeScript.

## Pruebas externas

Para una prueba en otra máquina usa la plantilla **Informe de prueba externa**. Registra incluso una
sesión correcta: sistema operativo, CPU, RAM, GPU, tipo de instalación, modo usado, tarea exacta,
tiempo, consumo observado y enlaces a errores. No publiques contenido privado del workspace.

Una prueba válida debe distinguir:

- conversación/agente sin voz ni avatar;
- experiencia completa con voz, Live2D y automatización habilitada;
- proveedor remoto o endpoint local;
- resultado completado, parcial, rechazado por permisos o fallido.

## Pull requests

Mantén cada cambio acotado y explica el comportamiento anterior y el nuevo. Incluye los comandos de
validación realmente ejecutados y sus limitaciones. No presentes una prueba focal como cobertura de
todo el producto. Las contribuciones se publican bajo la licencia del repositorio; los modelos,
personajes y marcas de terceros conservan sus propios derechos.
