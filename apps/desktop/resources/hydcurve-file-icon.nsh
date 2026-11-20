; Register icons for the two formats imported through the workbench.
!include "LogicLib.nsh"

!macro registerFileIcon ext prog description
  Push $0
  ReadRegStr $0 HKCR ".${ext}" ""
  ${If} $0 == ""
  ${OrIf} $0 == "${prog}"
    ClearErrors
    WriteRegStr HKCU "Software\Classes\${prog}" "" "${description}"
    WriteRegStr HKCU "Software\Classes\${prog}\DefaultIcon" "" '$\"$INSTDIR\resources\icons\${ext}.ico$\",0'
    WriteRegStr HKCU "Software\Classes\.${ext}" "" "${prog}"
    ${If} ${Errors}
      DetailPrint "Could not register the .${ext} file icon for this user."
    ${Else}
      System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    ${EndIf}
  ${EndIf}
  Pop $0
!macroend

!macro unregisterFileIcon ext prog
  Push $0
  ReadRegStr $0 HKCU "Software\Classes\${prog}\DefaultIcon" ""
  ; An older install must not remove a newer installation's registration.
  ${If} $0 == '$\"$INSTDIR\resources\icons\${ext}.ico$\",0'
    ReadRegStr $0 HKCU "Software\Classes\.${ext}" ""
    ${If} $0 == "${prog}"
      DeleteRegValue HKCU "Software\Classes\.${ext}" ""
      DeleteRegKey /ifempty HKCU "Software\Classes\.${ext}"
    ${EndIf}
    DeleteRegKey HKCU "Software\Classes\${prog}\DefaultIcon"
    DeleteRegValue HKCU "Software\Classes\${prog}" ""
    DeleteRegKey /ifempty HKCU "Software\Classes\${prog}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  !insertmacro registerFileIcon "hydcurve" "Deatalos.HydCurve" "Deatalos Curve Data"
  !insertmacro registerFileIcon "hydframe" "Deatalos.HydFrame" "Deatalos 图框文件"
!macroend

!macro customUnInstall
  !insertmacro unregisterFileIcon "hydcurve" "Deatalos.HydCurve"
  !insertmacro unregisterFileIcon "hydframe" "Deatalos.HydFrame"
!macroend
