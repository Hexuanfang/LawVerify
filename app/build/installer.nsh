!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER

Var DesktopShortcutCheckbox
Var CreateDesktopShortcutSelection

!macro customInit
  StrCpy $CreateDesktopShortcutSelection 1
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 8u 100% 12u "创建桌面快捷方式"
  Pop $DesktopShortcutCheckbox
  ${NSD_Check} $DesktopShortcutCheckbox

  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcutSelection
FunctionEnd

!macro customInstall
  ${If} $CreateDesktopShortcutSelection <> 1
    Delete "$newDesktopLink"
  ${EndIf}
!macroend

!endif
