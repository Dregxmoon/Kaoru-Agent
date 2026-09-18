# Distribución a testers y usuarios

La aplicación puede entregarse a testers mediante GitHub Releases. La matriz de CI construye Windows
x64, Linux x64 y macOS x64/arm64, instala el paquete de Windows y ejecuta su smoke test antes de
publicar un tag.

## Recorrido de una persona nueva

1. Descarga el instalador de la última versión.
2. En el primer arranque, el onboarding explica qué es Kaoru y abre el selector de modelos o el panel
   de permisos.
3. El usuario conecta un proveedor, elige el navegador y conserva la política predeterminada de
   preguntar para acciones de impacto.
4. Ajustes permite reemplazar/eliminar claves, reiniciar permisos, limpiar cachés y hacer un
   restablecimiento completo sin tocar workspaces.
5. Actualizaciones se descargan con consentimiento; **Versiones anteriores** abre GitHub Releases
   para instalar manualmente una versión previa si es necesario.

## Firma de paquetes

El workflow está preparado para firmar cuando existan secrets del repositorio. Ningún certificado o
password debe guardarse en Git.

| Plataforma | Secrets requeridos |
| --- | --- |
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` |
| macOS firma | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` |
| macOS notarización | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

Sin esos secrets, los builds continúan siendo utilizables para pruebas, pero Windows SmartScreen y
macOS Gatekeeper pueden mostrar advertencias. La firma y notarización solo pueden considerarse
completas después de configurar certificados reales y verificar el artefacto publicado.

## Prueba externa

Cada tester debe abrir un
[`Informe de prueba externa`](../.github/ISSUE_TEMPLATE/external-test.yml) con sistema, hardware,
instalación, proveedor, tarea ejecutada, consumo observado, errores y resultado de desinstalación. No
se debe anunciar una cantidad de testers ni una auditoría externa hasta que existan informes públicos
de personas independientes.

## Gate antes de distribución pública

- instalador firmado y, en macOS, notarizado;
- onboarding completado en una instalación limpia;
- tarea real de principio a fin con evidencia y recuperación;
- desinstalación conservando datos y desinstalación con limpieza completa;
- informes externos en equipos distintos;
- revisión externa de las superficies priorizadas en [SECURITY.md](../SECURITY.md).
