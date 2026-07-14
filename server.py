"""Servidor FastAPI: sirve la interfaz (ui/) y expone la API del editor."""
import base64
import binascii
import csv
import io
import os
import sys
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pdfcore import DocumentManager, PdfState


def base_dir():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


class WindowService:
    """Puente hacia la ventana pywebview; en modo --server usa alternativas."""

    def __init__(self):
        self.window = None
        self.allow_close = False  # el frontend lo pone en True tras confirmar
        self._maximized = False
        # Estado del arrastre de la barra de título (Aero Snap manual).
        self._drag = None  # dict con offset del cursor y geometría previa

    def bind_drag(self, window):
        """Expone al bridge JS de pywebview las funciones de arrastre y snap.

        Con la ventana «frameless» movemos la ventana nosotros mismos para poder
        detectar cuándo el cursor toca el borde superior de la pantalla y, en ese
        caso, maximizar (comportamiento tipo Aero Snap de Windows).
        """
        window.expose(self.drag_start, self.drag_move, self.drag_end,
                      self.toggle_maximize, self.maximize_window)

    def drag_start(self, cursor_x, cursor_y):
        """Inicia el arrastre. Guarda el desfase del cursor respecto a la ventana.

        cursor_x/cursor_y son coordenadas absolutas de pantalla (screenX/screenY).
        """
        if not self.window:
            return
        # Si arrancamos el arrastre desde maximizado, primero restauramos para
        # poder mover la ventana (como hace Windows al «despegar» del borde).
        was_max = self._maximized
        if was_max:
            self.window.restore()
            self._maximized = False
        if was_max:
            # Al restaurar, recolocamos la ventana bajo el cursor (centrada en X,
            # con la barra bajo el ratón) para que no «salte» lejos del puntero.
            w = self.window.width
            off_x, off_y = int(w * 0.5), 16
            self.window.move(int(cursor_x - off_x), max(0, int(cursor_y - off_y)))
        else:
            off_x = cursor_x - self.window.x
            off_y = cursor_y - self.window.y
        self._drag = {'off_x': off_x, 'off_y': off_y, 'snapped': False}

    def drag_move(self, cursor_x, cursor_y, snap_top):
        """Mueve la ventana siguiendo el cursor y maximiza al tocar el borde.

        snap_top: True cuando el cursor está dentro de la franja superior de la
        pantalla (el frontend, que conoce la resolución, lo decide).
        """
        d = self._drag
        if not d or not self.window:
            return
        if snap_top:
            if not d['snapped']:
                self.window.maximize()
                self._maximized = True
                d['snapped'] = True
            return
        # Salimos de la franja: si estábamos maximizados, restauramos y seguimos.
        if d['snapped']:
            self.window.restore()
            self._maximized = False
            d['snapped'] = False
            # Recentramos la ventana restaurada bajo el cursor.
            d['off_x'] = int(self.window.width * 0.5)
            d['off_y'] = 16
        self.window.move(int(cursor_x - d['off_x']), int(cursor_y - d['off_y']))

    def drag_end(self):
        self._drag = None

    def toggle_maximize(self):
        if not self.window:
            return
        if self._maximized:
            self.window.restore()
            self._maximized = False
        else:
            self.window.maximize()
            self._maximized = True

    def maximize_window(self):
        """Maximiza la ventana (idempotente). Usado al abrir un PDF nuevo."""
        if not self.window or self._maximized:
            return
        self.window.maximize()
        self._maximized = True

    def focus(self):
        """Trae la ventana al frente (al recibir un archivo de otra instancia)."""
        if not self.window:
            return
        try:
            if self._maximized:
                self.window.restore()
                self._maximized = False
                self.window.maximize()
                self._maximized = True
            self.window.on_top = True
            self.window.on_top = False
        except Exception:
            pass

    def _downloads(self, suggested):
        folder = os.path.join(os.path.expanduser('~'), 'Downloads')
        os.makedirs(folder, exist_ok=True)
        return os.path.join(folder, suggested)

    def open_pdf_dialog(self):
        if not self.window:
            return None
        import webview
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=('Documentos PDF (*.pdf)',))
        return result[0] if result else None

    def open_pdf_dialog_multi(self):
        """Diálogo de apertura con selección múltiple. Devuelve lista de rutas."""
        if not self.window:
            return None
        import webview
        result = self.window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=True,
            file_types=('Documentos PDF (*.pdf)',))
        return list(result) if result else None

    def save_dialog(self, suggested, file_type):
        if not self.window:
            return self._downloads(suggested)
        import webview
        result = self.window.create_file_dialog(
            webview.SAVE_DIALOG, save_filename=suggested, file_types=(file_type,))
        if not result:
            return None
        return result if isinstance(result, str) else result[0]

    def folder_dialog(self):
        if not self.window:
            return os.path.join(os.path.expanduser('~'), 'Downloads')
        import webview
        result = self.window.create_file_dialog(webview.FOLDER_DIALOG)
        if not result:
            return None
        return result if isinstance(result, str) else result[0]

    def control(self, action):
        if not self.window:
            return False
        if action == 'minimize':
            self.window.minimize()
        elif action == 'maximize':
            self.toggle_maximize()
        elif action == 'close':
            # El frontend ya confirmó (o no había cambios): permitir el cierre real.
            self.allow_close = True
            self.window.destroy()
        return True


