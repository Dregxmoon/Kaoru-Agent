# Registro de servidores LSP (`infrastructure/lsp/`)

Solo datos: el registro de servidores de lenguaje que el asistente puede arrancar para el **agente de
código**. El cliente LSP vive en `core/lsp/`; este catálogo alimenta la selección de servidores por
archivo.

## `servers.json`

18 definiciones: `typescript`, `javascript`, `python`, `go`, `rust`, `ruby`, `php`, `java`, `c`,
`cpp`, `csharp`, `kotlin`, `swift`, `dart`, `bash`, `lua`, `html`, `css`, `json`, `markdown`.

Cada entrada trae:

| Campo                                                  | Propósito                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `languageId`                                           | Identificador de lenguaje del LSP                                                        |
| `command` / `args`                                     | Binario y argumentos para arrancar el servidor                                           |
| `filePatterns`                                         | Globs de archivos que activan ese servidor                                               |
| `manifests` / `installCmd`                             | Paquetes a instalar (p. ej. `typescript-language-server`) y comando                      |
| `npx` · `heavy` · `workspaceFolders` · `initTimeoutMs` | Flags: vía `npx`, servidor pesado, usa carpetas del workspace, timeout de inicialización |

Se consulta desde `core/lsp/LspManager` al detectar un archivo abierto; los servidores pesados no se
arrancan por defecto.
