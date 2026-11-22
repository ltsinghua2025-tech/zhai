!include "FileFunc.nsh"
!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "/ZHAI-JUDGE" $R1
  ${IfNot} ${Errors}
    ClearErrors
    CopyFiles /SILENT /FILESONLY "$EXEDIR\judge-tianyi.key" "$INSTDIR"
    ${If} ${Errors}
      SetErrorLevel 1
      Abort "评委模型配置安装失败，请重新运行评委安装包。"
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\judge-tianyi.key"
!macroend