class OpenBody(BaseModel):
    path: str | list[str] | None = None


class AnnotBody(BaseModel):
    page: int
    kind: str
    color: str = '#f2d024'
    width: float = 3
    opacity: float = 0.8
    rect: list[float] | None = None
    p1: list[float] | None = None
    p2: list[float] | None = None
    text: str = ''
    quads: list[list[float]] | None = None


class PagesBody(BaseModel):
    action: str
    page: int


class SaveBody(BaseModel):
    saveAs: bool = False


class SplitGroup(BaseModel):
    name: str = ''
    range: str = ''


class SplitGroupsBody(BaseModel):
    groups: list[SplitGroup]


class ExportBody(BaseModel):
    fmt: str
    range: str = ''


class WindowBody(BaseModel):
    action: str


class MergeBody(BaseModel):
    mode: str = 'current'  # 'current' = sobre el actual | 'new' = documento nuevo


class SignBody(BaseModel):
    page: int
    rect: list[float]          # [x0, y0, x1, y1] en puntos PDF
    image: str                 # PNG en base64 (con o sin prefijo data:)
    keepRatio: bool = True
    opacity: float = 1.0       # 0..1


class TableExportBody(BaseModel):
    page: int
    fmt: str  # csv | excel


def _doc_html(pdf: PdfState, indexes):
    body = pdf.html(indexes)
    name = (pdf.info().get('name') or 'documento').rsplit('.', 1)[0]
    return name, f'<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>{name}</title></head><body>{body}</body></html>'


def _tables_html(tables):
    parts = []
    for t in tables:
        rows = ''.join(
            '<tr>' + ''.join(f'<td>{cell}</td>' for cell in row) + '</tr>'
            for row in t['rows'])
        parts.append(f'<table border="1">{rows}</table><br>')
    return ''.join(parts)


