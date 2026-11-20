; V1.2 local candidate: current user only, optional desktop entry.
!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!addincludedir "${__FILEDIR__}"
!include "hydcurve-file-icon.nsh"

!ifndef BUILD_UNINSTALLER
Var v12Desktop
Var v12DesktopCheckbox
Var upgradeExisting
Var wizardCaption

!macro customHeader
  Caption "$wizardCaption"
!macroend
!include "WordFunc.nsh"

; The generated addDesktopLink macro consumes this predicate. Keep its upgrade,
; rename and uninstall logic, while adding the visible user choice.
!undef isNoDesktopShortcut
!define isNoDesktopShortcut `"" v12NoDesktopShortcut ""`
!macro _v12NoDesktopShortcut _a _b _t _f
  StrCmp $v12Desktop "0" `${_t}` `${_f}`
!macroend

!macro compareInstalledVersion next previous result
  ; WordFunc compares numeric segments. A final release also supersedes its own prereleases.
  StrLen ${result} "${next}-"
  StrCpy ${result} "${previous}" ${result}
  ${If} ${result} == "${next}-"
    StrCpy ${result} "1"
  ${Else}
    ${VersionCompare} "${next}" "${previous}" ${result}
  ${EndIf}
!macroend

!macro customInit
  ${If} ${isForAllUsers}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${If} $perMachineInstallationFolder != ""
    ; Do not take over a machine-wide installation with this per-user candidate.
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro setInstallModePerUser
  StrCpy $wizardCaption "Deatalos 安装"
  StrCpy $upgradeExisting "0"
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $0 != ""
  ${AndIf} $perUserInstallationFolder != ""
    !insertmacro compareInstalledVersion "${VERSION}" "$0" $1
    ${If} $1 == "1"
      StrCpy $upgradeExisting "1"
      StrCpy $wizardCaption "Deatalos 自动升级"
    ${EndIf}
  ${EndIf}
  StrCpy $v12Desktop "1"
  ${StdUtils.TestParameter} $0 "no-desktop-shortcut"
  ${If} $0 == "true"
    StrCpy $v12Desktop "0"
  ${EndIf}
!macroend

!endif

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Page custom v12ShortcutPage v12ShortcutLeave
!macroend

Function v12ShortcutPage
  !insertmacro MUI_HEADER_TEXT "启动快捷方式" "仅安装给当前 Windows 用户，不写入公用桌面。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "安装后可从桌面或开始菜单打开 Deatalos 进阶工作台。工程请保存在安装目录以外。"
  Pop $0
  ${NSD_CreateCheckbox} 0 45u 100% 20u "在当前用户桌面创建启动快捷方式"
  Pop $v12DesktopCheckbox
  ${If} $v12Desktop == "1"
    ${NSD_Check} $v12DesktopCheckbox
  ${EndIf}
  ${If} $upgradeExisting == "1"
    !insertmacro MUI_HEADER_TEXT "自动升级" "继续后将自动升级当前用户的 Deatalos 进阶工作台。"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:自动升级"
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function v12ShortcutLeave
  ${NSD_GetState} $v12DesktopCheckbox $v12Desktop
FunctionEnd
!endif
