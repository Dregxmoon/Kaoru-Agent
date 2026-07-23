# Infraestructura del sistema

Capas de bajo nivel: sensores del sistema operativo, bus de eventos interno, inicialización de base de datos vectorial.

## Módulos hijos

| Carpeta | Propósito |
|---|---|
| `sensors/` | Percepción del SO (ventana activa, inactividad, apps abiertas) |
| `event-bus/` | Bus de eventos pub/subsingleton para comunicación entre módulos |
| `database/` | Inicialización de índices vectoriales (sqlite-vec) |
