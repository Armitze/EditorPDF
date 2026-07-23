"""PDF Editor Pro — punto de entrada.

Uso:
  python main.py [archivo.pdf]          Ventana de escritorio (pywebview)
  python main.py --server [--port N]    Solo servidor FastAPI (desarrollo)
  PDFEditorPro.exe archivo.pdf          Abre el PDF (asociación de archivos)
"""
import argparse
import json
import multiprocessing
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

import uvicorn

import assoc
import renderpool
from pdfcore import DocumentManager, PasswordRequired
from server import WindowService, create_app


def _unblock_package():
    """Quita la marca «descargado de Internet» de los binarios del paquete.

    Al bajar el .zip con el navegador y extraerlo con el Explorador, todos los
    archivos heredan la marca (Zone.Identifier). .NET Framework se niega a
    cargar ensamblados marcados, así que pythonnet no puede cargar
    Python.Runtime.dll y pywebview muere al arrancar («Failed to resolve
    Python.Runtime.Loader.Initialize»). Borrar el stream alternativo equivale
    al botón «Desbloquear» de Propiedades, archivo por archivo.
    """
    if not getattr(sys, 'frozen', False):
        return
    root = os.path.dirname(sys.executable)
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if not name.lower().endswith(('.dll', '.pyd', '.exe')):
                continue
            try:
                os.remove(os.path.join(dirpath, name) + ':Zone.Identifier')
            except OSError:
                pass    # no estaba marcado (lo normal) o no hay permisos


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def _state_dir():
    """Carpeta por-usuario donde guardamos el puerto de la instancia primaria."""
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    d = os.path.join(base, 'PDFEditorPro')
    os.makedirs(d, exist_ok=True)
    return d


def _port_file():
    return os.path.join(_state_dir(), 'instance.port')


def _read_primary_port():
    try:
        with open(_port_file(), encoding='utf-8') as fh:
            return int(fh.read().strip())
    except Exception:
        return None


def _write_primary_port(port):
    try:
        with open(_port_file(), 'w', encoding='utf-8') as fh:
            fh.write(str(port))
    except Exception:
        pass


def _clear_primary_port():
    try:
        os.remove(_port_file())
    except Exception:
        pass


def _lock_file():
    return os.path.join(_state_dir(), 'instance.lock')


def _acquire_primary_lock():
    """Intenta ser la instancia primaria. Devuelve el descriptor, o None si ya hay otra.

    O_CREAT|O_EXCL es atómico: si dos procesos arrancan a la vez (doble-clic en dos
    PDFs seguidos) solo uno crea el archivo; el otro sabe que debe reenviar en vez
    de abrir una segunda ventana. Sin esto ambos se creían primarios y el segundo
    pisaba el puerto del primero, dejando una ventana huérfana.
    """
    try:
        return os.open(_lock_file(), os.O_CREAT | os.O_EXCL | os.O_RDWR)
    except FileExistsError:
        return None
    except OSError:
        return None


def _release_primary_lock(fd):
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.remove(_lock_file())
    except OSError:
        pass


def _forward_to_primary(path, wait=0.0):
    """Si hay una instancia primaria viva, le manda el archivo y devuelve True.

    Comprueba que quien responde en ese puerto es realmente PDFEditorPro (no otro
    proceso que reutilizó el puerto) antes de enviarle nada.

    `wait`: segundos a esperar a que la primaria publique su puerto y responda.
    Al abrir dos PDFs seguidos, la segunda instancia puede arrancar cuando la
    primera aún está levantando el servidor; sin esta espera se rendía y abría
    una ventana de más.
    """
    deadline = time.time() + wait

    def _post(url, payload):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, data=data, method='POST',
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())

    while True:
        port = _read_primary_port()
        if port:
            base = f'http://127.0.0.1:{port}'
            try:
                with urllib.request.urlopen(f'{base}/api/ping', timeout=2) as resp:
                    info = json.loads(resp.read())
                if info.get('app') == 'PDFEditorPro':
                    _post(f'{base}/api/open-external', {'path': os.path.abspath(path)})
                    return True
            except (urllib.error.URLError, OSError, ValueError):
                pass
        if time.time() >= deadline:
            return False
        time.sleep(0.1)


