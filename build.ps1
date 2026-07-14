<#
    build.ps1 — Compila PDF Editor Pro a un ejecutable de Windows.

    Uso:
        .\build.ps1              Build normal (rapido si ya hay dependencias/icono)
        .\build.ps1 -Deps        Reinstala/actualiza las dependencias antes de compilar
        .\build.ps1 -Icon        Regenera assets\icon.ico antes de compilar
        .\build.ps1 -Run         Ejecuta la app al terminar el build
        .\build.ps1 -Clean       Borra dist\ y build\ antes de compilar (build desde cero)

    El resultado queda en: dist\PDFEditorPro\PDFEditorPro.exe
#>
[CmdletBinding()]
param(
    [switch]$Deps,
    [switch]$Icon,
    [switch]$Run,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
# Situarse siempre en la carpeta del script (raiz del proyecto).
Set-Location -LiteralPath $PSScriptRoot

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- Cerrar instancias en ejecucion -----------------------------------------
# Si la app compilada sigue abierta, Windows bloquea los DLL dentro de dist\ y
# PyInstaller falla al limpiar con "Acceso denegado" (WinError 5). Cerramos
# cualquier PDFEditorPro.exe vivo antes de tocar dist\.
$running = Get-Process -Name PDFEditorPro -ErrorAction SilentlyContinue
if ($running) {
    Step "Cerrando $($running.Count) instancia(s) de PDFEditorPro en ejecucion"
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    # Dar un momento a Windows para liberar los handles de los DLL bloqueados.
    Start-Sleep -Milliseconds 800
}

# --- Interprete de Python ---------------------------------------------------
# En Windows, "python" suele ser el alias-senuelo del Microsoft Store: existe en
# el PATH pero al ejecutarlo falla (exit 9009) en vez de arrancar Python. El
# lanzador "py", en cambio, si apunta al Python real. Por eso probamos cada
# candidato ejecutando --version de verdad y solo aceptamos el que devuelve
# "Python 3.x" con codigo de salida 0.
function Find-Python {
    foreach ($cand in @('py', 'python', 'python3')) {
        if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
        try {
            $ver = & $cand --version 2>&1
            if ($LASTEXITCODE -eq 0 -and $ver -match 'Python\s+3') { return $cand }
        } catch { }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    throw @'
No se encontro una instalacion real de Python 3.

Lo que aparecio ("Microsoft Store") es solo un alias-senuelo, no Python.
Soluciones:
  1) Instala Python desde https://www.python.org/downloads/  (marca "Add python.exe to PATH").
  2) O desactiva el alias: Configuracion > Aplicaciones > Configuracion avanzada de
     aplicaciones > Alias de ejecucion de aplicaciones > apaga "python.exe" y "python3.exe".
Luego vuelve a ejecutar este build.
'@
}
Step "Usando Python: $py"

# --- Dependencias -----------------------------------------------------------
# No basta con que pip diga "OK": comprobamos que cada modulo realmente se
# importe. Modulo real -> nombre de importacion (PyMuPDF se importa como fitz,
# Pillow como PIL). Si falta alguno, (re)instalamos requirements.txt.
$required = @{
    fastapi     = 'fastapi'
    uvicorn     = 'uvicorn'
    webview     = 'pywebview'
    fitz        = 'PyMuPDF'
    PIL         = 'Pillow'
    PyInstaller = 'pyinstaller'
}
# find_spec devuelve None en vez de lanzar excepcion, asi no escribe en stderr
# (importante en PowerShell 5.1, donde stderr de un .exe se vuelve error).
function Test-Module($mod) {
    & $py -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('$mod') else 1)"
    return ($LASTEXITCODE -eq 0)
}
$missing = @()
foreach ($mod in $required.Keys) {
    if (-not (Test-Module $mod)) { $missing += $required[$mod] }
}
if ($Deps -or $missing.Count -gt 0) {
    if ($missing.Count -gt 0) { Step "Faltan modulos: $($missing -join ', ')" }
    Step 'Instalando dependencias (requirements.txt)'
    & $py -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la instalacion de dependencias.' }

    # Verificar de nuevo: si algo sigue sin importar, abortamos antes de
    # compilar un .exe roto (que fallaria en tiempo de ejecucion).
    $stillMissing = @()
    foreach ($mod in $required.Keys) {
        if (-not (Test-Module $mod)) { $stillMissing += $required[$mod] }
    }
    if ($stillMissing.Count -gt 0) {
        throw "Estos paquetes no se pudieron instalar/importar: $($stillMissing -join ', '). Revisa los mensajes de pip de arriba."
    }
}

# --- Icono ------------------------------------------------------------------
# Se genera si no existe o cuando se pide con -Icon.
if ($Icon -or -not (Test-Path 'assets\icon.ico')) {
    Step 'Generando icono (assets\icon.ico)'
    & $py make_icon.py
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la generacion del icono.' }
}

# --- Limpieza opcional ------------------------------------------------------
if ($Clean) {
    Step 'Limpiando dist\ y build\'
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'dist', 'build'
}

# --- Compilacion (PyInstaller) ---------------------------------------------
# --onedir arranca en pocos segundos; --onefile seria mas lento de abrir.
# --collect-submodules: FastAPI, uvicorn, starlette y pywebview cargan modulos
# de forma dinamica que el analisis estatico de PyInstaller no ve; sin esto el
# .exe compila pero falla al arrancar con "No module named ..." de un submodulo.
Step 'Compilando ejecutable con PyInstaller'
& $py -m PyInstaller --noconfirm --clean --onedir --windowed `
    --name PDFEditorPro --icon assets\icon.ico --add-data "ui;ui" `
    --collect-submodules fastapi `
    --collect-submodules starlette `
    --collect-submodules uvicorn `
    --collect-submodules webview `
    main.py
if ($LASTEXITCODE -ne 0) { throw 'Fallo la compilacion con PyInstaller.' }

$exe = Join-Path $PSScriptRoot 'dist\PDFEditorPro\PDFEditorPro.exe'
Step "Listo: $exe"

# --- Ejecutar opcionalmente -------------------------------------------------
if ($Run) {
    Step 'Ejecutando la app'
    & $exe
}
