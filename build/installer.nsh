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
