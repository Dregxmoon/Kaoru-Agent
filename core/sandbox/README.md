# Sandbox de procesos

OpenClaw aísla `exec` y `code_execution` en el servidor que crea los procesos:

- Linux: Bubblewrap (`bwrap`) con el workspace como único árbol escribible.
- Windows 10/11: AppContainer de baja integridad, perfil independiente por
  workspace, ACL `Modify` limitada al workspace y Job Object con
  `KILL_ON_JOB_CLOSE`.

El instalador incluye un helper compilado en el runner de Windows. Se copia a
`%LOCALAPPDATA%\KaoruAgent\sandbox` y se valida contra la fuente incluida;
si falta, la aplicación lo compila mediante Windows PowerShell 5.1.

AppContainer recibe la capacidad `internetClient`. Puede leer componentes públicos del
sistema y su perfil privado, pero no los archivos del usuario fuera de las rutas
concedidas. Los descendientes conservan el token AppContainer y pertenecen al
mismo Job Object.

La inicialización relanza el helper dentro del contenedor y escribe una marca en el
workspace. Solo después
de ese self-test `/health` publica `sandbox: "appcontainer"`. Si PowerShell, las
APIs nativas, la creación del perfil, la ACL o el self-test fallan, los comandos
se rechazan: no existe fallback silencioso al host.

`OPENCLAW_SANDBOX=0` conserva la desactivación explícita para diagnóstico. La UI
debe advertir que los comandos ejecutados en ese modo tienen permisos reales.

## Verificación en Windows

Desde PowerShell, en una instalación con Electron reconstruido:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
.\node_modules\electron\dist\electron.exe tests\test_windows_sandbox.js
npm test
```

Al iniciar la aplicación, `GET /health` debe responder con
`"sandbox":"appcontainer"`. Una ruta `cwd` fuera del workspace debe rechazarse.
