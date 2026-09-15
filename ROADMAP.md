# Madurez y roadmap de Kaoru

Kaoru se desarrolla como un **asistente personal de IA con capacidad de agente**. Conversación,
memoria, voz, presencia Live2D y proactividad forman la experiencia de asistente; el uso gobernado de
herramientas permite delegar tareas de código y escritorio.

Este roadmap no promete fechas. Cada avance se cierra con evidencia pública y reproducible.

## Estado de madurez

| Área | Estado | Evidencia y límite principal |
| --- | --- | --- |
| Conversación y proveedores | Beta | Flujo integrado y probado; calidad, coste y privacidad dependen del proveedor elegido. |
| Agente de código y verificación | Beta | Suite focal y cobertura instrumentada de `core/planner`; falta validación externa en repositorios diversos. |
| Memoria local | Beta | Persistencia SQLite y fallback a memoria; falta medir sesiones largas en máquinas externas. |
| Proactividad | Beta | `core/decision` tiene pruebas y reason codes; necesita evaluación con usuarios para medir utilidad y molestias. |
| Voz | Experimental | ASR local y TTS externo requieren dependencias opcionales; faltan benchmarks por idioma y hardware. |
| Live2D | Experimental | Render e importación funcionan; el avatar distribuido actualmente no habilita explotación comercial. |
| Escritorio Linux | Beta | AT-SPI2 y fallback visual; cobertura real depende de cada aplicación y entorno gráfico. |
| Escritorio Windows | Beta | UI Automation y AppContainer tienen contratos en CI; faltan pruebas externas en instalaciones reales. |
| Escritorio macOS | Experimental | Sin paridad de control semántico ni sandbox adicional del ejecutor. |
| MCP y plugins | Experimental | Extienden herramientas y superficie de confianza; necesitan revisión individual y más hardening. |
| Instaladores y actualización | Beta | CI genera `.exe`, `.dmg`, `.AppImage` y `.deb`; faltan firma, notarización y onboarding de dos minutos. |

`Beta` significa que existe un flujo utilizable con pruebas automatizadas y límites conocidos.
`Experimental` significa que la API, cobertura o comportamiento por plataforma todavía puede cambiar.
Ningún componente se declara `production-ready` hasta tener uso externo, métricas y revisión de
seguridad acordes a su impacto.

## Gate 1: credibilidad técnica

- [x] Publicar threat model y proceso de divulgación en [`SECURITY.md`](SECURITY.md).
- [x] Generar cobertura focal reproducible mediante `npm run coverage`.
- [x] Configurar un job de CI que genera `lcov.info` y lo adjunta como artefacto planner/decision.
- [ ] Verificar el primer artefacto en un run verde de `produccion` antes de afirmar cobertura publicada.
- [ ] Conectar Codecov y mostrar su badge después del primer reporte canónico correcto.
- [x] Publicar requisitos **provisionales** con línea base local por experiencia en [`docs/requisitos.md`](docs/requisitos.md).
- [ ] Confirmar los requisitos con usuarios externos, voz activa y tareas reales multiplataforma.
- [ ] Grabar una tarea real, larga y sin cortes: solicitud, permisos, herramientas, diff, pruebas y fallo si lo hay.
- [ ] Conseguir informes públicos de 3–5 testers externos en Windows y Linux; incluir macOS como exploratorio.
- [x] Publicar [revisión interna de seguridad](docs/security-review-2026-09-14.md) y corregir el bypass IPC de Git.
- [ ] Obtener una revisión de seguridad independiente y enlazar hallazgos y correcciones.
- [ ] Convertir `typecheck` en gate bloqueante después de eliminar la deuda JSDoc existente.

La medición local del 14 de septiembre de 2026 cubrió únicamente `core/planner` y `core/decision`:
75.9% de líneas/statements, 67.72% de branches y 74.92% de funciones. Es una línea base local, no una
cifra de cobertura total ni un badge publicado. CI debe ser la fuente canónica antes de promocionarla.

## Gate 2: adopción

- [ ] Mostrar una tarea completa en la landing antes del catálogo técnico.
- [ ] Descargar instaladores desde una página clara por sistema operativo y explicar advertencias de firma.
- [ ] Completar un onboarding de dos minutos con workspace de demostración y permisos conservadores.
- [ ] Elegir una experiencia inicial de modelo: BYOK guiado, endpoint local o cuenta Kaoru con cuota incluida.
- [ ] Publicar comparación reproducible con Cursor, Cline, Aider, Claude Code y OpenHands.
- [ ] Mantener issues pequeños etiquetados `good first issue` y una ruta de contribución verificable.
- [ ] Cerrar la brecha de accesibilidad y sandbox en macOS antes de anunciar paridad.

Una experiencia sin API key requiere inferencia local instalada o un servicio financiado por Kaoru.
No debe presentarse como “sin configuración” hasta definir coste, privacidad, límites y recuperación.

## Gate 3: distribución comercial

- [ ] Sustituir el avatar incluido por uno propio o con licencia comercial documentada.
- [x] Excluir del empaquetado modelos importados por el usuario mediante una lista explícita de assets.
- [ ] Unificar nombre, `appId`, ejecutables, dominio y marca alrededor de Kaoru.
- [ ] Firmar Windows y macOS, notarizar macOS y documentar procedencia y hashes de cada release.
- [ ] Definir términos comerciales, soporte, reembolsos, tratamiento de datos e impuestos aplicables.
- [ ] Medir coste de inferencia y soporte antes de vender una cuota incluida.

El código MIT puede seguir siendo gratuito. La oferta comercial propuesta separa entrega y soporte
de los derechos sobre código, personajes y modelos externos:

| Línea prevista | Entrega concreta | Condición para ofrecerla |
| --- | --- | --- |
| Community | App y código MIT, BYOK o endpoint local compatible, permisos y memoria local. | Requisitos y límites publicados; sin prometer cuota gratuita de inferencia. |
| Distribución de pago | Binarios firmados, avatar original/licenciado, onboarding y actualizaciones probadas. | Firma/notarización, derechos comerciales y smoke test multiplataforma. |
| Equipos | Configuración y políticas compartidas, instalación y soporte con alcance definido. | Pruebas externas, auditoría independiente y acuerdos de tratamiento de datos. |
| Servicios piloto | Instalación, personalización de avatar con derechos y conectores MCP para un cliente concreto. | Presupuesto por proyecto, aceptación del alcance, pruebas de entrega y licencias verificadas. |

Los servicios piloto son una **definición futura**, no soporte, SLA ni producto disponible hoy.
Precios, horas de soporte, reembolsos y cuota de inferencia se definirán después de medir coste real y
demanda con clientes. Los assets de March 7th están fuera de MIT y no deben incluirse en una edición
comercial ni en un proyecto facturado.

## Medición de requisitos

Los requisitos se publicarán después de medir al menos tres equipos por plataforma. Cada sesión debe
registrar reposo, conversación, tarea de agente, voz, avatar y navegador administrado. La medición debe
sumar el proceso principal de Electron, renderers, worker de embeddings, navegador y procesos Python;
el RSS que hoy expone `HealthMetrics` representa solo el proceso que atiende esa métrica.

La [línea base local](docs/requisitos.md) ya identifica su alcance. Se publicarán percentiles,
versión, duración, tamaño del workspace y modelo usado para:

- RAM en reposo, pico y estabilización posterior;
- CPU media/pico y tiempo hasta primera respuesta;
- espacio de instalación, caché y modelos opcionales;
- presencia o ausencia de GPU y aceleración efectiva;
- tasa de éxito, intervención humana y tiempo por tarea.
