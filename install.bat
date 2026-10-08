@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  install.bat — Installeur Windows de IAO
REM
REM  Installe l'application packagee et l'integre au systeme :
REM    - fichiers dans %LOCALAPPDATA%\Programs\IAO (user) ou %ProgramFiles%\IAO (system)
REM    - raccourci Menu Demarrer (toujours) + Bureau (option /desktop)
REM    - commande dans le PATH (mode utilisateur)
REM    - /uninstall supprime l'app mais PRESERVE %APPDATA%\ai-manager
REM
REM  Usage :
REM    install.bat               Installation utilisateur (sans admin)
REM    install.bat /system       Installation pour tous les comptes (admin)
REM    install.bat /uninstall    Desinstallation (mode utilisateur)
REM    install.bat /uninstall /system
REM    install.bat /desktop      Installer + raccourci Bureau
REM    install.bat /no-desktop   Installer sans raccourci Bureau
REM    install.bat /help        Afficher cette aide
REM
REM  Lot 9 (18/09/2026) : creation. Base sur install.sh (Linux).
REM  Lot 10 (18/09/2026) : corrections validation Windows.
REM ============================================================

set "APP_ID=iao"
set "APP_NAME=IAO"
set "BIN_NAME=IAO"
set "BIN_EXE=IAO.exe"
set "PROJECT_DIR=%~dp0"
REM Retirer le backslash final
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

set "MODE=user"
set "ACTION=install"
REM Par defaut : raccourci Menu Demarrer uniquement (pas de Bureau)
set "DESKTOP_SHORTCUT=0"

REM --- Parse des arguments ---
:parse_args
if "%~1"=="" goto :args_done
set "arg=%~1"
if /i "%arg%"=="/system" (
    set "MODE=system"
    shift
    goto :parse_args
)
if /i "%arg%"=="/user" (
    set "MODE=user"
    shift
    goto :parse_args
)
if /i "%arg%"=="/uninstall" (
    set "ACTION=uninstall"
    shift
    goto :parse_args
)
if /i "%arg%"=="/desktop" (
    set "DESKTOP_SHORTCUT=1"
    shift
    goto :parse_args
)
if /i "%arg%"=="/no-desktop" (
    set "DESKTOP_SHORTCUT=0"
    shift
    goto :parse_args
)
if /i "%arg%"=="/help" goto :show_help
if /i "%arg%"=="-h" goto :show_help
echo Option inconnue : %arg% - voir /help
exit /b 1
:args_done

REM --- Chemins cibles selon la portee ---
if "%MODE%"=="system" (
    REM Verifier les droits admin
    net session >nul 2>&1
    if errorlevel 1 (
        echo /system requiert les droits administrateur.
        echo Relancez en tant qu'administrateur : clic droit ^> Executer en tant qu'administrateur
        exit /b 1
    )
    set "PREFIX=%ProgramFiles%\IAO"
    set "SHORTCUT_DIR=%ProgramData%\Microsoft\Windows\Start Menu\Programs\IAO"
    set "PATH_DIR=%ProgramFiles%\IAO"
) else (
    set "PREFIX=%LOCALAPPDATA%\Programs\IAO"
    set "SHORTCUT_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\IAO"
    set "PATH_DIR=%LOCALAPPDATA%\Programs\IAO"
)

set "SHORTCUT_NAME=IAO"
set "APPDATA_DIR=%APPDATA%\ai-manager"

