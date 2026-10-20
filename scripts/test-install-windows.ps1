# ---------------------------------------------------------------------------
# scripts/test-install-windows.ps1 - recette d'install.bat sur Windows (issue #3)
#
# Execute par .github/workflows/install-windows.yml sur un runner Windows
# heberge par GitHub (Windows Server, compte administrateur). Peut aussi etre
# lance a la main sur un PC Windows, depuis la racine du depot, dans un
# PowerShell 7 administrateur :
#     pwsh -File scripts/test-install-windows.ps1
# ATTENTION en local : le script installe puis DESINSTALLE IAO (utilisateur et
# systeme) ; le dossier %APPDATA%\ai-manager n'est jamais supprime.
#
# Scenarios (criteres d'acceptation de l'issue #3) :
#   1. auto-build : sans dist\IAO-win32-x64, install.bat lance npm install +
#      npm run dist:win ;
#   2. installation utilisateur : %LOCALAPPDATA%\Programs\IAO, raccourcis Menu
#      Demarrer (normal + mode debug), PATH utilisateur ;
#   3. lancement reel du binaire installe (test de fumee) ;
#   4. /desktop : raccourci Bureau ; reinstallation idempotente ;
#   5. /system : %ProgramFiles%\IAO et Menu Demarrer commun ;
#   6. /uninstall et /uninstall /system : suppression, mais %APPDATA%\ai-manager
#      PRESERVE ;
#   7. /help et option inconnue.
# Sortie : tableau des controles (console + resume GitHub), code 1 si un echec.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $root 'install.bat'
$script:resultats = @()
$shell = New-Object -ComObject WScript.Shell

function Controle([string]$nom, [bool]$ok, [string]$detail = '') {
  $script:resultats += [pscustomobject]@{ Controle = $nom; Resultat = $(if ($ok) { 'OK' } else { 'ECHEC' }); Detail = $detail }
  $etat = if ($ok) { 'ok    ' } else { 'NOT OK' }
  Write-Host "$etat - $nom $(if ($detail) { "($detail)" })"
}

