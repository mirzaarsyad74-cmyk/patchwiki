@echo off
title Hide Test Mode & Insider Watermark
setlocal EnableDelayedExpansion

:: 1. Auto-Elevate to Administrator
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Requesting Administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ========================================================
echo   Hiding Test Mode & Windows Insider Watermarks...
echo ========================================================
echo.

:: 2. Disable PaintDesktopVersion in Registry (Fallback handler)
reg add "HKCU\Control Panel\Desktop" /v PaintDesktopVersion /t REG_DWORD /d 0 /f >nul 2>&1

:: 3. Patch shell32.dll.mui & basebrd.dll.mui via PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$ErrorActionPreference = 'Stop'; ^
$lang = (Get-WinUserLanguageList)[0].LanguageTag; ^
if (-not (Test-Path \"$env:WINDIR\System32\$lang\shell32.dll.mui\")) { $lang = (Get-Culture).Name }; ^
if (-not (Test-Path \"$env:WINDIR\System32\$lang\shell32.dll.mui\")) { $lang = 'en-US' }; ^
Write-Host \"[*] Active UI Language detected: $lang\" -ForegroundColor Cyan; ^
$files = @( ^
    \"$env:WINDIR\System32\$lang\shell32.dll.mui\", ^
    \"$env:WINDIR\Branding\Basebrd\$lang\basebrd.dll.mui\" ^
); ^
$strs = @( ^
    'Test Mode', ^
    'Evaluation copy.', ^
    'Windows 11 Pro Insider Preview', ^
    'Windows 11 Home Insider Preview', ^
    'Windows 11 Enterprise Insider Preview', ^
    'Windows 11 Education Insider Preview', ^
    'Windows 10 Pro Insider Preview', ^
    'Windows 10 Home Insider Preview', ^
    'Windows 10 Enterprise Insider Preview' ^
); ^
$patchedAny = $false; ^
foreach ($mui in $files) { ^
    if (Test-Path $mui) { ^
        try { ^
            $old = \"$mui.old\"; ^
            takeown /f $mui /a | Out-Null; ^
            icacls $mui /grant Administrators:F | Out-Null; ^
            $bytes = [IO.File]::ReadAllBytes($mui); ^
            $enc = [Text.Encoding]::Unicode; ^
            $txt = $enc.GetString($bytes); ^
            $modified = $false; ^
            foreach ($s in $strs) { ^
                if ($txt.Contains($s)) { ^
                    $txt = $txt.Replace($s, (' ' * $s.Length)); ^
                    $modified = $true; ^
                } ^
            }; ^
            if ($modified) { ^
                if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }; ^
                Move-Item $mui $old -Force; ^
                [IO.File]::WriteAllBytes($mui, $enc.GetBytes($txt)); ^
                Write-Host \"[+] Patched: $mui\" -ForegroundColor Green; ^
                $patchedAny = $true; ^
            } else { ^
                Write-Host \"[=] Already clean: $mui\" -ForegroundColor Yellow; ^
            } ^
        } catch { ^
            Write-Host \"[!] Failed on $mui : $($_.Exception.Message)\" -ForegroundColor Red; ^
        } ^
    } else { ^
        Write-Host \"[-] Not found (skipped): $mui\" -ForegroundColor DarkGray; ^
    } ^
}; ^
if ($patchedAny) { ^
    Write-Host '[*] Restarting Windows Explorer...' -ForegroundColor Cyan; ^
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; ^
    Start-Sleep -Seconds 2; ^
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }; ^
}"

:: 4. Verify Test Mode is still enabled
echo.
echo [*] Verifying BCD Test Mode state...
bcdedit | findstr /i "testsigning"
echo.
echo [DONE] Watermarks hidden while Test Mode remains active.
echo        (Note: Re-run this script after major Windows updates.)
echo.
pause