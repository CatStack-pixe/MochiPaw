!ifndef MOCHIPAW_DATA_ACCESS_NSH
!define MOCHIPAW_DATA_ACCESS_NSH

; Tauri includes this file before defining INSTALLMODE and MAINBINARYNAME.
; Keep their references inside the hook macro, which is expanded afterwards.
!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2

  ; An explicit user SID is required without an interactive desktop. The
  ; helper validates canonical SID syntax without an online account lookup.
  ClearErrors
  ${GetOptions} $CMDLINE "/MOCHIPAW_USER_SID=" $0
  ${IfNot} ${Errors}
    StrCpy $1 0
    System::Call 'advapi32::ConvertStringSidToSidW(w r0, *p .r1) i .r2'
    ${If} $2 = 0
      DetailPrint "Invalid /MOCHIPAW_USER_SID value. Supply a user SID such as S-1-5-21-... ."
      MessageBox MB_OK|MB_ICONSTOP "Invalid /MOCHIPAW_USER_SID value. Supply the SID of the user who will run MochiPaw." /SD IDOK
      SetErrorLevel 1
      Pop $2
      Pop $1
      Pop $0
      Abort
    ${EndIf}
    System::Call 'kernel32::LocalFree(p r1)'
    StrCpy $0 '--user-sid "$0"'
  ${Else}
    ; An elevated install may be running under a different administrator's
    ; credentials. The desktop's user is the intended application user.
    StrCpy $0 "--desktop-user"
    !if "${INSTALLMODE}" == "currentUser"
      UserInfo::GetAccountType
      Pop $1
      ${If} $1 == "User"
        StrCpy $0 "--current-user"
      ${EndIf}
    !else if "${INSTALLMODE}" == "both"
      ${If} $MultiUser.InstallMode == "CurrentUser"
        UserInfo::GetAccountType
        Pop $1
        ${If} $1 == "User"
          StrCpy $0 "--current-user"
        ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}

  ClearErrors
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --mochi-paw-prepare-installer-data $0' $1
  ${If} ${Errors}
    StrCpy $1 "start failed"
  ${EndIf}
  ${If} $1 != 0
    DetailPrint "MochiPaw data-directory setup failed ($1): $INSTDIR\data"
    MessageBox MB_OK|MB_ICONSTOP "MochiPaw data-directory setup failed ($1). Re-run the installer from the intended user's desktop and allow administrator access when requested. For unattended deployment, pass /MOCHIPAW_USER_SID=<user SID>. Check that $INSTDIR\data is a normal directory and its permissions allow the installer to update it." /SD IDOK
    SetErrorLevel 1
    Pop $2
    Pop $1
    Pop $0
    Abort
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend

; No uninstall hook: Tauri removes packaged files only, preserving user data.
!endif