REM --- Desinstallation ---
if "%ACTION%"=="uninstall" (
    echo Desinstallation ^(%MODE%^)...
    if exist "%PREFIX%" rmdir /s /q "%PREFIX%"
    if exist "%SHORTCUT_DIR%\%SHORTCUT_NAME%.lnk" del /f /q "%SHORTCUT_DIR%\%SHORTCUT_NAME%.lnk"
    if exist "%SHORTCUT_DIR%\%SHORTCUT_NAME% (mode debug).lnk" del /f /q "%SHORTCUT_DIR%\%SHORTCUT_NAME% (mode debug).lnk"
    if exist "%SHORTCUT_DIR%" rmdir /q "%SHORTCUT_DIR%" 2>nul
    if exist "%USERPROFILE%\Desktop\%SHORTCUT_NAME%.lnk" del /f /q "%USERPROFILE%\Desktop\%SHORTCUT_NAME%.lnk"
    echo Termine. Les comptes et sessions restent dans %APPDATA_DIR%
    echo Supprimez ce dossier manuellement si vous voulez tout effacer.
    exit /b 0
)

REM --- Localisation du build ---
REM electron-packager pour Windows sort dans dist/IAO-win32-x64/
set "BUILD_DIR=%PROJECT_DIR%\dist\IAO-win32-x64"

if not exist "%BUILD_DIR%\%BIN_EXE%" (
    echo Aucun build Windows trouve dans %PROJECT_DIR%\dist\
    echo.
    REM Tentative d'auto-build si npm est disponible
    where npm >nul 2>&1
    if errorlevel 1 (
        echo npm n'est pas dans le PATH. Installez Node.js depuis https://nodejs.org/
        echo Puis lancez : cd "%PROJECT_DIR%" ^&^& npm install ^&^& npm run dist:win
        exit /b 1
    )
    echo npm detecte. Construction en cours...
    echo   cd "%PROJECT_DIR%" ^&^& npm install ^&^& npm run dist:win
    pushd "%PROJECT_DIR%"
    call npm install
    if errorlevel 1 (
        echo Erreur lors de npm install.
        popd
        exit /b 1
    )
    call npm run dist:win
    if errorlevel 1 (
        echo Erreur lors de la construction - npm run dist:win
        echo Pour cross-compiler depuis Linux : requiert wine ou un build CI Windows
        popd
        exit /b 1
    )
    popd
    REM Re-verifier que le build est maintenant present
    if not exist "%BUILD_DIR%\%BIN_EXE%" (
        echo Le build n'a pas produit %BIN_EXE% dans %BUILD_DIR%
        exit /b 1
    )
)

echo Build   : %BUILD_DIR%
echo Cible   : %PREFIX%  ^(%MODE%^)

REM --- Copie de l'application - robocopy /MIR ---
REM robocopy /MIR reflete la source : ajoute, met a jour, supprime les fichiers
REM obsoletes. Code retour 0-7 = succes, 8+ = erreur.
if exist "%PREFIX%" rmdir /s /q "%PREFIX%"
mkdir "%PREFIX%" 2>nul
robocopy "%BUILD_DIR%" "%PREFIX%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo Erreur lors de la copie des fichiers - robocopy error %errorlevel%
    exit /b 1
)

REM --- Raccourcis - via VBScript WScript.Shell ---
mkdir "%SHORTCUT_DIR%" 2>nul

REM Cree le script VBScript temporaire pour les raccourcis
set "VBS=%TEMP%\iao_create_shortcut.vbs"

REM Raccourci Menu Demarrer - toujours cree
> "%VBS%" echo Set WshShell = WScript.CreateObject("WScript.Shell")
>> "%VBS%" echo Set shortcut = WshShell.CreateShortcut("%SHORTCUT_DIR%\%SHORTCUT_NAME%.lnk")
>> "%VBS%" echo shortcut.TargetPath = "%PREFIX%\%BIN_EXE%"
>> "%VBS%" echo shortcut.WorkingDirectory = "%PREFIX%"
>> "%VBS%" echo shortcut.Description = "IAO - Gestionnaire de comptes IA"
>> "%VBS%" echo shortcut.IconLocation = "%PREFIX%\%BIN_EXE%,0"
>> "%VBS%" echo shortcut.Save
REM Issue #162 : raccourci Menu Demarrer en mode debug (journal detaille)
>> "%VBS%" echo Set debugShortcut = WshShell.CreateShortcut("%SHORTCUT_DIR%\%SHORTCUT_NAME% (mode debug).lnk")
>> "%VBS%" echo debugShortcut.TargetPath = "%PREFIX%\%BIN_EXE%"
>> "%VBS%" echo debugShortcut.Arguments = "--iao-debug"
>> "%VBS%" echo debugShortcut.WorkingDirectory = "%PREFIX%"
>> "%VBS%" echo debugShortcut.Description = "IAO - mode debug (journal detaille)"
>> "%VBS%" echo debugShortcut.IconLocation = "%PREFIX%\%BIN_EXE%,0"
>> "%VBS%" echo debugShortcut.Save

