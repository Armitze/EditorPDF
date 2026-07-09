"""Núcleo de manipulación de PDFs con PyMuPDF (fitz)."""
import os
import shutil
import tempfile
import threading

import fitz  # PyMuPDF

THUMB_WIDTH = 176
PAGE_RENDER_SCALE = 2.0
MAX_UNDO = 20
_INVALID_FILENAME = '<>:"/\\|?*'


def _hex_to_rgb(color):
    color = (color or '#f2d024').lstrip('#')
    return tuple(int(color[i:i + 2], 16) / 255 for i in (0, 2, 4))


class PdfState:
    """Documento PDF abierto y sus operaciones. Thread-safe (uvicorn + UI)."""

    def __init__(self):
        self._lock = threading.RLock()
        self.doc = None
        self.path = None
        self.dirty = False
        self.rev = 0
        self._undo = []
        self._redo = []

    # ---------- ciclo de vida ----------
    def open(self, path):
        with self._lock:
            doc = fitz.open(path)
            if doc.needs_pass:
                doc.close()
                raise ValueError('El PDF está protegido con contraseña.')
            if self.doc:
                self.doc.close()
            self.doc = doc
            self.path = path
            self.dirty = False
            self.rev += 1
            self._undo.clear()
            self._redo.clear()
            return self.info()

    def close(self):
        with self._lock:
            if self.doc:
                self.doc.close()
            self.doc = None
            self.path = None
            self.dirty = False
            self.rev += 1

    def info(self):
        with self._lock:
            if not self.doc:
                return {'open': False}
            return {
                'open': True,
                'name': os.path.basename(self.path) if self.path else 'Documento.pdf',
                'path': self.path,
                'count': self.doc.page_count,
                'dirty': self.dirty,
                'rev': self.rev,
                'undo': len(self._undo),
                'redo': len(self._redo),
            }

    def _require(self):
        if not self.doc:
            raise ValueError('No hay ningún documento abierto.')
        return self.doc

    # ---------- historial (deshacer / rehacer) ----------
    def _snapshot(self):
        """Guarda el estado actual antes de una operación que modifica el documento."""
        self._undo.append(self.doc.tobytes())
        if len(self._undo) > MAX_UNDO:
            self._undo.pop(0)
        self._redo.clear()

    def _restore(self, data):
        restored = fitz.open(stream=data, filetype='pdf')
        self.doc.close()
        self.doc = restored
        self.dirty = True
        self.rev += 1

    def undo(self):
        with self._lock:
            self._require()
            if not self._undo:
                raise ValueError('Nada que deshacer.')
            self._redo.append(self.doc.tobytes())
            self._restore(self._undo.pop())
            return self.info()

    def redo(self):
        with self._lock:
            self._require()
            if not self._redo:
                raise ValueError('Nada que rehacer.')
            self._undo.append(self.doc.tobytes())
            self._restore(self._redo.pop())
            return self.info()

    # ---------- renderizado ----------
    def page_png(self, index, scale=PAGE_RENDER_SCALE):
        with self._lock:
            page = self._require()[index]
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), annots=True)
            return pix.tobytes('png')

    def thumb_png(self, index):
        with self._lock:
            page = self._require()[index]
            scale = THUMB_WIDTH / max(page.rect.width, 1)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), annots=True)
            return pix.tobytes('png')

    def page_size(self, index):
        with self._lock:
            rect = self._require()[index].rect
            return {'width': rect.width, 'height': rect.height}

    # ---------- anotaciones ----------
    def add_annot(self, index, kind, color='#f2d024', width=3, opacity=0.8,
                  rect=None, p1=None, p2=None, text=''):
        with self._lock:
            self._require()
            self._snapshot()
            page = self.doc[index]
            rgb = _hex_to_rgb(color)
            if kind == 'highlight':
                annot = page.add_highlight_annot(fitz.Rect(rect))
                annot.set_colors(stroke=rgb)
            elif kind in ('line', 'arrow'):
                annot = page.add_line_annot(fitz.Point(p1), fitz.Point(p2))
                annot.set_colors(stroke=rgb)
                annot.set_border(width=width)
                if kind == 'arrow':
                    annot.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_OPEN_ARROW)
            elif kind == 'textbox':
                r = fitz.Rect(rect)
                if r.height < 18:
                    r.y1 = r.y0 + 18
                annot = page.add_freetext_annot(r, text or ' ', fontsize=12,
                                                text_color=(0.16, 0.19, 0.23),
                                                fill_color=(1, 1, 1))
                annot.set_border(width=0.8)
                annot.set_colors(stroke=rgb)
            else:
                raise ValueError(f'Herramienta desconocida: {kind}')
            annot.set_opacity(max(0.05, min(1.0, opacity)))
            annot.update()
            self.dirty = True
            self.rev += 1
            return self.info()

    def annot_count(self, index):
        with self._lock:
            page = self._require()[index]
            return sum(1 for _ in page.annots())

    # ---------- páginas ----------
    def add_page(self, index):
        with self._lock:
            doc = self._require()
            self._snapshot()
            ref = doc[index].rect
            doc.new_page(pno=index + 1, width=ref.width, height=ref.height)
            self.dirty = True
            self.rev += 1
            return self.info()

    def duplicate_page(self, index):
        with self._lock:
            doc = self._require()
            self._snapshot()
            doc.fullcopy_page(index, index + 1)
            self.dirty = True
            self.rev += 1
            return self.info()

    def delete_page(self, index):
        with self._lock:
            doc = self._require()
            if doc.page_count <= 1:
                raise ValueError('El documento debe conservar al menos una página.')
            self._snapshot()
            doc.delete_page(index)
            self.dirty = True
            self.rev += 1
            return self.info()

    # ---------- guardar ----------
    def save(self, path=None):
        with self._lock:
            doc = self._require()
            target = path or self.path
            if not target:
                raise ValueError('No hay ruta de destino.')
            if self.path and os.path.abspath(target) == os.path.abspath(self.path):
                try:
                    doc.save(target, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
                except Exception:
                    # Guardado incremental no disponible: reescribir vía archivo temporal.
                    fd, tmp = tempfile.mkstemp(suffix='.pdf')
                    os.close(fd)
                    doc.save(tmp)
                    doc.close()
                    shutil.move(tmp, target)
                    self.doc = fitz.open(target)
            else:
                doc.save(target)
                self.path = target
            self.dirty = False
            self.rev += 1
            return self.info()

    # ---------- separar / fusionar ----------
    def parse_range_ordered(self, spec):
        """Rango como «1-3, 7, 5»: conserva el orden indicado, sin duplicados."""
        count = self._require().page_count
        pages = []
        seen = set()
        for part in (spec or '').split(','):
            part = part.strip()
            if not part:
                continue
            if '-' in part:
                a, b = part.split('-', 1)
                rng = range(int(a) - 1, int(b))
            else:
                rng = [int(part) - 1]
            for p in rng:
                if 0 <= p < count and p not in seen:
                    seen.add(p)
                    pages.append(p)
        return pages

    def split_groups(self, groups, folder):
        """Guarda cada grupo {name, range} como un PDF independiente en `folder`."""
        with self._lock:
            doc = self._require()
            plan = []
            for i, g in enumerate(groups):
                name = (g.get('name') or '').strip() or f'Grupo {i + 1}'
                name = ''.join(c for c in name if c not in _INVALID_FILENAME).strip() or f'Grupo {i + 1}'
                if not name.lower().endswith('.pdf'):
                    name += '.pdf'
                try:
                    idxs = self.parse_range_ordered(g.get('range', ''))
                except Exception:
                    raise ValueError(f'Rango no válido en «{name}».')
                if not idxs:
                    raise ValueError(f'El rango de «{name}» no incluye ninguna página.')
                plan.append((name, idxs))
            saved = []
            for name, idxs in plan:
                out = fitz.open()
                for p in idxs:
                    out.insert_pdf(doc, from_page=p, to_page=p)
                path = os.path.join(folder, name)
                out.save(path)
                out.close()
                saved.append(path)
            return saved

    def merge(self, other_path):
        with self._lock:
            doc = self._require()
            self._snapshot()
            other = fitz.open(other_path)
            added = other.page_count
            doc.insert_pdf(other)
            other.close()
            self.dirty = True
            self.rev += 1
            info = self.info()
            info['added'] = added
            return info

    # ---------- extracción ----------
    def text(self, index=None):
        with self._lock:
            doc = self._require()
            if index is None:
                return '\n\n'.join(doc[i].get_text().strip() for i in range(doc.page_count)).strip()
            return doc[index].get_text().strip()

    def tables(self, index):
        with self._lock:
            page = self._require()[index]
            finder = page.find_tables()
            out = []
            for t in finder.tables:
                rows = [[('' if c is None else str(c)) for c in row] for row in t.extract()]
                if rows:
                    out.append({'rows': rows, 'cols': t.col_count, 'nrows': t.row_count})
            return out

    def html(self, indexes):
        with self._lock:
            doc = self._require()
            return ''.join(doc[i].get_text('xhtml') for i in indexes)

    def parse_range(self, spec):
        with self._lock:
            count = self._require().page_count
            if not spec or not spec.strip():
                return list(range(count))
            pages = set()
            for part in spec.split(','):
                part = part.strip()
                if '-' in part:
                    a, b = part.split('-', 1)
                    pages.update(range(int(a) - 1, int(b)))
                elif part:
                    pages.add(int(part) - 1)
            return sorted(p for p in pages if 0 <= p < count)
