<# : AutoFixAndAddToSteam.bat
@echo off
setlocal
set "SCRIPT_ARGS=%*"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create((Get-Content -LiteralPath '%~f0' -Raw)))"
echo.
pause
exit /b %ERRORLEVEL%
#>

# ==============================================================================
# AutoFixAndAddToSteam.bat
# Auto-detects Steam & Game path, patches batch file with -Wait,
# and configures Steam Launch Options for AppID 1938090.
# ==============================================================================

$AppId = "1938090"
$rawArg = $env:SCRIPT_ARGS
if ($rawArg) {
    $rawArg = $rawArg.Trim().Trim('"')
}

$Host.UI.RawUI.WindowTitle = "Steam & Game Auto-Patcher (AppID $AppId)"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Steam & Game Auto-Patcher (.bat)                       " -ForegroundColor Cyan
Write-Host "   Target AppID: $AppId (Call of Duty HQ)                 " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# ------------------------------------------------------------------------------
# 1. AUTO-DETECT STEAM INSTALLATION
# ------------------------------------------------------------------------------
Write-Host "[1/5] Auto-detecting Steam installation..." -ForegroundColor Yellow

function Get-SteamPath {
    $regKeys = @(
        "HKCU:\Software\Valve\Steam",
        "HKLM:\SOFTWARE\Valve\Steam",
        "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam"
    )
    foreach ($k in $regKeys) {
        if (Test-Path $k) {
            $p = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).SteamPath
            if (-not $p) { $p = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).InstallPath }
            if ($p -and (Test-Path $p)) { return (Resolve-Path $p).Path }
        }
    }

    $proc = Get-Process steam -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path) {
        return (Split-Path $proc.Path -Parent)
    }

    $defaults = @(
        "C:\Program Files (x86)\Steam",
        "C:\Program Files\Steam",
        "D:\Steam",
        "E:\Steam",
        "F:\Steam"
    )
    foreach ($d in $defaults) {
        if (Test-Path $d) { return $d }
    }
    return $null
}

$steamPath = Get-SteamPath

if (-not $steamPath -or -not (Test-Path $steamPath)) {
    Write-Host "  -> [ERROR] Could not auto-detect Steam installation directory." -ForegroundColor Red
    $manualSteam = Read-Host "Please enter the path to your Steam folder"
    if (Test-Path $manualSteam) {
        $steamPath = (Resolve-Path $manualSteam).Path
    } else {
        Write-Error "Invalid Steam directory."
        exit 1
    }
}

Write-Host "  -> [FOUND] Steam installed at: $steamPath" -ForegroundColor Green

# ------------------------------------------------------------------------------
# 2. AUTO-DETECT GAME INSTALLATION (AppID 1938090)
# ------------------------------------------------------------------------------
Write-Host "`n[2/5] Auto-detecting game installation path (AppID $AppId)..." -ForegroundColor Yellow

