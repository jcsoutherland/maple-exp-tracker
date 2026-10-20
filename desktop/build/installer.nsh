; Registers the mapleoverlay:// link at install, so the website can open the app straight away (even before its first
; run), and removes it on uninstall. The app re-registers it on every start too (main.js registerProtocol).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\mapleoverlay" "" "URL:MS Classic Tracker Overlay"
  WriteRegStr HKCU "Software\Classes\mapleoverlay" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\mapleoverlay\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\mapleoverlay\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\mapleoverlay"
!macroend
