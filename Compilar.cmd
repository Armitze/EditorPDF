@echo off
REM Doble clic aqui para compilar PDF Editor Pro (dist\PDFEditorPro\PDFEditorPro.exe).
REM Lanza build.ps1 saltando la politica de ejecucion y deja la ventana abierta al final.

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "code=%ERRORLEVEL%"

echo.
if "%code%"=="0" (
    echo === Compilacion terminada correctamente. ===
) else (
    echo === Hubo un error ^(codigo %code%^). Revisa los mensajes de arriba. ===
)
echo.
pause
