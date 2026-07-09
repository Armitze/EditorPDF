"""Servidor FastAPI: sirve la interfaz (ui/) y expone la API del editor."""
import csv
import io
import os
import sys
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pdfcore import PdfState


def base_dir():
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


class WindowService:
    """Puente hacia la ventana pywebview; en modo --server usa alternativas."""

    def __init__(self):
        self.window = None
        self.allow_close = False  # el frontend lo pone en True tras confirmar

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
            if getattr(self, '_maximized', False):
                self.window.restore()
                self._maximized = False
            else:
                self.window.maximize()
                self._maximized = True
        elif action == 'close':
            # El frontend ya confirmó (o no había cambios): permitir el cierre real.
            self.allow_close = True
            self.window.destroy()
        return True


class OpenBody(BaseModel):
    path: str | None = None


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


def create_app(pdf: PdfState, windows: WindowService) -> FastAPI:
    app = FastAPI(title='PDF Editor Pro')

    @app.get('/api/doc')
    def doc_info():
        return pdf.info()

    @app.post('/api/open')
    def open_doc(body: OpenBody):
        path = body.path
        if not path:
            path = windows.open_pdf_dialog()
            if not path:
                return {'cancelled': True}
        if not os.path.isfile(path):
            raise HTTPException(404, f'No existe el archivo: {path}')
        try:
            return pdf.open(path)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/page/{index}')
    def page_png(index: int, scale: float = 2.0):
        try:
            data = pdf.page_png(index, max(1.0, min(6.0, scale)))
        except Exception as e:
            raise HTTPException(400, str(e))
        return Response(data, media_type='image/png')

    @app.get('/api/thumb/{index}')
    def thumb_png(index: int):
        try:
            data = pdf.thumb_png(index)
        except Exception as e:
            raise HTTPException(400, str(e))
        return Response(data, media_type='image/png')

    @app.get('/api/pagesize/{index}')
    def page_size(index: int):
        try:
            return pdf.page_size(index)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/annot')
    def add_annot(body: AnnotBody):
        try:
            return pdf.add_annot(body.page, body.kind, body.color, body.width,
                                 body.opacity, body.rect, body.p1, body.p2, body.text)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/pages')
    def pages(body: PagesBody):
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
    def save(body: SaveBody):
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
    def split_groups(body: SplitGroupsBody):
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
    def undo():
        try:
            return pdf.undo()
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/redo')
    def redo():
        try:
            return pdf.redo()
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/merge')
    def merge():
        other = windows.open_pdf_dialog()
        if not other:
            return {'cancelled': True}
        try:
            return pdf.merge(other)
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/text')
    def text(page: int = 0, scope: str = 'pg'):
        try:
            return {'text': pdf.text(None if scope == 'doc' else page)}
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.get('/api/tables')
    def tables(page: int = 0):
        try:
            return {'tables': pdf.tables(page)}
        except Exception as e:
            raise HTTPException(400, str(e))

    @app.post('/api/export-table')
    def export_table(body: TableExportBody):
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
    def export(body: ExportBody):
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
