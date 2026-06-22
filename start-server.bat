@echo off
chcp 65001 >nul
title Reelsnap Local Server
cd /d "%~dp0"

if "%PORT%"=="" set PORT=3000

echo ============================================
echo   Reelsnap local server
echo   URL  : http://localhost:%PORT%
echo   Stop : press Ctrl+C in this window
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found on PATH.
    echo         Install from https://nodejs.org and run again.
    echo.
    pause
    exit /b 1
)

if not exist "yt-dlp.exe" (
    where yt-dlp >nul 2>nul
    if errorlevel 1 (
        echo [WARN] yt-dlp not found. Instagram/YouTube extraction may fail.
        echo        Put yt-dlp.exe in this folder or add it to PATH:
        echo        https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
        echo.
    )
)

rem Open the default browser once the server has had a moment to start.
rem Runs in a background window so it does not block node below.
echo Opening browser at http://localhost:%PORT% ...
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%"
echo.

node server.js

echo.
echo Server stopped.
pause