function Get-GameInstallPath {
    param ([string]$SteamDir, [string]$TargetAppId)

    $libraryFolders = [System.Collections.Generic.List[string]]::new()
    $libraryFolders.Add($SteamDir)

    $libVdf = Join-Path $SteamDir "steamapps\libraryfolders.vdf"
    if (Test-Path $libVdf) {
        $content = Get-Content $libVdf -Raw
        $matches = [regex]::Matches($content, '"path"\s*"([^"]+)"')
        foreach ($m in $matches) {
            $p = $m.Groups[1].Value.Replace('\\', '\')
            if ((Test-Path $p) -and -not $libraryFolders.Contains($p)) {
                $libraryFolders.Add($p)
            }
        }
    }

    foreach ($lib in $libraryFolders) {
        $manifestPath = Join-Path $lib "steamapps\appmanifest_$TargetAppId.acf"
        if (Test-Path $manifestPath) {
            $manifestContent = Get-Content $manifestPath -Raw
            if ($manifestContent -match '"installdir"\s*"([^"]+)"') {
                $installDirName = $Matches[1]
                $fullPath = Join-Path $lib "steamapps\common\$installDirName"
                if (Test-Path $fullPath) {
                    return $fullPath
                }
            }
        }
    }

    $commonFallbacks = @(
        (Join-Path $SteamDir "steamapps\common\Call of Duty HQ"),
        "C:\Program Files (x86)\Steam\steamapps\common\Call of Duty HQ",
        "D:\SteamLibrary\steamapps\common\Call of Duty HQ",
        "E:\SteamLibrary\steamapps\common\Call of Duty HQ"
    )
    foreach ($fb in $commonFallbacks) {
        if (Test-Path $fb) { return $fb }
    }
    return $null
}

$gamePath = Get-GameInstallPath -SteamDir $steamPath -TargetAppId $AppId

if ($gamePath) {
    Write-Host "  -> [FOUND] Game installed at: $gamePath" -ForegroundColor Green
} else {
    Write-Host "  -> [WARNING] AppID $AppId not found in Steam manifests (checking local folder)." -ForegroundColor DarkYellow
}

# ------------------------------------------------------------------------------
# 3. LOCATE TARGET BATCH FILE
# ------------------------------------------------------------------------------
Write-Host "`n[3/5] Locating target batch file (!start_sp26.bat)..." -ForegroundColor Yellow

$targetBat = $null

if ($rawArg -and (Test-Path -LiteralPath $rawArg)) {
    $targetBat = (Resolve-Path -LiteralPath $rawArg).Path
}

if (-not $targetBat -and $gamePath) {
    $gameCandidate = Join-Path $gamePath "!start_sp26.bat"
    if (Test-Path $gameCandidate) {
        $targetBat = $gameCandidate
    } else {
        $found = Get-ChildItem -Path $gamePath -Filter "*.bat" | Where-Object { $_.Name -like "*sp26*.bat" } | Select-Object -First 1
        if ($found) { $targetBat = $found.FullName }
    }
}

if (-not $targetBat) {
    $localCandidate = Join-Path $PSScriptRoot "!start_sp26.bat"
    if (Test-Path $localCandidate) {
        $targetBat = $localCandidate
    }
}

if (-not $targetBat) {
    $manualBat = Read-Host "Please enter the full path to your .bat file"
    if (Test-Path -LiteralPath $manualBat) {
        $targetBat = (Resolve-Path -LiteralPath $manualBat).Path
    } else {
        Write-Error "Batch file not found: $manualBat"
        exit 1
    }
}

Write-Host "  -> [FOUND] Target Batch File: $targetBat" -ForegroundColor Green

# ------------------------------------------------------------------------------
# 4. AUTO EDIT AND SAVE: ADD -Wait FLAG
# ------------------------------------------------------------------------------
Write-Host "`n[4/5] Checking and patching batch file..." -ForegroundColor Yellow

$batContent = [System.IO.File]::ReadAllText($targetBat)
$patternWithoutWait = '(?i)(Start-Process\s+-FilePath\s+[''"]%~f0[''"]\s+-WorkingDirectory\s+[''"]%~dp0[''"]\s+-Verb\s+RunAs)(?!\s+-Wait)'
$alreadyHasWait = $batContent -match '(?i)Start-Process\s+-FilePath\s+[''"]%~f0[''"]\s+-WorkingDirectory\s+[''"]%~dp0[''"]\s+-Verb\s+RunAs\s+-Wait'

if ($alreadyHasWait) {
    Write-Host "  -> [SKIP] File already contains '-Wait'. No edit needed." -ForegroundColor Cyan
} elseif ($batContent -match $patternWithoutWait) {
    $backupPath = "$targetBat.bak"
    [System.IO.File]::Copy($targetBat, $backupPath, $true)
    Write-Host "  -> Created backup: $backupPath" -ForegroundColor Gray

    $newBatContent = $batContent -replace $patternWithoutWait, '$1 -Wait'
    [System.IO.File]::WriteAllText($targetBat, $newBatContent, [System.Text.Encoding]::Default)
    Write-Host "  -> [OK] Successfully added '-Wait' and saved $targetBat" -ForegroundColor Green
} else {
    Write-Host "  -> [NOTICE] Exact elevation pattern not found; checking if custom." -ForegroundColor DarkYellow
}

# ------------------------------------------------------------------------------
# 5. STEAM PROCESS CHECK & UPDATE LAUNCH OPTIONS
# ------------------------------------------------------------------------------
Write-Host "`n[5/5] Configuring Steam Launch Options for AppID $AppId..." -ForegroundColor Yellow

$steamProc = Get-Process steam -ErrorAction SilentlyContinue
$wasSteamRunning = [bool]$steamProc

if ($steamProc) {
    Write-Host "  -> Steam is running. Closing Steam temporarily to save configuration..." -ForegroundColor Yellow
    Stop-Process -Name steam -Force
    $timeout = 0
    while ((Get-Process steam -ErrorAction SilentlyContinue) -and ($timeout -lt 8)) {
        Start-Sleep -Seconds 1
        $timeout++
    }
    Write-Host "  -> Steam closed." -ForegroundColor Green
}

$targetLaunchOption = "`"$targetBat`" %command%"
Write-Host "  -> Setting Launch Option to: $targetLaunchOption" -ForegroundColor Cyan

$userDataDir = Join-Path $steamPath "userdata"
if (-not (Test-Path $userDataDir)) {
    Write-Error "Steam userdata directory not found at $userDataDir"
    exit 1
}

$userProfiles = Get-ChildItem -Path $userDataDir -Directory | Where-Object { $_.Name -match '^\d+$' -and $_.Name -ne '0' }

function Update-SteamVdf {
    param ($VdfPath, $AppId, $LaunchOption)

    $lines = [System.IO.File]::ReadAllLines($VdfPath, [System.Text.Encoding]::UTF8)
    $escapedVal = $LaunchOption.Replace('\', '\\').Replace('"', '\"')

    $newLines = [System.Collections.Generic.List[string]]::new()
    $inApps = $false
    $inTargetApp = $false
    $appDepth = 0
    $launchOptionsUpdated = $false
    $appIdFound = $false

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $trimmed = $line.Trim()

        if (-not $inApps -and $trimmed -eq '"apps"') {
            $inApps = $true
            $newLines.Add($line)
            continue
        }

        if ($inApps -and -not $inTargetApp -and $trimmed -eq "`"$AppId`"") {
            $inTargetApp = $true
            $appIdFound = $true
            $appDepth = 0
            $newLines.Add($line)
            continue
        }

        if ($inTargetApp) {
            if ($trimmed -eq '{') {
                $appDepth++
                $newLines.Add($line)
                continue
            }
            if ($trimmed -eq '}') {
                $appDepth--
                if ($appDepth -eq 0) {
                    if (-not $launchOptionsUpdated) {
                        $newLines.Add("`t`t`t`t`t`t`"LaunchOptions`"`t`t`"$escapedVal`"")
                        $launchOptionsUpdated = $true
                    }
                    $inTargetApp = $false
                    $newLines.Add($line)
                    continue
                }
            }

            if ($appDepth -eq 1 -and $trimmed -match '^"LaunchOptions"') {
                $newLines.Add("`t`t`t`t`t`t`"LaunchOptions`"`t`t`"$escapedVal`"")
                $launchOptionsUpdated = $true
                continue
            }
        }

        $newLines.Add($line)
    }

    if (-not $appIdFound) {
        $rebuilt = [System.Collections.Generic.List[string]]::new()
        $foundAppsOpen = $false
        foreach ($line in $newLines) {
            $rebuilt.Add($line)
            if (-not $foundAppsOpen -and $line.Trim() -eq '"apps"') {
                $foundAppsOpen = $true
            } elseif ($foundAppsOpen -and $line.Trim() -eq '{') {
                $rebuilt.Add("`t`t`t`t`"$AppId`"")
                $rebuilt.Add("`t`t`t`t{")
                $rebuilt.Add("`t`t`t`t`t`t`"LaunchOptions`"`t`t`"$escapedVal`"")
                $rebuilt.Add("`t`t`t`t}")
                $foundAppsOpen = $false
                $appIdFound = $true
                $launchOptionsUpdated = $true
            }
        }
        $newLines = $rebuilt
    }

    $vdfBackup = "$VdfPath.bak"
    [System.IO.File]::Copy($VdfPath, $vdfBackup, $true)
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllLines($VdfPath, $newLines, $utf8NoBom)
}