def main():
    # Antes de nada: si el paquete viene con la marca de Internet (instalación
    # manual desde el zip), desbloquearlo o pywebview no podrá ni arrancar.
    _unblock_package()

    parser = argparse.ArgumentParser(prog='PDFEditorPro')
    parser.add_argument('file', nargs='?', help='PDF a abrir')
    parser.add_argument('--server', action='store_true',
                        help='Solo servidor HTTP, sin ventana (desarrollo)')
    parser.add_argument('--port', type=int, default=8123)
    args = parser.parse_args()

    # --- Instancia única -----------------------------------------------------
    # Si ya hay una ventana abierta y nos pasan un archivo (doble-clic, «Abrir
    # con»), lo mandamos a esa instancia para que lo abra en una pestaña nueva y
    # salimos sin crear otra ventana. Solo aplica al modo ventana, no a --server.
    lock_fd = None
    if args.file and os.path.isfile(args.file) and not args.server:
        if _forward_to_primary(args.file):
            return
        # Nadie respondió: intentamos ser nosotros la primaria.
        lock_fd = _acquire_primary_lock()
        if lock_fd is None:
            # Otra instancia se nos adelantó y está arrancando ahora mismo:
            # le damos margen para publicar su puerto y le pasamos el archivo.
            if _forward_to_primary(args.file, wait=15):
                return
            # Sigue sin responder: el lock está huérfano (cierre forzado previo).
            # Lo limpiamos y seguimos como primaria.
            try:
                os.remove(_lock_file())
            except OSError:
                pass
            lock_fd = _acquire_primary_lock()

    manager = DocumentManager()
    windows = WindowService()
    app = create_app(manager, windows)

    # Render en paralelo: limpiar instantáneas huérfanas de sesiones anteriores
    # y arrancar los workers ya (así el primer render no espera al spawn).
    renderpool.clean_stale_snapshots()
    renderpool.warmup()

    # PDF protegido pasado por línea de comandos: no se puede abrir aquí (haría
    # falta la clave), así que se deja pendiente para que la interfaz la pida en
    # cuanto cargue. Antes esto solo escribía en stderr —invisible en el .exe— y
    # el archivo se descartaba en silencio.
    pending_locked = None
    if args.file and os.path.isfile(args.file):
        try:
            manager.open(os.path.abspath(args.file))
        except PasswordRequired:
            pending_locked = os.path.abspath(args.file)
            windows.pending_locked = pending_locked
        except Exception as e:
            print(f'No se pudo abrir «{args.file}»: {e}', file=sys.stderr)

    if args.server:
        try:
            uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='info')
        finally:
            # El pool primero: sus workers tienen abiertas las instantáneas y en
            # Windows no se pueden borrar mientras un proceso las tenga abiertas.
            renderpool.shutdown()
            manager.close_all()
        return

    # Registrar la asociación .pdf (solo ejecutable congelado; idempotente)
    try:
        assoc.register()
    except Exception:
        pass

    import webview

    port = free_port()
    config = uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning')
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)

    # Publicar el puerto para que otras instancias nos envíen los archivos.
    _write_primary_port(port)

    window = webview.create_window(
        'PDF Editor Pro',
        f'http://127.0.0.1:{port}/',
        width=1600, height=950, min_size=(1180, 720),
        frameless=True, easy_drag=False,
        background_color='#eceef1',
    )
    windows.window = window
    windows.bind_drag(window)

    def on_closing():
        # Cierre desde el SO (Alt+F4, barra de tareas). Si el frontend ya confirmó
        # a través de /api/window close, allow_close es True y dejamos cerrar.
        if windows.allow_close:
            return True
        if manager.any_dirty():
            # Cancela este cierre y pide al frontend que muestre el diálogo Guardar.
            try:
                window.evaluate_js('window.__requestClose && window.__requestClose()')
            except Exception:
                return True
            return False
        return True

    window.events.closing += on_closing
    try:
        webview.start()
    finally:
        server.should_exit = True
        # El pool antes que close_all: los workers tienen abiertas las
        # instantáneas y en Windows no se borran mientras sigan abiertas.
        renderpool.shutdown()
        manager.close_all()
        _clear_primary_port()
        if lock_fd is not None:
            _release_primary_lock(lock_fd)


if __name__ == '__main__':
    # Imprescindible para el pool de procesos en el ejecutable congelado
    # (PyInstaller): sin esto cada worker relanzaría la aplicación entera.
    multiprocessing.freeze_support()
    main()
