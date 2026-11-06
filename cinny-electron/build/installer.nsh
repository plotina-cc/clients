; NSIS include for electron-builder (build/installer.nsh).
;
; Scope note: Tauri cross-grade cleanup is deliberately NOT done here. The
; installed base of the Tauri build is negligible, so Lite ships clean
; installs only; users who happen to have the old build uninstall it
; themselves (Apps & Features) before or after installing this one.
;
; What this file does:
;   customInstall  write an `install-kind` marker next to the binary so the
;                  in-app updater can tell an NSIS install (auto-update:
;                  download -setup exe, run it with /S --updated) from an MSI
;                  install (no marker; manual-download state pointing at
;                  https://plotina.cc/dl/). See src/updater.js.

!macro customInstall
  FileOpen $9 "$INSTDIR\install-kind" w
  FileWrite $9 "nsis"
  FileClose $9
!macroend
