; Plotina (Cinny) per-user installer.
;
; Tauri's CLI refuses to bundle Windows installers on a Linux host, so this
; script builds the NSIS setup from the cross-compiled cinny.exe with makensis.
; It installs into %LOCALAPPDATA%, needs no admin rights, and bootstraps the
; WebView2 runtime when the machine does not have it yet.
;
;   makensis -DVERSION=4.12.8 -DAPPEXE=cinny.exe -DOUTFILE=Plotina-4.12.8-setup.exe installer.nsi

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef EXENAME
  !define EXENAME "cinny.exe"
!endif
!ifndef EXEPATH
  !define EXEPATH "cinny.exe"
!endif
!ifndef OUTFILE
  !define OUTFILE "Plotina-${VERSION}-setup.exe"
!endif

!define APPNAME "Plotina"
!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Plotina"
InstallDirRegKey HKCU "Software\Plotina" "InstallDir"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

Section "Plotina" SecMain
  SetOutPath "$INSTDIR"
  File "${EXEPATH}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Plotina"
  CreateShortcut "$SMPROGRAMS\Plotina\Plotina.lnk" "$INSTDIR\${EXENAME}"
  CreateShortcut "$SMPROGRAMS\Plotina\Удалить Plotina.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\Plotina.lnk" "$INSTDIR\${EXENAME}"

  WriteRegStr HKCU "Software\Plotina" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "plotina.cc"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ; WebView2 runtime: present per-machine or per-user, otherwise install it.
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ReadRegStr $1 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${If} $0 == ""
  ${AndIf} $1 == ""
    DetailPrint "Устанавливаю компонент WebView2…"
    NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    Pop $2
    ${If} $2 == "success"
      ExecWait '"$TEMP\MicrosoftEdgeWebview2Setup.exe" /silent /install'
      Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
    ${Else}
      MessageBox MB_ICONEXCLAMATION "Не удалось скачать WebView2. Приложение может не запуститься; установите WebView2 вручную с сайта Microsoft."
    ${EndIf}
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${EXENAME}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\Plotina\Plotina.lnk"
  Delete "$SMPROGRAMS\Plotina\Удалить Plotina.lnk"
  RMDir "$SMPROGRAMS\Plotina"
  Delete "$DESKTOP\Plotina.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Plotina"
SectionEnd
