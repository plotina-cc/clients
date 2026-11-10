; Plotina Desktop — NSIS installer hooks.
;
; Why this file exists
; --------------------
; The app registers its own URL protocols on every start:
;   apps/desktop/src/protocol.ts -> ProtocolHandler.setAsDefaultProtocolClient()
;   -> Electron's app.setAsDefaultProtocolClient()
; and Chromium writes the association straight into the user hive:
;
;   HKCU\Software\Classes\<scheme>                     = "URL:<scheme> protocol"
;   HKCU\Software\Classes\<scheme>\URL Protocol        = ""
;   HKCU\Software\Classes\<scheme>\shell\open\command  = "<exe>" "%1"
;
; Those runtime keys are not the ones electron-builder's uninstaller created
; (it unregisters only the associations the installer itself wrote), so they
; survived an uninstall while the exe they name was deleted: clicking an
; element:// link afterwards produced a Windows "file not found" error.
; Found by the Windows QA harness, check `uninstall:registry`.
;
; customUnInstall runs inside electron-builder's uninstall section, before the
; install directory is removed, and $INSTDIR is the directory being
; uninstalled. A scheme key is deleted ONLY when its command still points
; inside $INSTDIR: if the app was reinstalled elsewhere, that install's live
; association is left alone instead of being broken by a stale uninstaller.
;
; Wiring
; ------
; electron-builder picks this file up through the default value of
; nsis.include (build/installer.nsh inside the app directory). That default is
; what we rely on: apps/desktop/electron-builder.ts assembles its config from a
; whitelist of variant fields, so an "nsis.include" key in
; element-desktop/build.plotina.json would be read by nobody. scripts/build.sh
; and the "Apply Plotina desktop sources" step of
; .github/workflows/build-element-desktop.yml copy this file to
; apps/desktop/build/installer.nsh (element-desktop/tests/test_installer_nsh.py
; fails when either copy step disappears).

!include "LogicLib.nsh"

; Everything below runs in the uninstaller section, where NSIS only allows
; functions declared with the "un." prefix — electron-builder's shipped
; StrContains.nsh helper is installer-only and cannot be called from there.
Var PlotinaScheme
Var PlotinaCommand
Var PlotinaNeedle
Var PlotinaHaystack
Var PlotinaNeedleLen
Var PlotinaHaystackLen
Var PlotinaIndex
Var PlotinaSlice
Var PlotinaResult

; Substring search over two strings the caller has already lowercased:
; pushes the needle when it occurs in the haystack, "" otherwise.
; Stack in (top first): needle, haystack. Stack out: result.
Function un.PlotinaStrContains
  Pop $PlotinaNeedle
  Pop $PlotinaHaystack
  StrCpy $PlotinaResult ""
  StrLen $PlotinaNeedleLen $PlotinaNeedle
  StrLen $PlotinaHaystackLen $PlotinaHaystack
  StrCmp $PlotinaNeedleLen 0 plotina_sc_done
  StrCpy $PlotinaIndex 0
  plotina_sc_loop:
    IntCmp $PlotinaIndex $PlotinaHaystackLen plotina_sc_done plotina_sc_body plotina_sc_done
  plotina_sc_body:
    StrCpy $PlotinaSlice $PlotinaHaystack $PlotinaNeedleLen $PlotinaIndex
    StrCmp $PlotinaSlice $PlotinaNeedle 0 plotina_sc_next
      StrCpy $PlotinaResult $PlotinaNeedle
      Goto plotina_sc_done
  plotina_sc_next:
    IntOp $PlotinaIndex $PlotinaIndex + 1
    Goto plotina_sc_loop
  plotina_sc_done:
  Push $PlotinaResult
FunctionEnd

; Deletes HKCU\Software\Classes\<scheme> when that scheme's
; shell\open\command points into this installation. Scheme name comes in on the
; stack. $0-$2 are used as scratch; the surrounding uninstall section keeps its
; state in named vars at this point.
Function un.PlotinaRemoveRuntimeProtocolKey
  Pop $PlotinaScheme
  ; Without an install dir the needle would degrade to a bare backslash and the
  ; comparison would match (and delete) a live association of another install.
  ${If} $INSTDIR == ""
    DetailPrint "Plotina: no INSTDIR in the uninstaller context, leaving protocol registrations alone"
    Return
  ${EndIf}
  ReadRegStr $PlotinaCommand HKCU "Software\Classes\$PlotinaScheme\shell\open\command" ""
  ${If} $PlotinaCommand == ""
    DetailPrint "Plotina: no $PlotinaScheme protocol registration to clean up"
    Return
  ${EndIf}

  ; Case-insensitive substring match: Chromium writes the exe path with the
  ; casing the process was started with, which need not match $INSTDIR
  ; character for character. CharLower lowercases the buffer in place.
  StrCpy $0 "$INSTDIR\"
  StrCpy $1 "$PlotinaCommand"
  System::Call 'user32::CharLower(t r0) t .r0'
  System::Call 'user32::CharLower(t r1) t .r1'

  Push $1                       ; haystack: the registered command
  Push $0                       ; needle: "$INSTDIR\"
  Call un.PlotinaStrContains
  Pop $2

  ${If} $2 != ""
    DeleteRegKey HKCU "Software\Classes\$PlotinaScheme"
    DetailPrint "Plotina: removed the $PlotinaScheme protocol registration that pointed into $INSTDIR"
  ${Else}
    DetailPrint "Plotina: kept the $PlotinaScheme protocol registration, it does not point into $INSTDIR"
  ${EndIf}
FunctionEnd

; Electron-builder inserts this macro into its uninstall section. All three
; schemes the app can register at runtime (see "protocols" in
; build.plotina.json) are covered.
!macro customUnInstall
  Push "element"
  Call un.PlotinaRemoveRuntimeProtocolKey
  Push "io.element.desktop"
  Call un.PlotinaRemoveRuntimeProtocolKey
  Push "cc.plotina.element"
  Call un.PlotinaRemoveRuntimeProtocolKey
!macroend
