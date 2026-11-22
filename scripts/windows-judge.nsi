; Wrap the tested, unchanged desktop installer for the judge distribution.
; makensis requires INSTALLER_FILE, JUDGE_RESOURCE and OUTPUT_FILE at build time.
Unicode true
RequestExecutionLevel user
Name "zhai 评委安装程序（Windows x64 测试版）"
OutFile "${OUTPUT_FILE}"
SilentInstall silent
AutoCloseWindow true
SetCompress off
!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=setup.exe" "${INSTALLER_FILE}"
  File "/oname=judge-tianyi.key" "${JUDGE_RESOURCE}"
  ${GetParameters} $0
  ClearErrors
  ExecWait '"$PLUGINSDIR\setup.exe" /ZHAI-JUDGE $0' $1
  IfErrors 0 +2
    StrCpy $1 1
  SetErrorLevel $1
SectionEnd
