"""Auto-actualización desde GitHub Releases.

Flujo:
  1. `check()` consulta la API de GitHub por la última publicación y compara su
     versión con la instalada. Devuelve la info del release si hay una más nueva.
  2. `download(...)` baja el .zip de esa versión a una carpeta temporal, con
     progreso, verificando el tamaño.
  3. `stage_and_restart(...)` extrae el .zip, lanza un script externo que espera
     a que la app se cierre, reemplaza la carpeta de instalación por la nueva y
     vuelve a abrir la app. Luego cierra esta instancia.

La actualización solo tiene sentido en el .exe congelado e instalado en modo
carpeta (--onedir). En desarrollo (`python main.py`) todo esto se desactiva:
no hay una carpeta de instalación que reemplazar.
"""
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

from version import REPO, __version__

# User-Agent obligatorio para la API de GitHub (rechaza peticiones sin él).
_UA = {'User-Agent': f'PDFEditorPro/{__version__}'}
_API_LATEST = f'https://api.github.com/repos/{REPO}/releases/latest'
_TIMEOUT = 15

# Nombre del activo (asset) que publica el workflow de CI. Debe coincidir con
# el nombre que se sube en el release (ver .github/workflows/release.yml).
ASSET_NAME = 'PDFEditorPro-windows.zip'


def is_frozen():
    """True si corre como .exe de PyInstaller (no `python main.py`)."""
    return getattr(sys, 'frozen', False)


def install_root():
    """Carpeta de instalación a reemplazar (la que contiene el .exe), o None.

    En --onedir el ejecutable vive en dist\\PDFEditorPro\\PDFEditorPro.exe; la
    carpeta a sustituir es la que lo contiene.
    """
    if not is_frozen():
        return None
    return os.path.dirname(sys.executable)


def _parse_version(text):
    """'2026.0721.3' -> (2026, 721, 3). Ignora una 'v' inicial y sufijos raros.

    Devuelve una tupla comparable; las partes no numéricas cuentan como 0, así
    una etiqueta malformada nunca se considera «más nueva» por accidente.
    """
    text = (text or '').strip().lstrip('vV')
    parts = []
    for chunk in text.split('.'):
        num = ''.join(c for c in chunk if c.isdigit())
        parts.append(int(num) if num else 0)
    return tuple(parts) if parts else (0,)


def _is_newer(candidate, current):
    return _parse_version(candidate) > _parse_version(current)


def _get_json(url):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={**_UA, 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=_TIMEOUT, context=ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


def check():
    """Consulta la última versión publicada.

    Devuelve un dict con la info del release si hay una versión MÁS NUEVA que la
    instalada, o None si ya está al día / no aplica / falla la red. Nunca lanza:
    un problema de conexión no debe molestar al usuario.
    """
    if not is_frozen():
        return None
    try:
        data = _get_json(_API_LATEST)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, TimeoutError):
        return None
    tag = data.get('tag_name') or data.get('name') or ''
    if not _is_newer(tag, __version__):
        return None
    asset = _find_asset(data.get('assets', []))
    if not asset:
        return None
    return {
        'version': tag.lstrip('vV'),
        'tag': tag,
        'notes': (data.get('body') or '').strip(),
        'url': asset['browser_download_url'],
        'size': asset.get('size', 0),
        'published': data.get('published_at', ''),
    }


def _find_asset(assets):
    """El .zip de la app entre los activos del release (por nombre exacto)."""
    for a in assets:
        if a.get('name') == ASSET_NAME:
            return a
    # Reserva: cualquier .zip, por si el nombre del activo cambia.
    for a in assets:
        if str(a.get('name', '')).lower().endswith('.zip'):
            return a
    return None


def download(url, expected_size=0, on_progress=None, cancel=None):
    """Descarga `url` a un archivo temporal. Devuelve la ruta del .zip.

    `on_progress(bytes_hechos, bytes_totales)` se llama durante la descarga.
    `cancel` es un threading.Event opcional: si se activa, aborta y limpia.
    Lanza RuntimeError si se cancela o si el tamaño no cuadra.
    """
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers=_UA)
    fd, tmp = tempfile.mkstemp(suffix='.zip', prefix='pdfeditorpro_update_')
    os.close(fd)
    done = 0
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT, context=ctx) as resp:
            total = expected_size or int(resp.headers.get('Content-Length', 0) or 0)
            with open(tmp, 'wb') as fh:
                while True:
                    if cancel is not None and cancel.is_set():
                        raise RuntimeError('Actualización cancelada.')
                    chunk = resp.read(262144)  # 256 KiB
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if on_progress:
                        on_progress(done, total)
    except BaseException:
        _quiet_remove(tmp)
        raise
    if expected_size and done != expected_size:
        _quiet_remove(tmp)
        raise RuntimeError('La descarga quedó incompleta. Inténtalo de nuevo.')
    return tmp


