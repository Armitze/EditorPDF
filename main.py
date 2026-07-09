"""PDF Editor Pro — punto de entrada.

Uso:
  python main.py [archivo.pdf]          Ventana de escritorio (pywebview)
  python main.py --server [--port N]    Solo servidor FastAPI (desarrollo)
  PDFEditorPro.exe archivo.pdf          Abre el PDF (asociación de archivos)
"""
import argparse
import os
import socket
import sys
import threading
import time

import uvicorn

import assoc
from pdfcore import PdfState
from server import WindowService, create_app


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(prog='PDFEditorPro')
    parser.add_argument('file', nargs='?', help='PDF a abrir')
    parser.add_argument('--server', action='store_true',
                        help='Solo servidor HTTP, sin ventana (desarrollo)')
    parser.add_argument('--port', type=int, default=8123)
    args = parser.parse_args()

    pdf = PdfState()
    windows = WindowService()
    app = create_app(pdf, windows)

    if args.file and os.path.isfile(args.file):
        try:
            pdf.open(os.path.abspath(args.file))
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

    window = webview.create_window(
        'PDF Editor Pro',
        f'http://127.0.0.1:{port}/',
        width=1600, height=950, min_size=(1180, 720),
        frameless=True, easy_drag=False,
        background_color='#eceef1',
    )
    windows.window = window

    def on_closing():
        # Cierre desde el SO (Alt+F4, barra de tareas). Si el frontend ya confirmó
        # a través de /api/window close, allow_close es True y dejamos cerrar.
        if windows.allow_close:
            return True
        if pdf.info().get('dirty'):
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


if __name__ == '__main__':
    main()
