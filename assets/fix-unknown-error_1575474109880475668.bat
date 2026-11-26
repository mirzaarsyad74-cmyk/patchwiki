@echo off
setlocal
title Steam Unknown Error / Error 518 Repair Tool (.acf Reset ^& Cache Heal)
set "CR_SCRIPT_PATH=%~f0"
set "CR_ARG1=%~1"
set "CR_ARG2=%~2"

where powershell >nul 2>&1
if errorlevel 1 (
    echo [ERROR] PowerShell is required to run this repair script.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$lines = [System.IO.File]::ReadAllLines($env:CR_SCRIPT_PATH); $idx = [Array]::IndexOf($lines, '###___POWERSHELL_SCRIPT_START___###'); if ($idx -lt 0) { throw 'Embedded script marker not found.' }; $code = ($lines[($idx + 1)..($lines.Length - 1)]) -join [Environment]::NewLine; & ([ScriptBlock]::Create($code)) $env:CR_ARG1 $env:CR_ARG2"
set "EXIT_CODE=%ERRORLEVEL%"
exit /b %EXIT_CODE%

###___POWERSHELL_SCRIPT_START___###
param(
    [string]$Arg1 = "",
    [string]$Arg2 = ""
)

$ErrorActionPreference = "Stop"

function Write-Banner {
    try {
        if (-not [Console]::IsOutputRedirected) { Clear-Host }
    } catch {}
    Write-Host "============================================================================" -ForegroundColor Cyan
    Write-Host "   Steam Unknown Error / Error 518 Repair Tool (.acf Reset & Cache Heal)" -ForegroundColor Cyan
    Write-Host "   Safe Mode: Backs up deleted .acf files & keeps game files/saves intact" -ForegroundColor DarkCyan
    Write-Host "============================================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Find-SteamPath {
    $candidates = New-Object System.Collections.Generic.List[string]
    foreach ($regPath in @(
        "HKCU:\Software\Valve\Steam",
        "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam",
        "HKLM:\SOFTWARE\Valve\Steam"
    )) {
        try {
            $item = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
            if ($item.SteamPath) { $candidates.Add(($item.SteamPath -replace '/', '\')) }
            if ($item.InstallPath) { $candidates.Add(($item.InstallPath -replace '/', '\')) }
        } catch {}
    }
    $candidates.Add("C:\Program Files (x86)\Steam")
    $candidates.Add("C:\Program Files\Steam")

    foreach ($c in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($c) -and (Test-Path (Join-Path $c "steam.exe"))) {
            return (Resolve-Path $c).Path
        }
    }
    return $null
}

function Get-SteamLibraryFolders([string]$SteamDir) {
    $libs = New-Object System.Collections.Generic.HashSet[string]([System.StringComparer]::OrdinalIgnoreCase)
    $primaryApps = Join-Path $SteamDir "steamapps"
    if (Test-Path $primaryApps) { [void]$libs.Add($primaryApps) }

    foreach ($vdfRel in @("steamapps\libraryfolders.vdf", "config\libraryfolders.vdf")) {
        $vdfPath = Join-Path $SteamDir $vdfRel
        if (-not (Test-Path $vdfPath)) { continue }
        try {
            $raw = [System.IO.File]::ReadAllText($vdfPath)
            foreach ($m in [regex]::Matches($raw, '"path"\s+"([^"]+)"')) {
                $libRoot = ($m.Groups[1].Value -replace '\\\\', '\').Trim()
                $libApps = Join-Path $libRoot "steamapps"
                if (Test-Path $libApps) {
                    [void]$libs.Add($libApps)
                }
            }
        } catch {}
    }
    return @($libs)
}

function Test-IsUtf16AsciiWord64([uint64]$Value) {
    if ($Value -eq 0) { return $false }
    $printable = 0
    for ($lane = 0; $lane -lt 4; $lane++) {
        $ch = [uint16](($Value -shr ($lane * 16)) -band 0xFFFF)
        if ($ch -eq 0) { continue }
        if ($ch -ge 0x20 -and $ch -le 0x7E) {
            $printable++
        } else {
            return $false
        }
    }
    return $printable -ge 3
}

function Inspect-AcfFile([string]$AcfPath, [string]$SteamAppsDir) {
    $fn = [System.IO.Path]::GetFileName($AcfPath)
    $appId = ""
    if ($fn -match '^appmanifest_(\d+)\.acf$') { $appId = $Matches[1] }

    $len = (Get-Item $AcfPath).Length
    if ($len -eq 0) {
        return [PSCustomObject]@{
            AppId           = $appId
            Name            = "(0-byte corrupt .acf)"
            Path            = $AcfPath
            SteamAppsDir    = $SteamAppsDir
            StateFlags      = 0L
            UpdateResult    = -1L
            BytesToDownload = 0L
            HasStagingDir   = $false
            HasCorruptDepot = $true
            IsBroken        = $true
            Reason          = "0-byte empty/corrupt .acf file"
        }
    }

    $raw = ""
    try { $raw = [System.IO.File]::ReadAllText($AcfPath) } catch {
        return [PSCustomObject]@{
            AppId           = $appId
            Name            = "(unreadable .acf)"
            Path            = $AcfPath
            SteamAppsDir    = $SteamAppsDir
            StateFlags      = 0L
            UpdateResult    = -1L
            BytesToDownload = 0L
            HasStagingDir   = $false
            HasCorruptDepot = $true
            IsBroken        = $true
            Reason          = "Unreadable .acf file"
        }
    }

    $name = if ($raw -match '"name"\s+"([^"]*)"') { $Matches[1] } else { "App $appId" }
    [int64]$stateFlags = if ($raw -match '"StateFlags"\s+"(-?\d+)"') { [int64]$Matches[1] } else { 0 }
    [int64]$updateResult = if ($raw -match '"UpdateResult"\s+"(-?\d+)"') { [int64]$Matches[1] } else { 0 }
    [int64]$bytesToDl = if ($raw -match '"BytesToDownload"\s+"(-?\d+)"') { [int64]$Matches[1] } else { 0 }

    $dlDir = Join-Path (Join-Path $SteamAppsDir "downloading") $appId
    $tmpDir = Join-Path (Join-Path $SteamAppsDir "temp") $appId
    $hasStaging = (Test-Path $dlDir) -or (Test-Path $tmpDir)

    $hasCorruptDepot = $false
    foreach ($sec in @('"InstalledDepots"', '"StagedDepots"', '"MountedDepots"')) {
        $idx = $raw.IndexOf($sec, [System.StringComparison]::OrdinalIgnoreCase)
        if ($idx -lt 0) { continue }
        $slice = $raw.Substring($idx, [Math]::Min(8192, $raw.Length - $idx))
        foreach ($dm in [regex]::Matches($slice, '"(\d{8,20})"\s*\{')) {
            [uint64]$did = 0
            if ([uint64]::TryParse($dm.Groups[1].Value, [ref]$did) -and $did -ge 100000000) {
                $hasCorruptDepot = $true
                break
            }
        }
        if ($hasCorruptDepot) { break }
        foreach ($mm in [regex]::Matches($slice, '"manifest"\s+"(\d+)"')) {
            [uint64]$mval = 0
            if ([uint64]::TryParse($mm.Groups[1].Value, [ref]$mval) -and ($mval -eq 0 -or (Test-IsUtf16AsciiWord64 $mval))) {
                $hasCorruptDepot = $true
                break
            }
        }
        if ($hasCorruptDepot) { break }
    }

    $reasons = New-Object System.Collections.Generic.List[string]
    if ($updateResult -ne 0) { $reasons.Add("UpdateResult=$updateResult") }
    if (($stateFlags -band 0x200) -ne 0) { $reasons.Add("ErrorPause(0x200 / StateFlags=$stateFlags)") }
    elseif ($stateFlags -ne 4) { $reasons.Add("NonIdle(StateFlags=$stateFlags)") }
    if ($hasStaging) { $reasons.Add("Active/Stuck Staging Folder") }
    if ($hasCorruptDepot) { $reasons.Add("Corrupt Depot Entry") }

    return [PSCustomObject]@{
        AppId           = $appId
        Name            = $name
        Path            = $AcfPath
        SteamAppsDir    = $SteamAppsDir
        StateFlags      = $stateFlags
        UpdateResult    = $updateResult
        BytesToDownload = $bytesToDl
        HasStagingDir   = $hasStaging
        HasCorruptDepot = $hasCorruptDepot
        IsBroken        = ($reasons.Count -gt 0)
        Reason          = ($reasons -join ", ")
    }
}

function Stop-SteamCleanly([string]$SteamDir) {
    $steamProcs = Get-Process -Name "steam" -ErrorAction SilentlyContinue
    if (-not $steamProcs) {
        Write-Host "  [OK] Steam is not running." -ForegroundColor Green
        return
    }

    Write-Host "  Stopping Steam cleanly so in-memory caches do not overwrite .acf fixes..." -ForegroundColor Yellow
    $steamExe = Join-Path $SteamDir "steam.exe"
    if (Test-Path $steamExe) {
        try { Start-Process -FilePath $steamExe -ArgumentList "-shutdown" -WindowStyle Hidden } catch {}
    }

    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Get-Process -Name "steam" -ErrorAction SilentlyContinue)) {
            Write-Host "  [OK] Steam stopped cleanly." -ForegroundColor Green
            return
        }
    }

    Write-Host "  Steam still open; terminating steam.exe & steamwebhelper.exe..." -ForegroundColor Yellow
    Stop-Process -Name "steam" -Force -ErrorAction SilentlyContinue
    Stop-Process -Name "steamwebhelper" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "  [OK] Steam stopped." -ForegroundColor Green
}

function Start-SteamCleanly([string]$SteamDir) {
    $steamExe = Join-Path $SteamDir "steam.exe"
    if (Test-Path $steamExe) {
        Write-Host "  Launching Steam..." -ForegroundColor Cyan
        Start-Process -FilePath $steamExe
    }
}

function Heal-AcfText([string]$Raw) {
    $updated = $Raw
    # Reset non-zero UpdateResult
    $updated = [regex]::Replace($updated, '("UpdateResult"\s+")(-?\d+)(")', {
        param($m)
        if ($m.Groups[2].Value -ne "0") { return $m.Groups[1].Value + "0" + $m.Groups[3].Value }
        return $m.Value
    })
    # Clear 0x200 (Error/Pause) and stuck update/staging bits back cleanly when StateFlags has 0x200 or stuck download
    $updated = [regex]::Replace($updated, '("StateFlags"\s+")(\d+)(")', {
        param($m)
        [uint64]$flags = [uint64]$m.Groups[2].Value
        if (($flags -band 0x200) -ne 0) {
            $clean = $flags -band (-bnot [uint64]0x200)
            if ($clean -eq 0) { $clean = 4 }
            return $m.Groups[1].Value + $clean.ToString() + $m.Groups[3].Value
        }
        return $m.Value
    })
    return $updated
}

function Optimize-OstMirrors([string]$SteamDir) {
    $isOst = (Test-Path (Join-Path $SteamDir "OpenSteamTool.dll")) -or (Test-Path (Join-Path $SteamDir "opensteamtool.toml"))
    if (-not $isOst) { return $false }

    $luaDir = Join-Path $SteamDir "config\lua"
    New-Item -ItemType Directory -Path $luaDir -Force | Out-Null
    $manifestLua = Join-Path $luaDir "manifest.lua"
    $marker = "-- Managed by CloudRedirect: Smart Manifest Mirror Resolver"
    $luaBody = @"
$marker
function fetch_manifest_code_ex(app_id, depot_id, gid)
    local function extract_code(body)
        if not body then return nil end
        local json_code = body:match('"content"%s*:%s*"(%d+)"')
        if json_code and #json_code >= 6 then return json_code end
        local plain = body:match("^%s*(%d+)%s*$")
        if plain and #plain >= 6 then return plain end
        return nil
    end
    local gid_str = tostring(gid)
    local depot_str = tostring(depot_id)
    local body, st = http_get("https://manifest.steam.run/api/manifest/" .. gid_str)
    if st == 200 then local c = extract_code(body); if c then return c end end
    body, st = http_get("http://gmrc.wudrm.com/manifest/" .. gid_str)
    if st == 200 then local c = extract_code(body); if c then return c end end
    body, st = http_get("https://manifest.manifestdex.com/" .. gid_str, { ["User-Agent"] = "ManifestDeX/1.0" })
    if st == 200 then local c = extract_code(body); if c then return c end end
    body, st = http_get("https://20770407.xyz/manifest/" .. depot_str .. "/" .. gid_str)
    if st == 200 then local c = extract_code(body); if c then return c end end
    return nil
end
function fetch_manifest_code(gid) return fetch_manifest_code_ex(0, 0, gid) end
"@
    if (-not (Test-Path $manifestLua) -or ([System.IO.File]::ReadAllText($manifestLua) -match [regex]::Escape($marker))) {
        [System.IO.File]::WriteAllText($manifestLua, $luaBody, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  [FIXED] Installed healthy mirror failover resolver -> config\lua\manifest.lua" -ForegroundColor Green
    }

    $ostToml = Join-Path $SteamDir "opensteamtool.toml"
    if (Test-Path $ostToml) {
        try {
            $txt = [System.IO.File]::ReadAllText($ostToml)
            $upd = $txt -replace '(?m)^(\s*)failover\s*=\s*false\b', '${1}failover = true'
            $upd = $upd -replace '(?m)^(\s*)url\s*=\s*"20770407"', '${1}url = "steamrun"'
            if ($upd -ne $txt) {
                [System.IO.File]::WriteAllText($ostToml, $upd, [System.Text.UTF8Encoding]::new($false))
                Write-Host "  [FIXED] Updated opensteamtool.toml mirror priority (steamrun + failover)" -ForegroundColor Green
            }
        } catch {}
    }
    return $true
}

function Sync-AutoUpdateLuas([string]$SteamDir) {
    $stDir = Join-Path $SteamDir "config\stplug-in"
    if (-not (Test-Path $stDir)) { return 0 }
    $synced = 0
    foreach ($file in Get-ChildItem -Path $stDir -Filter "*.lua" -File -ErrorAction SilentlyContinue) {
        if ($file.BaseName -notmatch '^\d+$') { continue }
        $appId = $file.BaseName
        $raw = [System.IO.File]::ReadAllText($file.FullName)
        if ($raw -notmatch '(?m)^\s*--\s*setManifestid\s*\(') { continue }
        try {
            $pics = Invoke-RestMethod -Uri "https://api.steamcmd.net/v1/info/$appId" -TimeoutSec 8
            $depots = $pics.data.$appId.depots
            if (-not $depots) { continue }
            $live = @{}
            foreach ($p in $depots.PSObject.Properties) {
                if ($p.Name -match '^\d+$' -and $p.Value.manifests.public.gid) {
                    $live[$p.Name] = @{ Gid = [string]$p.Value.manifests.public.gid; Size = [string]$p.Value.manifests.public.size }
                }
            }
            if ($live.Count -eq 0) { continue }
            $state = @{ Changed = $false }
            $updated = [regex]::Replace($raw, '(?im)^([ \t]*)(?:--\s*)?setManifestid\s*\(\s*(\d+)\s*,\s*"(\d+)"(?:\s*,\s*(\d+))?\s*\).*$', {
                param($m)
                $dep = $m.Groups[2].Value
                if ($live.ContainsKey($dep)) {
                    $g = $live[$dep].Gid
                    $s = $live[$dep].Size
                    $sz = if ($s -and $s -match '^\d+$' -and $s -ne '0') { ", $s" } elseif ($m.Groups[4].Value) { ", $($m.Groups[4].Value)" } else { "" }
                    $state.Changed = $true
                    return "$($m.Groups[1].Value)setManifestid($dep, `"$g`"$sz)"
                }
                return $m.Value
            })
            if ($state.Changed -and $updated -ne $raw) {
                [System.IO.File]::WriteAllText($file.FullName, $updated, [System.Text.UTF8Encoding]::new($false))
                Write-Host "  [SYNCED] $appId.lua updated to latest public Steam build (fixes 135MB drop)" -ForegroundColor Green
                $synced++
            }
        } catch {}
    }
    return $synced
}

function Clean-CommonSteamCaches([string]$SteamDir, [string[]]$LibraryAppsDirs, [string[]]$TargetAppIds, [bool]$ClearAppInfoVdf) {
    # 1. Remove 0-byte or tiny (< 64 bytes) corrupt depotcache manifests
    $depotDir = Join-Path $SteamDir "depotcache"
    if (Test-Path $depotDir) {
        Get-ChildItem -Path $depotDir -Filter "*.manifest" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -lt 64 } |
            ForEach-Object {
                Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
                Write-Host "  [CLEAN] Removed corrupt empty depot manifest: $($_.Name)" -ForegroundColor Yellow
            }
    }

    # 2. Ensure opensteamtool.toml failover=true if installed
    $ostToml = Join-Path $SteamDir "opensteamtool.toml"
    if (Test-Path $ostToml) {
        try {
            $txt = [System.IO.File]::ReadAllText($ostToml)
            if ($txt -match '(?m)^\s*failover\s*=\s*false\b') {
                $txt = $txt -replace '(?m)^(\s*)failover\s*=\s*false\b', '${1}failover = true'
                [System.IO.File]::WriteAllText($ostToml, $txt, [System.Text.UTF8Encoding]::new($false))
                Write-Host "  [FIXED] Enabled failover = true in opensteamtool.toml" -ForegroundColor Green
            }
        } catch {}
    }

    # 3. Clear Steam httpcache (and appinfo/packageinfo when rebuilding .acfs)
    $httpCache = Join-Path $SteamDir "appcache\httpcache"
    if (Test-Path $httpCache) {
        Remove-Item -Path $httpCache -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  [CLEAN] Cleared appcache\httpcache" -ForegroundColor DarkGray
    }
    if ($ClearAppInfoVdf) {
        foreach ($vdfName in @("appinfo.vdf", "packageinfo.vdf")) {
            $vdfPath = Join-Path (Join-Path $SteamDir "appcache") $vdfName
            if (Test-Path $vdfPath) {
                Remove-Item $vdfPath -Force -ErrorAction SilentlyContinue
                Write-Host "  [CLEAN] Removed appcache\$vdfName (Steam will refresh cleanly)" -ForegroundColor DarkGray
            }
        }
    }

    # 4. Clear downloading & temp folders for targeted/stuck apps (or all 0-byte acfs)
    foreach ($appsDir in $LibraryAppsDirs) {
        foreach ($sub in @("downloading", "temp")) {
            $subDir = Join-Path $appsDir $sub
            if (-not (Test-Path $subDir)) { continue }
            if ($TargetAppIds -and $TargetAppIds.Count -gt 0) {
                foreach ($aid in $TargetAppIds) {
                    foreach ($item in @(
                        (Join-Path $subDir $aid),
                        (Join-Path $subDir ("state_${aid}_*.patch"))
                    )) {
                        Get-Item -Path $item -ErrorAction SilentlyContinue | ForEach-Object {
                            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                            Write-Host "  [CLEAN] Cleared $sub\$($_.Name)" -ForegroundColor Yellow
                        }
                    }
                }
            }
        }

        Get-ChildItem -Path $appsDir -Filter "appmanifest_*.acf" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -eq 0 } |
            ForEach-Object {
                Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
                Write-Host "  [CLEAN] Removed 0-byte corrupt $($_.Name)" -ForegroundColor Yellow
            }
    }
}

function Backup-And-DeleteAcf([object[]]$AcfItems, [string]$SteamDir) {
    if (-not $AcfItems -or $AcfItems.Count -eq 0) { return 0 }
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupDir = Join-Path $SteamDir "cloud_redirect\acf_backups\$stamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    $pathMap = New-Object System.Collections.Generic.List[string]
    $deleted = 0
    foreach ($item in $AcfItems) {
        if (-not (Test-Path $item.Path)) { continue }
        $fn = [System.IO.Path]::GetFileName($item.Path)
        $dest = Join-Path $backupDir $fn
        Copy-Item -Path $item.Path -Destination $dest -Force
        $pathMap.Add("$fn|$($item.Path)")
        Remove-Item -Path $item.Path -Force -ErrorAction Stop
        Write-Host "  [DELETED] $fn ($($item.Name)) -> backup saved to $dest" -ForegroundColor Green
        $deleted++
    }
    if ($pathMap.Count -gt 0) {
        [System.IO.File]::WriteAllLines((Join-Path $backupDir "restore_map.txt"), $pathMap, [System.Text.UTF8Encoding]::new($false))
    }
    return $deleted
}

# ============================================================================
# Main Entry
# ============================================================================
Write-Banner

$steamDir = Find-SteamPath
if (-not $steamDir) {
    $steamDir = Read-Host "Steam not found automatically. Enter full Steam folder path"
    $steamDir = $steamDir.Trim().Trim('"')
}
if ([string]::IsNullOrWhiteSpace($steamDir) -or -not (Test-Path (Join-Path $steamDir "steam.exe"))) {
    Write-Host "[ERROR] Valid Steam installation not found." -ForegroundColor Red
    if (-not $Arg1) { Read-Host "Press Enter to exit" }
    exit 1
}

Write-Host "[OK] Steam Directory: $steamDir" -ForegroundColor Green
$libs = Get-SteamLibraryFolders $steamDir
Write-Host "[OK] Found $($libs.Count) Steam library folder(s)." -ForegroundColor DarkGray
Write-Host ""

$allAcfs = New-Object System.Collections.Generic.List[object]
foreach ($lib in $libs) {
    Get-ChildItem -Path $lib -Filter "appmanifest_*.acf" -File -ErrorAction SilentlyContinue | ForEach-Object {
        $allAcfs.Add((Inspect-AcfFile $_.FullName $lib))
    }
}

$brokenAcfs = @($allAcfs | Where-Object { $_.IsBroken })

# Non-interactive CLI shortcuts (optional: Fix-Steam-Unknown-Error.bat --check | Fix-Steam-Unknown-Error.bat <AppId> [--delete])
if ($Arg1 -eq "--check") {
    Write-Host "Scanned $($allAcfs.Count) appmanifest(s), found $($brokenAcfs.Count) stuck/broken manifest(s)."
    foreach ($b in $brokenAcfs) {
        Write-Host "  AppID $($b.AppId) | $($b.Name) | $($b.Reason)" -ForegroundColor Yellow
    }
    exit 0
}

if ($Arg1 -match '^\d+$') {
    $targetId = $Arg1
    $matches = @($allAcfs | Where-Object { $_.AppId -eq $targetId })
    Write-Host "[CLI Mode] Targeting AppID $targetId..." -ForegroundColor Cyan
    Stop-SteamCleanly $steamDir
    Clean-CommonSteamCaches $steamDir $libs @($targetId) ($Arg2 -ne "--heal-only")
    if ($Arg2 -eq "--heal-only") {
        foreach ($m in $matches) {
            $raw = [System.IO.File]::ReadAllText($m.Path)
            $healed = Heal-AcfText $raw
            [System.IO.File]::WriteAllText($m.Path, $healed, [System.Text.UTF8Encoding]::new($false))
            Write-Host "  [HEALED] appmanifest_$targetId.acf ($($m.Name))" -ForegroundColor Green
        }
    } else {
        $cnt = Backup-And-DeleteAcf $matches $steamDir
        if ($cnt -eq 0) { Write-Host "  [INFO] No appmanifest_$targetId.acf found on disk (staging caches still cleaned)." -ForegroundColor Yellow }
    }
    Start-SteamCleanly $steamDir
    exit 0
}

# Interactive Diagnostic Output
Write-Host "Scanned $($allAcfs.Count) installed game manifest(s):" -ForegroundColor White
if ($brokenAcfs.Count -eq 0) {
    Write-Host "  [INFO] No errored flags detected right now, but Steam may still cache a corrupt .acf." -ForegroundColor Yellow
} else {
    Write-Host "  Found $($brokenAcfs.Count) stuck/errored manifest(s):" -ForegroundColor Yellow
    foreach ($b in $brokenAcfs) {
        Write-Host ("   - [{0}] {1} :: {2}" -f $b.AppId, $b.Name, $b.Reason) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Choose repair action:" -ForegroundColor Cyan
Write-Host "  [1] Smart Auto-Fix (Heal .acf + Sync Auto-Update Lua + Fix Mirrors + Cache)"
Write-Host "  [2] Backup & DELETE Stuck/Errored .acf Files + Reset Cache (Best for Unknown Error!)"
Write-Host "  [3] Backup & DELETE Specific Game .acf by AppID (Enter AppID manually)"
Write-Host "  [4] Fix Auto-Update Size Drop (135MB) + Optimize OpenSteamTool Mirrors Only"
Write-Host "  [5] Restore Backed-Up .acf Files (Undo previous deletion)"
Write-Host "  [6] Exit"
Write-Host ""

$choice = Read-Host "Enter option [1-6]"

switch ($choice.Trim()) {
    "1" {
        [void](Optimize-OstMirrors $steamDir)
        [void](Sync-AutoUpdateLuas $steamDir)
        if ($brokenAcfs.Count -eq 0) {
            Write-Host "  [INFO] No broken .acf flags detected; clearing caches and restarting Steam..." -ForegroundColor Yellow
            Stop-SteamCleanly $steamDir
            Clean-CommonSteamCaches $steamDir $libs @() $false
            Start-SteamCleanly $steamDir
            break
        }
        Stop-SteamCleanly $steamDir
        $targetIds = @($brokenAcfs | ForEach-Object { $_.AppId })
        Clean-CommonSteamCaches $steamDir $libs $targetIds $false
        foreach ($b in $brokenAcfs) {
            if (Test-Path $b.Path) {
                $raw = [System.IO.File]::ReadAllText($b.Path)
                $healed = Heal-AcfText $raw
                if ($healed -ne $raw) {
                    [System.IO.File]::WriteAllText($b.Path, $healed, [System.Text.UTF8Encoding]::new($false))
                    Write-Host "  [HEALED] $([System.IO.Path]::GetFileName($b.Path)) ($($b.Name))" -ForegroundColor Green
                }
            }
        }
        Start-SteamCleanly $steamDir
        Write-Host ""
        Write-Host "[DONE] Smart Auto-Fix finished. If a game STILL shows Unknown Error, re-run and pick [2] or [3]." -ForegroundColor Green
    }
    "2" {
        if ($brokenAcfs.Count -eq 0) {
            Write-Host "  [WARN] No automatically detected broken .acf files." -ForegroundColor Yellow
            Write-Host "  Use Option [3] to enter the exact Steam AppID showing Unknown Error." -ForegroundColor Yellow
            break
        }
        Write-Host ""
        Write-Host "  The following .acf files will be BACKED UP and removed (game files in steamapps\common are NOT touched):" -ForegroundColor Yellow
        foreach ($b in $brokenAcfs) {
            Write-Host "   - appmanifest_$($b.AppId).acf ($($b.Name))"
        }
        $confirm = Read-Host "Proceed? (Y/N)"
        if ($confirm -notmatch '^[Yy]') {
            Write-Host "Cancelled."
            break
        }
        Stop-SteamCleanly $steamDir
        [void](Optimize-OstMirrors $steamDir)
        [void](Sync-AutoUpdateLuas $steamDir)
        $targetIds = @($brokenAcfs | ForEach-Object { $_.AppId })
        Clean-CommonSteamCaches $steamDir $libs $targetIds $true
        $deleted = Backup-And-DeleteAcf $brokenAcfs $steamDir
        Start-SteamCleanly $steamDir
        Write-Host ""
        Write-Host "[DONE] Removed $deleted stuck .acf file(s) & cleared Steam download caches!" -ForegroundColor Green
        Write-Host "Next step in Steam: Click 'Install' on the game in the SAME library folder." -ForegroundColor Cyan
        Write-Host "Steam will discover your existing game files without redownloading cleanly!" -ForegroundColor Cyan
    }
    "3" {
        Write-Host ""
        Write-Host "Tip: Find AppID in Steam Store URL (store.steampowered.com/app/<AppID>/) or game Properties -> Updates." -ForegroundColor DarkGray
        $inputId = (Read-Host "Enter Game AppID (numbers only)").Trim()
        if ($inputId -notmatch '^\d+$') {
            Write-Host "[ERROR] Invalid AppID." -ForegroundColor Red
            break
        }
        $matches = @($allAcfs | Where-Object { $_.AppId -eq $inputId })
        if ($matches.Count -eq 0) {
            Write-Host "[WARN] appmanifest_$inputId.acf was not found in any Steam library." -ForegroundColor Yellow
            $cleanOnly = Read-Host "Still clear downloading/temp staging & httpcache for AppID $inputId? (Y/N)"
            if ($cleanOnly -notmatch '^[Yy]') { break }
        } else {
            foreach ($m in $matches) {
                Write-Host "  Target: $($m.Path) ($($m.Name))" -ForegroundColor Yellow
            }
        }
        Stop-SteamCleanly $steamDir
        [void](Optimize-OstMirrors $steamDir)
        Clean-CommonSteamCaches $steamDir $libs @($inputId) $true
        $deleted = Backup-And-DeleteAcf $matches $steamDir
        Start-SteamCleanly $steamDir
        Write-Host ""
        Write-Host "[DONE] Reset complete for AppID $inputId (deleted $deleted .acf file(s) with backup)." -ForegroundColor Green
        Write-Host "Next step in Steam: Click 'Install' on the game into the SAME library folder -> 'Discovering existing files'." -ForegroundColor Cyan
    }
    "4" {
        Stop-SteamCleanly $steamDir
        [void](Optimize-OstMirrors $steamDir)
        $synced = Sync-AutoUpdateLuas $steamDir
        Start-SteamCleanly $steamDir
        Write-Host ""
        Write-Host "[DONE] Optimized OpenSteamTool manifest mirrors and synced $synced Auto-Update .lua file(s)!" -ForegroundColor Green
    }
    "5" {
        $backupRoot = Join-Path $steamDir "cloud_redirect\acf_backups"
        if (-not (Test-Path $backupRoot)) {
            Write-Host "[INFO] No .acf backups found in $backupRoot." -ForegroundColor Yellow
            break
        }
        $latest = Get-ChildItem -Path $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if (-not $latest) {
            Write-Host "[INFO] No backup snapshots found." -ForegroundColor Yellow
            break
        }
        $files = Get-ChildItem -Path $latest.FullName -Filter "appmanifest_*.acf" -File
        if (-not $files) {
            Write-Host "[INFO] Latest backup folder is empty." -ForegroundColor Yellow
            break
        }
        Stop-SteamCleanly $steamDir
        $restoreTargets = @{}
        $mapFile = Join-Path $latest.FullName "restore_map.txt"
        if (Test-Path $mapFile) {
            foreach ($line in [System.IO.File]::ReadAllLines($mapFile)) {
                $parts = $line -split '\|', 2
                if ($parts.Length -eq 2 -and -not [string]::IsNullOrWhiteSpace($parts[1])) {
                    $restoreTargets[$parts[0]] = $parts[1]
                }
            }
        }
        $primaryApps = Join-Path $steamDir "steamapps"
        foreach ($f in $files) {
            $destPath = if ($restoreTargets.ContainsKey($f.Name)) { $restoreTargets[$f.Name] } else { Join-Path $primaryApps $f.Name }
            Copy-Item -Path $f.FullName -Destination $destPath -Force
            Write-Host "  [RESTORED] $($f.Name) -> $destPath" -ForegroundColor Green
        }
        Start-SteamCleanly $steamDir
    }
    default {
        Write-Host "Exiting without changes."
    }
}

Write-Host ""
Read-Host "Press Enter to exit"
