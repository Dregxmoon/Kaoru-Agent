# Percepción del sistema operativo

Polling en tiempo real del escritorio: aplicación activa, ventanas abiertas, tiempo de inactividad.

## Arquitectura

MarchCore selecciona el sensor según `process.platform`:
- `win32` → OSSensor
- `linux` → LinuxOSSensor
- `darwin` → desactivado

Ambos sensores exponen la misma interfaz: `start()`, `stop()`, `getCurrentContext()`, `getOpenWindows()`, `getTodayHistory()`, `getTodaySummary()`. Emiten eventos al EventBus: `os:app-changed`, `os:app-tick`, `os:idle-changed`, `os:windows-updated`.

## Archivos

### OSSensor.js — Windows
Ejecuta un script PowerShell cada 5 segundos usando Win32 API:
- `GetForegroundWindow()` → ventana activa (proceso + título)
- `GetLastInputInfo()` → tiempo de inactividad
- `EnumWindows()` → lista de ventanas visibles

Clasifica apps en categorías: code, terminal, browser, design, docs, chat, media, api, files, system, game.
Mantiene historial de uso diario para `getTodaySummary()`.

### LinuxOSSensor.js — Linux
Usa herramientas nativas de Linux:
- `hyprctl activewindow` → ventana activa (Hyprland/Wayland)
- `hyprctl clients` → todas las ventanas abiertas
- `loginctl show-session` → tiempo de inactividad vía logind

Mismas categorías de apps y misma interfaz que OSSensor.

### Interfaz común: `getCurrentContext()`

| Campo | Descripción |
|---|---|
| `app` | Nombre interno del proceso |
| `friendlyName` | Nombre legible ("VS Code") |
| `title` | Título de la ventana |
| `category` | code / terminal / browser / ... |
| `elapsed` | Segundos en la app actual |
| `elapsedFormatted` | "12m 30s" |
| `idleSecs` | Segundos sin actividad |
| `idleFormatted` | "5m" |
| `isIdle` | true si idle > 120s |
| `openWindows` | Lista completa de ventanas |
| `openWindowsSummary` | Texto descriptivo |
| `history` | Historial de hoy |