def stage_and_restart(zip_path):
    """Extrae el .zip y lanza el aplicador externo que reemplaza y reinicia.

    Devuelve True si el aplicador arrancó (el llamador debe cerrar la app para
    liberar los archivos). Lanza si algo falla ANTES de lanzarlo (para poder
    avisar al usuario y conservar la instalación intacta).
    """
    root = install_root()
    if not root:
        raise RuntimeError('La actualización automática solo está disponible en la app instalada.')

    import zipfile
    staging = tempfile.mkdtemp(prefix='pdfeditorpro_new_')
    try:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(staging)
    except zipfile.BadZipFile:
        shutil.rmtree(staging, ignore_errors=True)
        _quiet_remove(zip_path)
        raise RuntimeError('El archivo descargado está dañado. Inténtalo de nuevo.')

    # El .zip contiene la carpeta PDFEditorPro/ en su raíz; usamos esa. Si el
    # empaquetado la omitió (contenido suelto), tomamos el staging tal cual.
    inner = os.path.join(staging, 'PDFEditorPro')
    new_dir = inner if os.path.isdir(inner) else staging
    # Validación mínima: el reemplazo debe traer el ejecutable, o abortamos
    # antes de tocar la instalación buena.
    if not os.path.isfile(os.path.join(new_dir, 'PDFEditorPro.exe')):
        shutil.rmtree(staging, ignore_errors=True)
        _quiet_remove(zip_path)
        raise RuntimeError('La actualización no contiene el ejecutable esperado.')

    script = _write_apply_script(new_dir, root, os.getpid(), staging, zip_path)
    # Lanzar el aplicador DESPRENDIDO de esta app: debe sobrevivir a que la app
    # se cierre para poder reemplazar sus archivos.
    creationflags = 0
    if os.name == 'nt':
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008  # DETACHED_PROCESS
    subprocess.Popen(
        ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
         '-File', script],
        creationflags=creationflags, close_fds=True,
        cwd=tempfile.gettempdir())
    return True


def _write_apply_script(new_dir, install_dir, pid, staging, zip_path):
    """Genera el .ps1 que espera el cierre, reemplaza la carpeta y reinicia.

    Corre fuera de la app (PowerShell): espera a que el proceso muere para que
    Windows libere los DLL, mueve lo viejo a un lado, copia lo nuevo en su sitio,
    relanza el .exe y se autolimpia. Si algo falla al copiar, restaura lo viejo
    para no dejar la instalación rota.
    """
    exe = os.path.join(install_dir, 'PDFEditorPro.exe')
    log = os.path.join(tempfile.gettempdir(), 'pdfeditorpro_update.log')
    # PowerShell con here-string de una plantilla; las rutas van entre comillas
    # simples (literales) para no romper con espacios ni caracteres especiales.
    ps = f"""
$ErrorActionPreference = 'Stop'
$log = '{_ps(log)}'
function Log($m) {{ Add-Content -LiteralPath $log -Value ("[{{0}}] {{1}}" -f (Get-Date -Format o), $m) }}

$installDir = '{_ps(install_dir)}'
$newDir     = '{_ps(new_dir)}'
$staging    = '{_ps(staging)}'
$zip        = '{_ps(zip_path)}'
$exe        = '{_ps(exe)}'
$procId     = {pid}

try {{
    Log "Esperando a que la app (PID $procId) se cierre..."
    try {{ Wait-Process -Id $procId -Timeout 30 -ErrorAction SilentlyContinue }} catch {{}}
    # Por si quedan otras instancias con los DLL bloqueados.
    Get-Process -Name PDFEditorPro -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 900

    $backup = "$installDir.old_$procId"
    Log "Respaldando instalacion actual en $backup"
    if (Test-Path -LiteralPath $backup) {{ Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }}
    Rename-Item -LiteralPath $installDir -NewName ([System.IO.Path]::GetFileName($backup)) -ErrorAction Stop

    try {{
        Log "Instalando version nueva"
        # Copiar la carpeta nueva ENTERA a su sitio. Copy-Item con comodin '*'
        # y -Recurse es inconsistente (a veces omite subcarpetas); copiar el
        # directorio como un todo y renombrarlo es fiable.
        Copy-Item -LiteralPath $newDir -Destination $installDir -Recurse -Force -ErrorAction Stop
        # Verificar que el ejecutable quedo en su sitio antes de dar por buena
        # la copia (una copia parcial no debe pasar por exitosa).
        if (-not (Test-Path -LiteralPath $exe)) {{ throw "El ejecutable no se copio." }}
    }} catch {{
        Log "FALLO al copiar; restaurando respaldo. $_"
        if (Test-Path -LiteralPath $installDir) {{ Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue }}
        Rename-Item -LiteralPath $backup -NewName ([System.IO.Path]::GetFileName($installDir)) -ErrorAction SilentlyContinue
        Log "Restaurado. Relanzando version anterior."
        Start-Process -FilePath $exe -ErrorAction SilentlyContinue
        return
    }}

    Log "Actualizacion aplicada. Relanzando."
    # El relanzamiento no debe abortar la limpieza: si fallara, se registra y
    # se sigue (la version nueva ya esta instalada, solo faltaria abrirla).
    try {{ Start-Process -FilePath $exe -ErrorAction Stop }} catch {{ Log "No se pudo relanzar: $_" }}

    # Limpieza (lo viejo, el staging y el zip). Si algo sigue bloqueado, se deja.
    Remove-Item -LiteralPath $backup  -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $zip     -Force -ErrorAction SilentlyContinue
    Log "Hecho."
}} catch {{
    Log "ERROR: $_"
}}
"""
    fd, path = tempfile.mkstemp(suffix='.ps1', prefix='pdfeditorpro_apply_')
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write(ps)
    return path


