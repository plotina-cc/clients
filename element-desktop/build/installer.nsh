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
; survived an uninstall while the exe they named was deleted: clicking an
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
; electron-builder picks this file up through nsis.include, which scripts/
; build.sh and the "Apply Plotina desktop sources" step of
; .github/workflows/build-element-desktop.yml point at build/installer.nsh
; explicitly and also copy to apps/desktop/build/installer.nsh (the default
; location). An "nsis.include" key in element-desktop/build.plotina.json would
; be read by nobody: apps/desktop/electron-builder.ts assembles its config from
; a whitelist of variant fields. element-desktop/tests/test_installer_nsh.py
; fails when a copy step disappears.

!include "LogicLib.nsh"

; This include is compiled into BOTH electron-builder passes: the installer and
; the separate BUILD_UNINSTALLER pass. Uninstaller code left in the installer
; pass makes NSIS emit "warning 6020: Uninstaller script code found but
; WriteUninstaller never used", which electron-builder turns into a build
; failure (it spawns makensis with warnings-as-errors). Keep everything behind
; the same define electron-builder uses and the include expands to nothing in
; the installer pass.
!ifdef BUILD_UNINSTALLER

; Everything below runs in the uninstall section, where NSIS only allows
; functions declared with the "un." prefix — electron-builder's shipped
; StrContains.nsh helper is installer-only and cannot be called from there.
; Named vars only: the surrounding uninstall section uses $0-$R9 itself.
Var PlotinaScheme
Var PlotinaCommand
Var PlotinaNeedle
Var PlotinaHaystack
Var PlotinaNeedleLen
Var PlotinaHaystackLen
Var PlotinaIndex
Var PlotinaSlice
Var PlotinaLastChar
Var PlotinaResult

; Case-insensitive substring search. NSIS StrCmp ignores case (StrCmpS is the
; case-sensitive variant), which is what we need: Chromium writes the exe path
; with the casing the process was started with, so $INSTDIR and the registered
; command may differ in case.
;
; Do NOT lowercase the buffers with System::Call 'user32::CharLower': the
; System plugin passes an ANSI char* while NSIS strings are UTF-16, so the
; call garbles the first characters of both strings and the comparison then
; silently fails (this is exactly how the first version of this hook passed
; under wine and did nothing on the Windows runner).
;
; Stack in (top first): needle, haystack. Stack out: the needle when it occurs
; in the haystack, "" otherwise.
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
; stack.
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

  ; Needle is "$INSTDIR<separator>", so a sibling "...\plotina-desktop2" never
  ; matches "...\plotina-desktop".
  StrCpy $PlotinaNeedle "$INSTDIR"
  StrCpy $PlotinaLastChar "$INSTDIR" 1 -1
  ${If} $PlotinaLastChar != "\"
    StrCpy $PlotinaNeedle "$INSTDIR\"
  ${EndIf}

  Push $PlotinaCommand         ; haystack: the registered command
  Push $PlotinaNeedle          ; needle: the install dir plus a separator
  Call un.PlotinaStrContains
  Pop $PlotinaResult

  ${If} $PlotinaResult != ""
    DeleteRegKey HKCU "Software\Classes\$PlotinaScheme"
    DetailPrint "Plotina: removed the $PlotinaScheme protocol registration that pointed into $INSTDIR"
  ${Else}
    DetailPrint "Plotina: kept the $PlotinaScheme protocol registration, it does not point into $INSTDIR"
  ${EndIf}
FunctionEnd

; Electron-builder inserts this macro into its uninstall section.
;
; DO NOT trim this list down to what build.plotina.json declares. The variant
; declares ONE scheme (io.element.desktop, the SSO callback MAS pins); the two
; extra entries here are historical on purpose: element and cc.plotina.element
; were registered by older Plotina Desktop builds and those keys are still in
; the registry of machines that have them. Uninstall has to remove them, or
; they keep pointing at a deleted Plotina-Desktop.exe. New installs never
; create them (protocol.ts registers only the variant's schemes, and the
; declared cc.plotina.element is gone from the build), so this list is
; deliberately a superset of the declared one. element-desktop/tests/
; test_installer_nsh.py checks exactly that.
!macro customUnInstall
  Push "element"
  Call un.PlotinaRemoveRuntimeProtocolKey
  Push "io.element.desktop"
  Call un.PlotinaRemoveRuntimeProtocolKey
  Push "cc.plotina.element"
  Call un.PlotinaRemoveRuntimeProtocolKey
!macroend

!endif ; BUILD_UNINSTALLER
