; XYRA currently needs no custom NSIS lifecycle commands. Keep the four declared hooks
; explicit and empty so Tauri's default per-user install/update/uninstall behavior applies.
!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
