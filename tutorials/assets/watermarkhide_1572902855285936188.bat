@echo off
title Windows Watermark Hider ^& Restorer (PC ^& ROG Ally)

:: 1. Auto-Elevate to Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "BAT_PATH=%~f0"

:MENU
cls
echo ============================================================
echo   Windows Test Mode ^& Insider Watermark Manager
echo   (Supports PC, ROG Ally, Multi-Language ^& 24H2/25H2 Builds)
echo ============================================================
echo.
echo   [1] HIDE Watermarks (Keep Test Mode ON)
echo   [2] RESTORE / UNDO Original Watermarks (.old backups)
echo   [3] CHECK Current Status (BCD Test Mode ^& Backup Files)
echo   [4] EXIT
echo.
set "choice="
set /p "choice=Select an option (1-4): "

if "%choice%"=="1" (
    set "WM_ACTION=HIDE"
    call :RUN_PS
    pause
    goto MENU
)
if "%choice%"=="2" (
    set "WM_ACTION=RESTORE"
    call :RUN_PS
    pause
    goto MENU
)
if "%choice%"=="3" (
    set "WM_ACTION=STATUS"
    call :RUN_PS
    pause
    goto MENU
)
if "%choice%"=="4" exit /b
goto MENU

:RUN_PS
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$code = ((Get-Content -Raw $env:BAT_PATH) -split ('::' + 'PS_BLOCK'))[1]; Invoke-Expression $code"
echo.
exit /b

::PS_BLOCK
$ErrorActionPreference = 'SilentlyContinue'

switch ($env:WM_ACTION) {
    'HIDE' {
        Write-Host '[*] Applying registry suppressions...' -ForegroundColor Cyan
        reg add "HKCU\Control Panel\Desktop" /v PaintDesktopVersion /t REG_DWORD /d 0 /f | Out-Null
        reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v PaintDesktopVersion /t REG_DWORD /d 0 /f | Out-Null

        Write-Host '[*] Scanning all installed language packs and system MUI files...' -ForegroundColor Cyan
        $langs = @((Get-UICulture).Name, (Get-Culture).Name, 'en-US', 'en-GB', 'en-MY') | Where-Object { $_ } | Select-Object -Unique
        Get-ChildItem "$env:WINDIR\System32" -Directory | Where-Object { Test-Path "$($_.FullName)\shell32.dll.mui" } | ForEach-Object { $langs += $_.Name }
        $langs = $langs | Select-Object -Unique

        Write-Host "[*] Target Language Folders: $($langs -join ', ')" -ForegroundColor Cyan

        $targets = @()
        foreach ($l in $langs) {
            $targets += "$env:WINDIR\System32\$l\shell32.dll.mui"
            $targets += "$env:WINDIR\System32\$l\user32.dll.mui"
            $targets += "$env:WINDIR\System32\$l\ExplorerFrame.dll.mui"
            $targets += "$env:WINDIR\Branding\Basebrd\$l\basebrd.dll.mui"
        }

        $strs = @(
            'Test Mode',
            'Evaluation copy.',
            'Windows 11 Pro Insider Preview',
            'Windows 11 Home Single Language Insider Preview',
            'Windows 11 Home Insider Preview',
            'Windows 11 Enterprise Insider Preview',
            'Windows 11 Education Insider Preview',
            'Windows 10 Pro Insider Preview',
            'Windows 10 Home Insider Preview',
            'Windows 10 Enterprise Insider Preview',
            'Insider Preview',
            'Build '
        )

        $patchedCount = 0
        foreach ($mui in $targets) {
            if (Test-Path $mui) {
                $old = "$mui.old"
                takeown /f $mui /a | Out-Null
                icacls $mui /grant Administrators:F | Out-Null
                $bytes = [IO.File]::ReadAllBytes($mui)
                $enc = [Text.Encoding]::Unicode
                $txt = $enc.GetString($bytes)
                $modified = $false

                foreach ($s in $strs) {
                    if ($s -eq 'Build ') {
                        $matches = [regex]::Matches($txt, 'Build \d{5}\.[^\x00\r\n]{1,30}')
                        foreach ($m in $matches) {
                            $txt = $txt.Replace($m.Value, (' ' * $m.Value.Length))
                            $modified = $true
                        }
                    } elseif ($txt.Contains($s)) {
                        $txt = $txt.Replace($s, (' ' * $s.Length))
                        $modified = $true
                    }
                }

                if ($modified) {
                    if (-not (Test-Path $old)) {
                        Move-Item $mui $old -Force
                    } else {
                        $tmp = "$mui.tmp_old"
                        if (Test-Path $tmp) { Remove-Item $tmp -Force }
                        Move-Item $mui $tmp -Force
                    }
                    [IO.File]::WriteAllBytes($mui, $enc.GetBytes($txt))
                    Write-Host "[+] Patched: $mui" -ForegroundColor Green
                    $patchedCount++
                }
            }
        }

        if ($patchedCount -gt 0) {
            Write-Host "[*] Patched $patchedCount file(s). Restarting Explorer..." -ForegroundColor Cyan
            Stop-Process -Name explorer -Force
            Start-Sleep -Seconds 2
            if (-not (Get-Process explorer)) { Start-Process explorer.exe }
        } else {
            Write-Host '[=] No unpatched watermark strings found (or already hidden).' -ForegroundColor Yellow
        }

        Write-Host "`n[*] Verifying Test Mode status..." -ForegroundColor Cyan
        bcdedit | findstr /i "testsigning"
        Write-Host "`n[DONE] If the watermark still shows on ROG Ally, reboot once to flush user32.dll.mui." -ForegroundColor Green
    }

    'RESTORE' {
        Write-Host '[*] Searching for .mui.old backup files to restore...' -ForegroundColor Cyan
        $searchDirs = @("$env:WINDIR\System32", "$env:WINDIR\Branding\Basebrd")
        $restoredCount = 0

        foreach ($dir in $searchDirs) {
            Get-ChildItem -Path $dir -Filter '*.mui.old' -Recurse | ForEach-Object {
                $oldFile = $_.FullName
                $origFile = $oldFile -replace '\.old$', ''
                $trash = "$origFile.patched_bak"
                takeown /f $origFile /a | Out-Null
                icacls $origFile /grant Administrators:F | Out-Null
                if (Test-Path $trash) { Remove-Item $trash -Force }
                Move-Item $origFile $trash -Force
                Move-Item $oldFile $origFile -Force
                Write-Host "[+] Restored: $origFile" -ForegroundColor Green
                $restoredCount++
            }
        }

        if ($restoredCount -gt 0) {
            Write-Host "[*] Restored $restoredCount original file(s). Restarting Explorer..." -ForegroundColor Cyan
            Stop-Process -Name explorer -Force
            Start-Sleep -Seconds 2
            if (-not (Get-Process explorer)) { Start-Process explorer.exe }
        } else {
            Write-Host '[!] No .mui.old backup files found to restore.' -ForegroundColor Yellow
        }
    }

    'STATUS' {
        Write-Host '--- BCD Boot Configuration ---' -ForegroundColor Cyan
        bcdedit | findstr /i "testsigning"
        Write-Host "`n--- Saved Backup Files (.mui.old) ---" -ForegroundColor Cyan
        $backups = Get-ChildItem "$env:WINDIR\System32","$env:WINDIR\Branding\Basebrd" -Filter '*.mui.old' -Recurse
        if ($backups) {
            $backups | Select-Object -ExpandProperty FullName
        } else {
            Write-Host 'None found.' -ForegroundColor Yellow
        }
    }
}