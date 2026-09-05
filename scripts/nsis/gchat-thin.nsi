; Gchat thin WebView2 shell NSIS installer (Windows production path)
!include "MUI2.nsh"
!include "FileFunc.nsh"

; APP_VERSION is injected by scripts/build-win-thin.js (read from package.json).
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif

Name "Gchat"
OutFile "..\..\src-desktop-win\target\release\bundle\Gchat_${APP_VERSION}_x64-setup.exe"
Unicode True
InstallDir "$LOCALAPPDATA\Programs\Gchat"
InstallDirRegKey HKCU "Software\Gchat" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_ICON "..\..\src-desktop-win\assets\icon.ico"
!define MUI_UNICON "..\..\src-desktop-win\assets\icon.ico"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File "..\..\src-desktop-win\target\release\Gchat.exe"
  File "..\..\src-desktop-win\assets\icon.ico"
  File "..\..\src-desktop-win\assets\icon.png"
  File "..\..\public\gchat_icon.png"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Gchat" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat" "DisplayName" "Gchat ${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat" "DisplayIcon" "$INSTDIR\Gchat.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat" "Publisher" "Gchat"

  CreateDirectory "$SMPROGRAMS\Gchat"
  CreateShortCut "$SMPROGRAMS\Gchat\Gchat.lnk" "$INSTDIR\Gchat.exe" "" "$INSTDIR\icon.ico"
  CreateShortCut "$DESKTOP\Gchat.lnk" "$INSTDIR\Gchat.exe" "" "$INSTDIR\icon.ico"

  Exec "$INSTDIR\Gchat.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\Gchat.exe"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\icon.png"
  Delete "$INSTDIR\gchat_icon.png"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Gchat\Gchat.lnk"
  RMDir "$SMPROGRAMS\Gchat"
  Delete "$DESKTOP\Gchat.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Gchat"
  DeleteRegKey HKCU "Software\Gchat"
SectionEnd
