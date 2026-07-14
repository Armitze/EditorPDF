"""Núcleo de manipulación de PDFs con PyMuPDF (fitz)."""
import io
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


def _apply_opacity(png_bytes, opacity):
    """Devuelve el PNG con su canal alfa escalado por `opacity` (0..1)."""
    from PIL import Image
    img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
    alpha = img.getchannel('A').point(lambda a: int(a * opacity))
    img.putalpha(alpha)
    out = io.BytesIO()
    img.save(out, format='PNG')
    return out.getvalue()


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

    def words(self, index):
        """Palabras de la página con su recuadro (para la capa de texto seleccionable).

        Devuelve coordenadas en puntos PDF, mismo sistema (origen arriba-izq.) que
        el render de la página. Lista vacía = página escaneada / sin texto digital.
        """
        with self._lock:
            page = self._require()[index]
            rect = page.rect
            words = [[w[0], w[1], w[2], w[3], w[4]] for w in page.get_text('words')]
            return {'width': rect.width, 'height': rect.height, 'words': words}

    # ---------- anotaciones ----------
    def add_annot(self, index, kind, color='#f2d024', width=3, opacity=0.8,
                  rect=None, p1=None, p2=None, text='', quads=None):
        with self._lock:
            self._require()
            self._snapshot()
            page = self.doc[index]
            rgb = _hex_to_rgb(color)
            # Anotaciones sobre texto seleccionado: reciben `quads` (una lista de
            # recuadros, uno por renglón de la selección) en puntos PDF.
            if kind in ('highlight', 'underline', 'strikeout'):
                if quads:
                    ql = [fitz.Rect(q).quad for q in quads]
                elif rect:
                    ql = [fitz.Rect(rect).quad]  # compatibilidad: resaltar un rectángulo
                else:
                    raise ValueError('Faltan las coordenadas de la selección.')
                if kind == 'highlight':
                    annot = page.add_highlight_annot(quads=ql)
                elif kind == 'underline':
                    annot = page.add_underline_annot(quads=ql)
                else:
                    annot = page.add_strikeout_annot(quads=ql)
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

    def add_signature(self, index, rect, png_bytes, keep_ratio=True, opacity=1.0):
        """Inserta una imagen (firma PNG) dentro de `rect` en la página `index`.

        rect: [x0, y0, x1, y1] en puntos PDF. png_bytes: bytes de la imagen.
        keep_ratio: conserva la proporción de la imagen dentro del recuadro.
        opacity: 0..1; si es < 1 se aplica al canal alfa de la firma.
        """
        if not png_bytes:
            raise ValueError('No se recibió ninguna imagen de firma.')
        opacity = max(0.05, min(1.0, opacity))
        with self._lock:
            self._require()
            self._snapshot()
            page = self.doc[index]
            r = fitz.Rect(rect)
            if r.width < 4 or r.height < 4:
                raise ValueError('El área de la firma es demasiado pequeña.')
            stream = png_bytes
            if opacity < 0.999:
                stream = _apply_opacity(png_bytes, opacity)
            # keep_proportion respeta el aspecto de la firma; overlay la pone
            # encima del contenido; el fondo transparente del PNG se conserva.
            page.insert_image(r, stream=stream,
                              keep_proportion=keep_ratio, overlay=True)
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

    def merge(self, other_paths):
        """Añade uno o varios PDFs (en orden) al documento actual."""
        paths = [other_paths] if isinstance(other_paths, str) else list(other_paths)
        with self._lock:
            doc = self._require()
            self._snapshot()
            added = 0
            for p in paths:
                other = fitz.open(p)
                added += other.page_count
                doc.insert_pdf(other)
                other.close()
            self.dirty = True
            self.rev += 1
            info = self.info()
            info['added'] = added
            return info

    def merge_new(self, other_paths):
        """Combina el documento actual y uno o varios PDFs en un documento NUEVO.

        El documento actual queda reemplazado en memoria por el resultado, sin
        modificar en disco ninguno de los originales. El nuevo documento no tiene
        ruta (Guardar pedirá ubicación) y arranca marcado como modificado. Los PDFs
        se añaden en el orden recibido, después de las páginas del documento actual.
        """
        paths = [other_paths] if isinstance(other_paths, str) else list(other_paths)
        with self._lock:
            current = self._require()
            combined = fitz.open()               # documento vacío nuevo
            combined.insert_pdf(current)         # páginas del actual
            added = 0
            for p in paths:
                other = fitz.open(p)
                added += other.page_count
                combined.insert_pdf(other)       # + páginas de cada PDF
                other.close()
            current.close()
            self.doc = combined
            self.path = None                     # sin ruta: Guardar como…
            self.dirty = True
            self.rev += 1
            self._undo.clear()
            self._redo.clear()
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


class DocumentManager:
    """Gestiona varios documentos abiertos a la vez (una pestaña por documento).

    Cada documento es un PdfState independiente identificado por un id entero
    monótono (como cadena: "1", "2", …). Los ids no se reutilizan: así una
    respuesta tardía nunca escribe en la pestaña equivocada. La lógica PDF vive
    íntegra en PdfState; aquí solo se orquesta el conjunto.
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._docs = {}      # docId -> PdfState
        self._order = []     # docIds en orden de apertura (para list())
        self._next_id = 1

    def _new_id(self):
        with self._lock:
            doc_id = str(self._next_id)
            self._next_id += 1
            return doc_id

    def open(self, path):
        """Abre un PDF en un documento NUEVO y devuelve su info (con docId)."""
        state = PdfState()
        info = state.open(path)          # puede lanzar (protegido, etc.)
        doc_id = self._new_id()
        with self._lock:
            self._docs[doc_id] = state
            self._order.append(doc_id)
        info['docId'] = doc_id
        return info

    def new_empty(self):
        """Crea un documento vacío (sin abrir archivo) y devuelve (docId, state)."""
        state = PdfState()
        doc_id = self._new_id()
        with self._lock:
            self._docs[doc_id] = state
            self._order.append(doc_id)
        return doc_id, state

    def get(self, doc_id):
        with self._lock:
            return self._docs.get(doc_id)

    def info(self, doc_id):
        state = self.get(doc_id)
        if not state:
            return None
        info = state.info()
        info['docId'] = doc_id
        return info

    def close(self, doc_id):
        with self._lock:
            state = self._docs.pop(doc_id, None)
            if doc_id in self._order:
                self._order.remove(doc_id)
        if state:
            state.close()
        return state is not None

    def list(self):
        """Info de todas las pestañas, en orden de apertura."""
        with self._lock:
            ids = list(self._order)
        out = []
        for doc_id in ids:
            info = self.info(doc_id)
            if info:
                out.append(info)
        return out

    def any_dirty(self):
        with self._lock:
            states = list(self._docs.values())
        return any(s.info().get('dirty') for s in states)

    def close_all(self):
        with self._lock:
            states = list(self._docs.values())
            self._docs.clear()
            self._order.clear()
        for s in states:
            s.close()
