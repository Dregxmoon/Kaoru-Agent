# Changelog

## [2.3.1] — 2026-10-02

### Correcciones de Windows

- El sandbox AppContainer ahora degrada a ejecución directa cuando no puede inicializarse (servicio AppX desactivado, Windows Home, entornos restringidos): la app ya no se bloquea y el gate de permisos de Kaoru sigue aplicando.
- La importación de modelos Live2D por arrastrar y soltar copia a `userData/models/` en lugar del `models/` del release (solo lectura dentro de `app.asar` en instalaciones empaquetadas).

### Página web

- La sección de instalación descarga directamente el instalador por sistema operativo (Windows .exe instalador/portable, Linux .deb/AppImage, macOS DMG Intel/Apple Silicon) sin pasar por la página de releases; la versión se resuelve desde `package.json`.
- Textos de la web actualizados a post-v2.3 (interfaz multidioma ES/EN/JA ya publicada, manual e idioma en presente).

## [2.3.0] — 2026-09-29

### Terminal integrada

- Panel de terminal embebida en el chat con toolbar de acciones (buscar, explicación de errores, salida adjunta, regreso al chat)
- Estado de terminal visible: conectando, lista, no disponible, shell cerrada con código de salida
- Integración con`:workspace`` para mostrar el directorio activo en la barra de identidad
- Atajos de teclado: Ctrl+K para alternar, Ctrl+Shift+C/V para copiar/pegar
- Persistencia de sesión PTY entre cambios de vista

### Internacionalización completa

- Sistema i18n con 3 idiomas: English (canónico), Español, 日本語
- 55 claves nuevas agregadas a los catálogos EN/ES/JA
- ~40 textos hardcodeados reemplazados con `data-i18n` y `kaoruI18n.t()`
- Selector de idioma en Settings con persistencia en config.json
- Detección automática del idioma del sistema (modo "system")
- Atributos soportados: `data-i18n`, `data-i18n-title`, `data-i18n-label`, `data-i18n-placeholder`
- Tests de validación de claves y paridad entre idiomas

### Chat y mensajes

- Bloque de actividad con etiquetas de herramientas traducidas
- Tarjetas proactivas con acciones unificadas
- Indicador de estado del compositor (Listo/Respondiendo/Cargando)
- Hint de input con estado de carga
- Mejoras en el renderizado de mensajes de código y bloques de plan

### UI y controles de ventana

- Controles de ventana animados (minimizar, maximizar, restaurar, cerrar)
- Tema claro/oscuro con transición suave (180ms)
- Movimiento de avatar con 3 niveles: sutil, animado, quieto
- Vista de avatar: completa, primer plano, cerrada
- Tamaño de fuente de terminal ajustable

### Memoria y conocimiento

- Explorador de memoria con grafo, lista y timeline
- Filtros por tipo: proyectos, preferencias, personas, episodios, creencias
- Relaciones explícitas y semánticas entre memorias
- Curiosidad contextual para descubrir knowledge gaps
- Consolidación de memoria durante sleep

### Comandos del agente

- Registry de comandos con categorías: general, dev, model
- Comandos: /model, /commands, /permissions, /memory, /provider
- Mejoras en el parser de comandos estructurados (aliases, bilingual, pipes)

### Infraestructura

- IPC unificado para chat, config y memory handlers
- KeychainManager para almacenamiento seguro de API keys
- Sandbox de comandos con aprobación de acciones de alto impacto
- Rebuild de módulos nativos contra Electron (better-sqlite3, sqlite-vec)
- onnxruntime-node con binding NAPI estable (sin rebuild)

### Tests

- 4790 tests passing en 130+ suites
- Cobertura e2e: terminal layout, chat flow, window controls, memory explorer, proactive cards
- Tests de i18n con validación de claves y paridad EN/ES/JA
- Tests de voz, aprendizaje activo, herramientas web y terminal

### Documentación

- Manual de uso actualizado en docs/web (EN/ES/JA)
- Guía de privacidad en 3 idiomas
- README con instrucciones de instalación y desarrollo