$updatedCount = 0
foreach ($profile in $userProfiles) {
    $vdfPath = Join-Path $profile.FullName "config\localconfig.vdf"
    if (Test-Path $vdfPath) {
        Write-Host "  -> Updating Steam profile: $($profile.Name)..." -NoNewline
        try {
            Update-SteamVdf -VdfPath $vdfPath -AppId $AppId -LaunchOption $targetLaunchOption
            Write-Host " [OK]" -ForegroundColor Green
            $updatedCount++
        } catch {
            Write-Host " [ERROR: $_]" -ForegroundColor Red
        }
    }
}

Write-Host "`n==========================================================" -ForegroundColor Green
Write-Host "   PATCHING COMPLETE! SUMMARY:                            " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  - Steam Detected:     $steamPath"
Write-Host "  - Game Detected:      $gamePath"
Write-Host "  - Batch File Patched: $targetBat"
Write-Host "  - Steam AppID:        $AppId"
Write-Host "  - Launch Option Set:  $targetLaunchOption"
Write-Host "  - Profiles Updated:   $updatedCount"
Write-Host ""

if ($wasSteamRunning) {
    $restart = Read-Host "Steam was closed to save settings. Restart Steam now? (Y/N)"
    if ($restart -eq 'Y' -or $restart -eq 'y' -or $restart -eq '') {
        $steamExe = Join-Path $steamPath "steam.exe"
        if (Test-Path $steamExe) {
            Write-Host "Starting Steam..." -ForegroundColor Cyan
            Start-Process -FilePath $steamExe
        }
    }
}

Write-Host "Done! You can close this window." -ForegroundColor Green