; Windows shell file associations for the current user.
!include "LogicLib.nsh"
!ifndef DEATALOS_CLASSES
  !define DEATALOS_CLASSES "Software\Classes"
!endif

!macro registerFormat ext prog description icon
  Push $0
  WriteRegStr HKCU "${DEATALOS_CLASSES}\${prog}" "" "${description}"
  WriteRegStr HKCU "${DEATALOS_CLASSES}\${prog}\DefaultIcon" "" '"$INSTDIR\resources\icons\${icon}.ico",0'
  WriteRegStr HKCU "${DEATALOS_CLASSES}\${prog}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "${DEATALOS_CLASSES}\.${ext}\OpenWithProgids" "${prog}" ""
  !ifdef DEATALOS_TEST_CLASSES
    ReadRegStr $0 HKCU "${DEATALOS_CLASSES}\.${ext}" ""
  !else
    ReadRegStr $0 HKCR ".${ext}" ""
  !endif
  ${If} $0 == ""
    WriteRegStr HKCU "${DEATALOS_CLASSES}\.${ext}" "" "${prog}"
  ${EndIf}
  Pop $0
!macroend

!macro removeEmptyAssociationKey key
  ClearErrors
  EnumRegValue $0 HKCU "${key}" 0
  ${If} ${Errors}
    DeleteRegKey /ifempty HKCU "${key}"
  ${EndIf}
!macroend

!macro unregisterFormat ext prog
  Push $0
  ReadRegStr $0 HKCU "${DEATALOS_CLASSES}\${prog}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegValue HKCU "${DEATALOS_CLASSES}\.${ext}\OpenWithProgids" "${prog}"
    !insertmacro removeEmptyAssociationKey "${DEATALOS_CLASSES}\.${ext}\OpenWithProgids"
    ReadRegStr $0 HKCU "${DEATALOS_CLASSES}\.${ext}" ""
    ${If} $0 == "${prog}"
      DeleteRegValue HKCU "${DEATALOS_CLASSES}\.${ext}" ""
    ${EndIf}
    !insertmacro removeEmptyAssociationKey "${DEATALOS_CLASSES}\.${ext}"
    DeleteRegKey HKCU "${DEATALOS_CLASSES}\${prog}"
  ${EndIf}
  Pop $0
!macroend

!macro customInstall
  !insertmacro registerFormat "hydproj" "Deatalos.HydProj" "Deatalos 工程" "deatalos"
  !insertmacro registerFormat "hydx" "Deatalos.HydX" "Deatalos 单文件工程" "deatalos"
  !insertmacro registerFormat "hydcurve" "Deatalos.HydCurve" "Deatalos 曲线数据" "hydcurve"
  !insertmacro registerFormat "hydframe" "Deatalos.HydFrame" "Deatalos 图框" "hydframe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro unregisterFormat "hydproj" "Deatalos.HydProj"
  !insertmacro unregisterFormat "hydx" "Deatalos.HydX"
  !insertmacro unregisterFormat "hydcurve" "Deatalos.HydCurve"
  !insertmacro unregisterFormat "hydframe" "Deatalos.HydFrame"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
