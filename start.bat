@echo off
REM Launch HeadTracking Hologram3D on http://localhost:8000
REM Prefers Python; falls back to Node's http-server via npx.

cd /d "%~dp0"

REM Pass --https to serve over TLS so phones on the LAN can use the camera:
REM     start.bat --https

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    python serve.py %*
    goto :eof
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
    py serve.py %*
    goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL%==0 (
    echo Python not found - using npx http-server instead.
    start "" http://localhost:8000/index.html
    npx --yes http-server . -p 8000 -c-1
    goto :eof
)

echo.
echo   Neither Python nor Node was found on PATH.
echo   Install either one, or serve this folder with any static web server.
echo.
pause
