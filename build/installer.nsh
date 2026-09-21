!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
!define KAORU_TERMS_URL "https://github.com/Dregxmoon/Kaoru-Agent/blob/produccion/docs/web/terms.html"

Var KaoruTermsCheckbox
Var KaoruTermsLink
Var KaoruPermApplications
Var KaoruPermBrowser
Var KaoruPermScreen
Var KaoruPermPointer
Var KaoruPermKeyboard
Var KaoruPermProcesses
Var KaoruPermCamera
Var KaoruOpenAfterInstall

!macro customPageAfterChangeDir
  Page custom KaoruTermsCreate KaoruTermsLeave
!macroend

Function KaoruTermsCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "Antes de instalar Kaoru, lee y acepta sus términos y condiciones."
  Pop $0
  ${NSD_CreateLink} 0 34u 100% 16u "Abrir términos y condiciones de Kaoru"
  Pop $KaoruTermsLink
  ${NSD_OnClick} $KaoruTermsLink KaoruOpenTerms
  ${NSD_CreateCheckbox} 0 62u 100% 26u "He leído y acepto los términos y condiciones de Kaoru."
  Pop $KaoruTermsCheckbox
  nsDialogs::Show
FunctionEnd

Function KaoruOpenTerms
  ExecShell "open" "${KAORU_TERMS_URL}"
FunctionEnd

Function KaoruTermsLeave
  ${NSD_GetState} $KaoruTermsCheckbox $0
  ${If} $0 != ${BST_CHECKED}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Debes aceptar los términos para instalar Kaoru."
    Abort
  ${EndIf}
FunctionEnd

!macro customFinishPage
  Page custom KaoruFinishCreate KaoruFinishLeave
!macroend

Function KaoruFinishCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 22u "Kaoru está instalado. Elige las capacidades que podrá solicitar."
  Pop $0
  ${NSD_CreateCheckbox} 0 25u 100% 13u "Aplicaciones"
  Pop $KaoruPermApplications
  ${NSD_CreateCheckbox} 0 42u 100% 13u "Navegador y multimedia"
  Pop $KaoruPermBrowser
  ${NSD_CreateCheckbox} 0 59u 100% 13u "Pantalla y accesibilidad"
  Pop $KaoruPermScreen
  ${NSD_CreateCheckbox} 0 76u 100% 13u "Puntero y controles"
  Pop $KaoruPermPointer
  ${NSD_CreateCheckbox} 0 93u 100% 13u "Teclado observado"
  Pop $KaoruPermKeyboard
  ${NSD_CreateCheckbox} 0 110u 100% 13u "Procesos"
  Pop $KaoruPermProcesses
  ${NSD_CreateCheckbox} 0 127u 100% 13u "Cámara"
  Pop $KaoruPermCamera
  ${NSD_CreateLabel} 0 146u 100% 22u "Las capacidades marcadas pedirán autorización en la app. Las demás quedarán bloqueadas; puedes cambiarlas en Ajustes."
  Pop $0
  ${NSD_CreateCheckbox} 0 176u 100% 14u "Abrir Kaoru al terminar la instalación"
  Pop $KaoruOpenAfterInstall
  ${NSD_Check} $KaoruOpenAfterInstall
  nsDialogs::Show
FunctionEnd

!macro KaoruWriteCapability handle id comma
  ${NSD_GetState} ${handle} $1
  StrCpy $R0 "deny"
  ${If} $1 == ${BST_CHECKED}
    StrCpy $R0 "ask"
  ${EndIf}
  FileWrite $0 '{"id":"capability:${id}:","tool":"capability:${id}","path":"","action":"$R0"}${comma}$\r$\n'
!macroend

Function KaoruFinishLeave
  ; No reemplazar permisos ya configurados al actualizar Kaoru.
  IfFileExists "$APPDATA\vtuber-overlay\permissions.json" kaoruLaunch
  CreateDirectory "$APPDATA\vtuber-overlay"
  FileOpen $0 "$APPDATA\vtuber-overlay\permissions.json" w
  FileWrite $0 '{"rules":[$\r$\n'
  !insertmacro KaoruWriteCapability $KaoruPermApplications applications ","
  !insertmacro KaoruWriteCapability $KaoruPermBrowser browser ","
  !insertmacro KaoruWriteCapability $KaoruPermScreen screen ","
  !insertmacro KaoruWriteCapability $KaoruPermPointer pointer ","
  !insertmacro KaoruWriteCapability $KaoruPermKeyboard keyboard ","
  !insertmacro KaoruWriteCapability $KaoruPermProcesses processes ","
  !insertmacro KaoruWriteCapability $KaoruPermCamera camera ""
  FileWrite $0 ']}$\r$\n'
  FileClose $0
  kaoruLaunch:
  ${NSD_GetState} $KaoruOpenAfterInstall $0
  ${If} $0 == ${BST_CHECKED}
    ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
FunctionEnd

!endif

!macro customInstall
  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\asistente.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 "start $\"$\" $\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --workspace $\"%CD%$\" %*$\r$\n"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\asistente.cmd"
  IfSilent keepKaoruData
  MessageBox MB_YESNO|MB_ICONQUESTION "¿También quieres borrar la configuración, memoria, permisos, cachés y credenciales locales de Kaoru? Tus proyectos y documentos no se borrarán." IDNO keepKaoruData
  RMDir /r "$APPDATA\vtuber-overlay"
  RMDir /r "$LOCALAPPDATA\KaoruAgent"
  RMDir /r "$PROFILE\.asistente-personal"
  keepKaoruData:
!macroend