def create_app(manager: DocumentManager, windows: WindowService) -> FastAPI:
    app = FastAPI(title='PDF Editor Pro')

    def get_doc(docId: str) -> PdfState:
        """Dependencia: resuelve el PdfState de la pestaña indicada por docId."""
        state = manager.get(docId)
        if state is None:
            raise HTTPException(404, f'La pestaña «{docId}» no existe.')
        return state

    @app.get('/api/ping')
    def ping():
        """Sonda de instancia única: confirma que esta es la ventana primaria."""
        return {'app': 'PDFEditorPro', 'ok': True}

    @app.post('/api/open-external')
    def open_external(body: OpenBody):
        """Abre un PDF llegado de OTRA instancia (doble-clic con la app ya abierta).

        Crea la pestaña en el backend y avisa al frontend para que la muestre y
        traiga la ventana al frente. Devuelve el docId abierto.
        """
        paths = body.path
        if not paths:
            return {'cancelled': True}
        if isinstance(paths, str):
            paths = [paths]
        opened = []
        for path in paths:
            if not os.path.isfile(path):
                continue
            try:
                opened.append(manager.open(path))
            except Exception:
                pass
        if not opened:
            raise HTTPException(400, 'No se pudo abrir el archivo recibido.')
        ids = [d['docId'] for d in opened]
        # Avisar al frontend: que cargue las pestañas nuevas y active la primera.
        if windows.window is not None:
            try:
                windows.window.evaluate_js(
                    f'window.__openExternal && window.__openExternal({ids!r})')
            except Exception:
                pass
        windows.focus()
        return {'docs': opened}

    @app.get('/api/docs')
    def docs_list():
        """Lista todas las pestañas abiertas (para reconstruir la UI al arrancar)."""
        return {'docs': manager.list()}

    @app.get('/api/doc')
    def doc_info(pdf: PdfState = Depends(get_doc)):
        return pdf.info()

    @app.post('/api/open')
    def open_doc(body: OpenBody):
        """Abre uno o varios PDFs, cada uno en su propia pestaña nueva."""
        paths = body.path if body.path else windows.open_pdf_dialog_multi()
        if not paths:
            return {'cancelled': True}
        if isinstance(paths, str):
            paths = [paths]
        opened = []
        for path in paths:
            if not os.path.isfile(path):
                raise HTTPException(404, f'No existe el archivo: {path}')
            try:
                opened.append(manager.open(path))
            except Exception as e:
                raise HTTPException(400, str(e))
        # 'doc' = primera pestaña abierta (la que se activará); 'docs' = todas.
        return {'doc': opened[0], 'docs': opened}

    @app.post('/api/close')
    def close_doc(pdf: PdfState = Depends(get_doc), docId: str = ''):
        manager.close(docId)
        return {'closed': docId, 'docs': manager.list()}

    @app.get('/api/page/{index}')
    def page_png(index: int, scale: float = 2.0, pdf: PdfState = Depends(get_doc)):
        try:
            data = pdf.page_png(index, max(1.0, min(6.0, scale)))
        except Exception as e:
            raise HTTPException(400, str(e))
        return Response(data, media_type='image/png')

    @app.get('/api/thumb/{index}')
    def thumb_png(index: int, pdf: PdfState = Depends(get_doc)):
        try:
            data = pdf.thumb_png(index)
        except Exception as e:
            raise HTTPException(400, str(e))
        return Response(data, media_type='image/png')

    @app.get('/api/pagesize/{index}')
    def page_size(index: int, pdf: PdfState = Depends(get_doc)):
        try:
            return pdf.page_size(index)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/words/{index}')
    def words(index: int, pdf: PdfState = Depends(get_doc)):
        try:
            return pdf.words(index)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/annot')
    def add_annot(body: AnnotBody, pdf: PdfState = Depends(get_doc)):
        try:
            return pdf.add_annot(body.page, body.kind, body.color, body.width,
                                 body.opacity, body.rect, body.p1, body.p2, body.text,
                                 body.quads)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/sign')
    def sign(body: SignBody, pdf: PdfState = Depends(get_doc)):
        # El PNG llega en base64; admite el prefijo "data:image/png;base64,".
        raw = body.image.split(',', 1)[-1] if ',' in body.image else body.image
        try:
            png = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(400, 'La imagen de la firma no es válida.')
        try:
            return pdf.add_signature(body.page, body.rect, png, body.keepRatio,
                                     body.opacity)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/pages')
    def pages(body: PagesBody, pdf: PdfState = Depends(get_doc)):
        try:
            if body.action == 'add':
                return pdf.add_page(body.page)
            if body.action == 'duplicate':
                return pdf.duplicate_page(body.page)
            if body.action == 'delete':
                return pdf.delete_page(body.page)
            raise ValueError(f'Acción desconocida: {body.action}')
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/save')
    def save(body: SaveBody, pdf: PdfState = Depends(get_doc)):
        info = pdf.info()
        if not info.get('open'):
            raise HTTPException(400, 'No hay ningún documento abierto.')
        try:
            if body.saveAs or not info.get('path'):
                target = windows.save_dialog(info.get('name') or 'documento.pdf',
                                             'Documento PDF (*.pdf)')
                if not target:
                    return {'cancelled': True}
                result = pdf.save(target)
            else:
                result = pdf.save()
            result['savedTo'] = pdf.path
            return result
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/split-groups')
    def split_groups(body: SplitGroupsBody, pdf: PdfState = Depends(get_doc)):
        info = pdf.info()
        if not info.get('open'):
            raise HTTPException(400, 'No hay ningún documento abierto.')
        if not body.groups:
            raise HTTPException(400, 'Define al menos un grupo.')
        folder = windows.folder_dialog()
        if not folder:
            return {'cancelled': True}
        try:
            saved = pdf.split_groups([g.model_dump() for g in body.groups], folder)
        except Exception as e:
            raise HTTPException(400, str(e))
        return {'paths': saved, 'folder': folder}

    @app.post('/api/undo')
    def undo(pdf: PdfState = Depends(get_doc)):
        try:
            return pdf.undo()
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/redo')
    def redo(pdf: PdfState = Depends(get_doc)):
        try:
            return pdf.redo()
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/merge')
    def merge(body: MergeBody | None = None, pdf: PdfState = Depends(get_doc)):
        others = windows.open_pdf_dialog_multi()
        if not others:
            return {'cancelled': True}
        mode = (body.mode if body else 'current')
        try:
            if mode == 'new':
                return pdf.merge_new(others)
            return pdf.merge(others)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/text')
    def text(page: int = 0, scope: str = 'pg', pdf: PdfState = Depends(get_doc)):
        try:
            return {'text': pdf.text(None if scope == 'doc' else page)}
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/tables')
    def tables(page: int = 0, pdf: PdfState = Depends(get_doc)):
        try:
            return {'tables': pdf.tables(page)}
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/export-table')
    def export_table(body: TableExportBody, pdf: PdfState = Depends(get_doc)):
        try:
            found = pdf.tables(body.page)
        except Exception as e:
            raise HTTPException(400, str(e))
        if not found:
            raise HTTPException(400, 'No se detectaron tablas en la página.')
        name = (pdf.info().get('name') or 'documento').rsplit('.', 1)[0]
        if body.fmt == 'csv':
            target = windows.save_dialog(f'{name}_tabla.csv', 'CSV (*.csv)')
            if not target:
                return {'cancelled': True}
            buf = io.StringIO()
            writer = csv.writer(buf)
            for t in found:
                writer.writerows(t['rows'])
            with open(target, 'w', newline='', encoding='utf-8-sig') as fh:
                fh.write(buf.getvalue())
        else:
            target = windows.save_dialog(f'{name}_tabla.xls', 'Excel (*.xls)')
            if not target:
                return {'cancelled': True}
            with open(target, 'w', encoding='utf-8') as fh:
                fh.write('<html><head><meta charset="utf-8"></head><body>'
                         + _tables_html(found) + '</body></html>')
        return {'path': target}

    @app.post('/api/export')
    def export(body: ExportBody, pdf: PdfState = Depends(get_doc)):
        info = pdf.info()
        if not info.get('open'):
            raise HTTPException(400, 'No hay ningún documento abierto.')
        try:
            indexes = pdf.parse_range(body.range)
        except Exception:
            raise HTTPException(400, 'Rango de páginas no válido.')
        if not indexes:
            raise HTTPException(400, 'El rango no incluye ninguna página.')
        name, html = _doc_html(pdf, indexes)
        try:
            if body.fmt == 'word':
                target = windows.save_dialog(f'{name}.doc', 'Documento de Word (*.doc)')
                if not target:
                    return {'cancelled': True}
                with open(target, 'w', encoding='utf-8') as fh:
                    fh.write(html)
            elif body.fmt == 'excel':
                found = []
                for i in indexes:
                    found.extend(pdf.tables(i))
                if not found:
                    raise HTTPException(400, 'No se detectaron tablas en el rango indicado.')
                target = windows.save_dialog(f'{name}.xls', 'Excel (*.xls)')
                if not target:
                    return {'cancelled': True}
                with open(target, 'w', encoding='utf-8') as fh:
                    fh.write('<html><head><meta charset="utf-8"></head><body>'
                             + _tables_html(found) + '</body></html>')
            else:
                target = windows.save_dialog(f'{name}.html', 'Página web (*.html)')
                if not target:
                    return {'cancelled': True}
                with open(target, 'w', encoding='utf-8') as fh:
                    fh.write(html)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, str(e))
        return {'path': target}

    @app.post('/api/window')
    def window_control(body: WindowBody):
        return {'ok': windows.control(body.action)}

    app.mount('/', StaticFiles(directory=os.path.join(base_dir(), 'ui'), html=True), name='ui')
    return app