def _ps(path):
    """Escapa una ruta para incrustarla en una cadena literal '...' de PowerShell."""
    return str(path).replace("'", "''")


def _quiet_remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Orquestación en segundo plano (la usa el backend para no bloquear la UI).
# ---------------------------------------------------------------------------

class UpdateManager:
    """Estado del proceso de actualización, consultable desde la API.

    Guarda el resultado del último `check`, y lleva la descarga en un hilo con
    progreso. La UI hace polling de `status()` para pintar el aviso y la barra.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._available = None    # dict del release nuevo, o None
        self._checking = False
        self._state = 'idle'      # idle | downloading | ready | applying | error
        self._progress = 0.0      # 0..1
        self._error = None
        self._zip = None
        self._cancel = threading.Event()

    def status(self):
        with self._lock:
            return {
                'supported': is_frozen(),
                'current': __version__,
                'available': self._available,
                'checking': self._checking,
                'state': self._state,
                'progress': round(self._progress, 3),
                'error': self._error,
            }

    def check_async(self):
        """Lanza la comprobación en segundo plano (idempotente)."""
        with self._lock:
            if self._checking or self._state in ('downloading', 'applying'):
                return
            self._checking = True

        def run():
            info = check()
            with self._lock:
                self._available = info
                self._checking = False

        threading.Thread(target=run, daemon=True).start()

    def start_download(self):
        """Empieza a descargar la versión disponible. Devuelve False si no aplica."""
        with self._lock:
            if not self._available or self._state in ('downloading', 'applying'):
                return False
            info = self._available
            self._state = 'downloading'
            self._progress = 0.0
            self._error = None
            self._cancel.clear()

        def on_progress(done, total):
            with self._lock:
                self._progress = (done / total) if total else 0.0

        def run():
            try:
                path = download(info['url'], info.get('size', 0), on_progress, self._cancel)
                with self._lock:
                    self._zip = path
                    self._state = 'ready'
                    self._progress = 1.0
            except Exception as e:  # noqa: BLE001 — se refleja en el estado
                with self._lock:
                    self._state = 'error'
                    self._error = str(e)

        threading.Thread(target=run, daemon=True).start()
        return True

    def apply(self, on_ready_to_close):
        """Aplica la actualización descargada y pide cerrar la app.

        `on_ready_to_close()` se invoca cuando el aplicador ya está lanzado y hay
        que cerrar esta instancia. Devuelve False si no hay descarga lista.
        """
        with self._lock:
            if self._state != 'ready' or not self._zip:
                return False
            zip_path = self._zip
            self._state = 'applying'
        try:
            stage_and_restart(zip_path)
        except Exception as e:  # noqa: BLE001
            with self._lock:
                self._state = 'error'
                self._error = str(e)
            return False
        on_ready_to_close()
        return True

    def cancel(self):
        self._cancel.set()
        with self._lock:
            if self._state == 'downloading':
                self._state = 'idle'
                self._progress = 0.0