REM Raccourci Bureau - seulement si /desktop
REM On evite les parentheses de CreateShortcut(...) dans un bloc if()
REM en utilisant un goto/label
if not "%DESKTOP_SHORTCUT%"=="1" goto :skip_desktop
>> "%VBS%" echo Set desktopShortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") ^& "\%SHORTCUT_NAME%.lnk")
>> "%VBS%" echo desktopShortcut.TargetPath = "%PREFIX%\%BIN_EXE%"
>> "%VBS%" echo desktopShortcut.WorkingDirectory = "%PREFIX%"
>> "%VBS%" echo desktopShortcut.Description = "IAO - Gestionnaire de comptes IA"
>> "%VBS%" echo desktopShortcut.IconLocation = "%PREFIX%\%BIN_EXE%,0"
>> "%VBS%" echo desktopShortcut.Save
:skip_desktop

cscript //nologo "%VBS%"
del /f /q "%VBS%" 2>nul

REM --- PATH - mode utilisateur uniquement ---
REM On evite le bloc if() pour %PATH% (expansion prematuree)
REM et on utilise !PATH! (delayed expansion) pour la valeur courante
if not "%MODE%"=="user" goto :skip_path
echo %PATH% | findstr /i /c:"%PATH_DIR%" >nul
if not errorlevel 1 goto :skip_path
echo Ajout de %PATH_DIR% au PATH utilisateur...
setx PATH "!PATH!;%PATH_DIR%" >nul 2>&1
if errorlevel 1 (
    echo Attention : impossible d'ajouter %PATH_DIR% au PATH.
    echo Vous pouvez le faire manuellement via les variables d'environnement.
) else (
    echo PATH mis a jour. Rouvrez un terminal pour utiliser 'iao'.
)
:skip_path

REM --- Verification et conseils ---
echo.
echo IAO installe.
echo    Menu Demarrer : cherchez IAO
if "%DESKTOP_SHORTCUT%"=="1" (
    echo    Bureau        : raccourci IAO cree
) else (
    echo    Bureau        : aucun - utilisez /desktop pour le creer
)
echo    Donnees       : %APPDATA_DIR% - comptes et sessions IA
if "%MODE%"=="system" (
    echo    Desinstaller  : %~f0 /uninstall /system
) else (
    echo    Desinstaller  : %~f0 /uninstall
)
echo.
echo Note : les donnees %APPDATA_DIR% ne sont JAMAIS supprimees par la
echo desinstallation. Supprimez ce dossier manuellement pour tout effacer.

exit /b 0

:show_help
echo install.bat - Installeur Windows de IAO
echo.
echo Usage :
echo   install.bat               Installation utilisateur - sans admin
echo   install.bat /system       Installation pour tous les comptes - admin
echo   install.bat /uninstall    Desinstallation - mode utilisateur
echo   install.bat /uninstall /system
echo   install.bat /desktop      Installer + raccourci Bureau
echo   install.bat /no-desktop   Installer sans raccourci Bureau
echo   install.bat /help        Afficher cette aide
echo.
echo Le dossier %%APPDATA%%\ai-manager - comptes et sessions est PRESERVE
echo lors de la desinstallation.
exit /b 0