function Lancer([string]$arguments) {
  Write-Host "`n>>> install.bat $arguments"
  & cmd.exe /d /c "`"$bat`" $arguments"
  return $LASTEXITCODE
}

function Cible([string]$lnk) {
  if (-not (Test-Path $lnk)) { return $null }
  return $shell.CreateShortcut($lnk)
}

function PathUtilisateur { return [Environment]::GetEnvironmentVariable('Path', 'User') }

$userPrefix = Join-Path $env:LOCALAPPDATA 'Programs\IAO'
$userMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\IAO'
$sysPrefix = Join-Path $env:ProgramFiles 'IAO'
$sysMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\IAO'
$bureau = [Environment]::GetFolderPath('Desktop')
$donnees = Join-Path $env:APPDATA 'ai-manager'
$build = Join-Path $root 'dist\IAO-win32-x64\IAO.exe'

# --- 1 + 2. Auto-build puis installation utilisateur ------------------------
Controle 'etat initial : aucun build Windows' (-not (Test-Path $build))
$pathAvant = PathUtilisateur
$code = Lancer ''
Controle 'install.bat (utilisateur) : code 0' ($code -eq 0) "code $code"
Controle 'auto-build : dist\IAO-win32-x64\IAO.exe produit' (Test-Path $build)
Controle 'binaire copie dans %LOCALAPPDATA%\Programs\IAO' (Test-Path (Join-Path $userPrefix 'IAO.exe'))
$lnk = Cible (Join-Path $userMenu 'IAO.lnk')
Controle 'raccourci Menu Demarrer vers IAO.exe' ($null -ne $lnk -and $lnk.TargetPath -ieq (Join-Path $userPrefix 'IAO.exe')) $(if ($lnk) { $lnk.TargetPath })
$dbg = Cible (Join-Path $userMenu 'IAO (mode debug).lnk')
Controle 'raccourci Menu Demarrer (mode debug) avec --iao-debug' ($null -ne $dbg -and $dbg.Arguments -eq '--iao-debug')
Controle 'pas de raccourci Bureau sans /desktop' (-not (Test-Path (Join-Path $bureau 'IAO.lnk')))
$pathApres = PathUtilisateur
$entrees = @(($pathApres -split ';') | Where-Object { $_ -ieq $userPrefix })
Controle 'PATH utilisateur : dossier IAO ajoute une fois' ($entrees.Count -eq 1) "$($entrees.Count) entree(s)"
# setx PATH "%PATH%;..." recopie le PATH SYSTEME dans le PATH utilisateur :
# on verifie qu'aucune entree systeme n'a ete dupliquee.
$machine = @(([Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';') | Where-Object { $_ })
$avant = @(($pathAvant -split ';') | Where-Object { $_ })
$dupliquees = @(($pathApres -split ';') | Where-Object { $_ -and ($machine -contains $_) -and -not ($avant -contains $_) })
Controle 'PATH utilisateur : aucune entree du PATH systeme recopiee' ($dupliquees.Count -eq 0) "$($dupliquees.Count) entree(s) recopiee(s)"

# --- 3. Lancement reel du binaire installe ----------------------------------
$env:SMOKE_APP_BINARY = Join-Path $userPrefix 'IAO.exe'
Push-Location $root
& node test-electron/smoke-packaged.js
$smoke = $LASTEXITCODE
Pop-Location
Remove-Item Env:SMOKE_APP_BINARY
Controle 'binaire installe : demarrage, interface chargee, arret' ($smoke -eq 0) "code $smoke"

# --- 4. /desktop et reinstallation idempotente ------------------------------
$code = Lancer '/desktop'
Controle 'install.bat /desktop : code 0' ($code -eq 0) "code $code"
$bur = Cible (Join-Path $bureau 'IAO.lnk')
Controle 'raccourci Bureau vers IAO.exe' ($null -ne $bur -and $bur.TargetPath -ieq (Join-Path $userPrefix 'IAO.exe'))
$entrees = @(((PathUtilisateur) -split ';') | Where-Object { $_ -ieq $userPrefix })
Controle 'reinstallation : PATH toujours avec une seule entree IAO' ($entrees.Count -eq 1) "$($entrees.Count) entree(s)"

# --- 5. Installation systeme (le runner est administrateur) -----------------
$code = Lancer '/system'
Controle 'install.bat /system : code 0' ($code -eq 0) "code $code"
Controle 'binaire copie dans %ProgramFiles%\IAO' (Test-Path (Join-Path $sysPrefix 'IAO.exe'))
$slnk = Cible (Join-Path $sysMenu 'IAO.lnk')
Controle 'raccourci Menu Demarrer commun vers %ProgramFiles%\IAO' ($null -ne $slnk -and $slnk.TargetPath -ieq (Join-Path $sysPrefix 'IAO.exe'))

# --- 6. Desinstallation : donnees preservees --------------------------------
New-Item -ItemType Directory -Force -Path $donnees | Out-Null
$marqueur = Join-Path $donnees 'marqueur-recette.txt'
Set-Content -Path $marqueur -Value 'comptes et sessions a preserver'
$code = Lancer '/uninstall'
Controle 'install.bat /uninstall : code 0' ($code -eq 0) "code $code"
Controle 'desinstallation : %LOCALAPPDATA%\Programs\IAO supprime' (-not (Test-Path $userPrefix))
Controle 'desinstallation : raccourcis Menu Demarrer supprimes' (-not (Test-Path (Join-Path $userMenu 'IAO.lnk')) -and -not (Test-Path (Join-Path $userMenu 'IAO (mode debug).lnk')))
Controle 'desinstallation : raccourci Bureau supprime' (-not (Test-Path (Join-Path $bureau 'IAO.lnk')))
Controle 'desinstallation : %APPDATA%\ai-manager PRESERVE' (Test-Path $marqueur)
$entrees = @(((PathUtilisateur) -split ';') | Where-Object { $_ -ieq $userPrefix })
Controle 'desinstallation : dossier IAO retire du PATH utilisateur' ($entrees.Count -eq 0) "$($entrees.Count) entree(s)"
$code = Lancer '/uninstall /system'
Controle 'install.bat /uninstall /system : code 0' ($code -eq 0) "code $code"
Controle 'desinstallation systeme : %ProgramFiles%\IAO supprime' (-not (Test-Path $sysPrefix))
Controle 'desinstallation systeme : Menu Demarrer commun nettoye' (-not (Test-Path (Join-Path $sysMenu 'IAO.lnk')))
Controle 'desinstallation systeme : %APPDATA%\ai-manager toujours PRESERVE' (Test-Path $marqueur)
Remove-Item -Force $marqueur

# --- 7. Aide et option inconnue ---------------------------------------------
$code = Lancer '/help'
Controle 'install.bat /help : code 0' ($code -eq 0) "code $code"
$code = Lancer '/inconnue'
Controle 'option inconnue refusee : code 1' ($code -eq 1) "code $code"

# --- Bilan --------------------------------------------------------------------
$echecs = @($script:resultats | Where-Object { $_.Resultat -ne 'OK' })
Write-Host ''
$script:resultats | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
if ($env:GITHUB_STEP_SUMMARY) {
  $md = @('## Recette install.bat (issue #3)', '', '| Controle | Resultat | Detail |', '|---|---|---|')
  foreach ($r in $script:resultats) { $md += "| $($r.Controle) | $($r.Resultat) | $($r.Detail) |" }
  $md += ''
  $md += "Bilan : $($script:resultats.Count - $echecs.Count)/$($script:resultats.Count) controles OK."
  $md -join "`n" | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
}
if ($echecs.Count -gt 0) { Write-Host "$($echecs.Count) controle(s) en echec."; exit 1 }
Write-Host "Recette install.bat : $($script:resultats.Count) controles OK."
exit 0
