"""PDF Editor Pro — punto de entrada.

Uso:
  python main.py [archivo.pdf]          Ventana de escritorio (pywebview)
  python main.py --server [--port N]    Solo servidor FastAPI (desarrollo)
  PDFEditorPro.exe archivo.pdf          Abre el PDF (asociación de archivos)
"""
import argparse
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

import uvicorn

import assoc
from pdfcore import DocumentManager
from server import WindowService, create_app


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


def _forward_to_primary(path):
    """Si hay una instancia primaria viva, le manda el archivo y devuelve True.

    Comprueba que quien responde en ese puerto es realmente PDFEditorPro (no otro
    proceso que reutilizó el puerto) antes de enviarle nada.
    """
    port = _read_primary_port()
    if not port:
        return False
    base = f'http://127.0.0.1:{port}'

    def _post(url, payload):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, data=data, method='POST',
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=2) as resp:
            return json.loads(resp.read())

    try:
        with urllib.request.urlopen(f'{base}/api/ping', timeout=1) as resp:
            info = json.loads(resp.read())
        if info.get('app') != 'PDFEditorPro':
            return False
        _post(f'{base}/api/open-external', {'path': os.path.abspath(path)})
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def main():
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
    if args.file and os.path.isfile(args.file) and not args.server:
        if _forward_to_primary(args.file):
            return

    manager = DocumentManager()
    windows = WindowService()
    app = create_app(manager, windows)

    if args.file and os.path.isfile(args.file):
        try:
            manager.open(os.path.abspath(args.file))
        except Exception as e:
            print(f'No se pudo abrir «{args.file}»: {e}', file=sys.stderr)

    if args.server:
        uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='info')
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
        manager.close_all()
        _clear_primary_port()


if __name__ == '__main__':
    main()
