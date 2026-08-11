"""Núcleo de manipulación de PDFs con PyMuPDF (fitz)."""
import io
import itertools
import os
import shutil
import tempfile
import threading

import fitz  # PyMuPDF

import renderpool

THUMB_WIDTH = 176
PAGE_RENDER_SCALE = 2.0
MAX_UNDO = 20

# Mejora de resolución: parámetros del re-rasterizado de escaneos borrosos.
ENHANCE_DPI = 300         # resolución objetivo (la de un escaneo de calidad)
ENHANCE_MAX_SIDE = 4500   # tope de píxeles del lado mayor (memoria y tamaño)
# Niveles de realce: (gamma, radio USM, porcentaje USM, umbral USM). La gamma
# > 1 oscurece los tonos medios (da cuerpo al texto desvaído); la máscara de
# enfoque es deliberadamente suave: el enfoque fuerte sobre un reescalado crea
# halos alrededor de las letras y «daña» la imagen en vez de mejorarla.
ENHANCE_LEVELS = {
    'soft': (1.0, 1.0, 70, 2),
    'medium': (1.15, 1.1, 90, 2),
    'strong': (1.25, 1.2, 110, 2),
}
_INVALID_FILENAME = '<>:"/\\|?*'

# Identificador único de cada PdfState para las claves de caché de los workers
# (id() puede reutilizarse tras el recolector; un contador nunca).
_state_uid = itertools.count(1)


def _try_remove(path):
    """Borra `path` si se puede. True = ya no existe (o nunca existió)."""
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        return False   # un worker aún lo tiene abierto: se reintenta luego


class PasswordRequired(Exception):
    """El PDF necesita contraseña (o la recibida no es correcta).

    `wrong` distingue «hay que pedirla» de «la que dieron no vale», para que la
    interfaz pueda mostrar el mensaje adecuado.
    """

    def __init__(self, message, wrong=False):
        super().__init__(message)
        self.wrong = wrong


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
        # Cifrado: `encrypted` marca que el original pedía clave; `password` la
        # guarda en memoria (nunca en disco) para poder reescribir el archivo al
        # guardar sin que el usuario la reintroduzca.
        self.encrypted = False
        self.password = None
        self._undo = []
        self._redo = []
        # Render en paralelo: instantánea en disco de la revisión actual, que
        # los workers del pool abren en modo solo lectura (ver renderpool).
        self._uid = next(_state_uid)
        self._snap_path = None
        self._snap_rev = None
        self._old_snaps = []   # instantáneas viejas pendientes de borrar

    # ---------- ciclo de vida ----------
    def open(self, path, password=None):
        """Abre un PDF. Si está protegido, `password` debe traer la contraseña.

        Lanza PasswordRequired si hace falta clave y no se dio (o es incorrecta),
        para que la interfaz pueda pedirla en vez de fallar sin más.
        """
        with self._lock:
            doc = fitz.open(path)
            if doc.needs_pass:
                # authenticate: 0 = no válida; 1 = usuario; 2 = dueño; 4 = ambas.
                ok = doc.authenticate(password) if password else 0
                if not ok:
                    doc.close()
                    raise PasswordRequired(
                        'La contraseña no es correcta.' if password
                        else 'El PDF está protegido con contraseña.',
                        wrong=bool(password))
                self.encrypted = True
                self.password = password
            else:
                self.encrypted = False
                self.password = None
            if self.doc:
                self.doc.close()
            self.doc = doc
            self.path = path
            self.dirty = False
            self.rev += 1
            self._undo.clear()
            self._redo.clear()
            return self.info()

    def remove_password(self, path=None):
        """Guarda el documento SIN cifrado (quita la contraseña).

        `path`: destino; si es None se reescribe sobre el archivo actual. El
        documento ya está autenticado (se abrió con la clave), así que basta con
        guardar sin cifrado. A partir de aquí el PDF deja de pedir contraseña.
        """
        with self._lock:
            doc = self._require()
            if not self.encrypted:
                raise ValueError('El documento no tiene contraseña.')
            target = path or self.path
            if not target:
                raise ValueError('No hay ruta de destino.')
            same = self.path and os.path.abspath(target) == os.path.abspath(self.path)
            if same:
                # No se puede reescribir el archivo que está abierto: vía temporal.
                fd, tmp = tempfile.mkstemp(suffix='.pdf')
                os.close(fd)
                doc.save(tmp, encryption=fitz.PDF_ENCRYPT_NONE)
                doc.close()
                shutil.move(tmp, target)
                self.doc = fitz.open(target)
            else:
                doc.save(target, encryption=fitz.PDF_ENCRYPT_NONE)
                self.doc.close()
                self.doc = fitz.open(target)
            self.path = target
            self.encrypted = False
            self.password = None
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
            self.encrypted = False
            self.password = None   # no dejar la clave en memoria al cerrar
            self.rev += 1
            self._drop_snapshots()

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
                'encrypted': self.encrypted,
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
    def _render_source(self):
        """(cache_key, path) que los workers del pool deben abrir, o None.

        Llamar con el lock cogido. Prepara (si no existe ya) una instantánea en
        disco de la revisión actual: así los workers renderizan una copia de
        solo lectura y nunca tocan el archivo original del usuario (que debe
        poder reescribirse al guardar). Los documentos cifrados devuelven None
        para no dejar copias descifradas en disco: esos se renderizan en el
        proceso principal, como siempre.
        """
        if self.encrypted:
            return None
        if self._snap_rev != self.rev:
            fd, tmp = tempfile.mkstemp(suffix='.pdf', prefix=renderpool.SNAP_PREFIX)
            os.close(fd)
            try:
                if not self.dirty and self.path and os.path.isfile(self.path):
                    shutil.copyfile(self.path, tmp)
                else:
                    self.doc.save(tmp)
            except Exception:
                _try_remove(tmp)
                return None
            if self._snap_path:
                self._old_snaps.append(self._snap_path)
            self._snap_path = tmp
            self._snap_rev = self.rev
            # Instantáneas viejas: borrarlas ya (si algún worker aún tiene una
            # abierta fallará en Windows; se reintenta en la siguiente ocasión).
            self._old_snaps = [p for p in self._old_snaps if not _try_remove(p)]
        return (f'{self._uid}:{self.rev}', self._snap_path)

    def _drop_snapshots(self):
        if self._snap_path:
            self._old_snaps.append(self._snap_path)
            self._snap_path = None
            self._snap_rev = None
        self._old_snaps = [p for p in self._old_snaps if not _try_remove(p)]

    def page_png(self, index, scale=PAGE_RENDER_SCALE):
        # Primero el pool de procesos (varias páginas a la vez, un núcleo cada
        # una); si no está disponible, render clásico en este proceso.
        with self._lock:
            self._require()
            src = self._render_source()
        if src:
            data = renderpool.render(src[0], src[1], index, scale=scale)
            if data is not None:
                return data
        with self._lock:
            page = self._require()[index]
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), annots=True)
            return pix.tobytes('png')

    def thumb_png(self, index, dpr=1.0):
        # `dpr` = densidad de la pantalla: la miniatura se rasteriza a los
        # píxeles físicos que ocupará (nítida con escalado de Windows >100%).
        width = THUMB_WIDTH * max(1.0, min(3.0, dpr))
        with self._lock:
            self._require()
            src = self._render_source()
        if src:
            data = renderpool.render(src[0], src[1], index, thumb_width=width)
            if data is not None:
                return data
        with self._lock:
            page = self._require()[index]
            scale = width / max(page.rect.width, 1)
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), annots=True)
            return pix.tobytes('png')

    def page_size(self, index):
        with self._lock:
            rect = self._require()[index].rect
            return {'width': rect.width, 'height': rect.height}

    def page_sizes(self):
        """Tamaños de TODAS las páginas en una llamada (para la vista continua)."""
        with self._lock:
            doc = self._require()
            return {'sizes': [{'width': p.rect.width, 'height': p.rect.height}
                              for p in doc],
                    'rev': self.rev}

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
                # Texto libre SIN caja: nada de fill_color (dejaba un recuadro
                # blanco feo sobre el documento) ni borde. Solo el texto, como
                # si se escribiera directamente sobre la página. Un FreeText no
                # admite set_colors(stroke=…) (ValueError en PyMuPDF recientes),
                # así que el color/estado se fija todo en la creación.
                annot = page.add_freetext_annot(r, text or ' ', fontsize=12,
                                                text_color=(0.16, 0.19, 0.23))
                annot.set_border(width=0)
                annot.set_opacity(max(0.05, min(1.0, opacity)))
                annot.update()
                self.dirty = True
                self.rev += 1
                return self.info()
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

    def annots(self, index):
        """Anotaciones movibles de la página, con su xref y recuadro en puntos.

        Solo las que tiene sentido reposicionar con el puntero (texto libre,
        líneas/flechas, formas). El resaltado/subrayado va pegado a un texto y
        moverlo no tendría sentido, así que se omite. El `xref` identifica la
        anotación de forma estable entre revisiones (para moverla luego).
        """
        movable = {
            fitz.PDF_ANNOT_FREE_TEXT, fitz.PDF_ANNOT_LINE,
            fitz.PDF_ANNOT_SQUARE, fitz.PDF_ANNOT_CIRCLE,
            fitz.PDF_ANNOT_POLYGON, fitz.PDF_ANNOT_POLY_LINE,
            fitz.PDF_ANNOT_STAMP, fitz.PDF_ANNOT_INK,
        }
        with self._lock:
            page = self._require()[index]
            out = []
            for a in page.annots():
                if a.type[0] not in movable:
                    continue
                r = a.rect
                out.append({
                    'xref': a.xref, 'kind': a.type[1],
                    'rect': [r.x0, r.y0, r.x1, r.y1],
                    # Solo el texto libre es editable; el resto no lleva texto.
                    'editable': a.type[0] == fitz.PDF_ANNOT_FREE_TEXT,
                    'text': a.info.get('content', ''),
                })
            return out

    @staticmethod
    def _find_annot(page, xref):
        for a in page.annots():
            if a.xref == xref:
                return a
        raise ValueError('La anotación ya no existe.')

    def move_annot(self, index, xref, dx, dy):
        """Desplaza la anotación `xref` de la página `index` en (dx, dy) puntos.

        Reubica el recuadro conservando su tamaño; PyMuPDF regenera la
        apariencia al hacer update(). Devuelve el nuevo recuadro para que la
        interfaz confirme la posición sin reconsultar toda la página.
        """
        with self._lock:
            page = self._require()[index]
            target = self._find_annot(page, xref)
            self._snapshot()
            r = target.rect
            new = fitz.Rect(r.x0 + dx, r.y0 + dy, r.x1 + dx, r.y1 + dy)
            target.set_rect(new)
            target.update()
            self.dirty = True
            self.rev += 1
            return self.info()

    def edit_annot(self, index, xref, text):
        """Reemplaza el texto de la anotación de texto libre `xref`.

        Conserva posición, color y tamaño de fuente; solo cambia el contenido.
        El recuadro se ensancha si el texto nuevo no cabría (una línea alta).
        """
        with self._lock:
            page = self._require()[index]
            target = self._find_annot(page, xref)
            if target.type[0] != fitz.PDF_ANNOT_FREE_TEXT:
                raise ValueError('Esa anotación no es un texto editable.')
            self._snapshot()
            target.set_info(content=text)
            target.update()
            self.dirty = True
            self.rev += 1
            return self.info()

    def delete_annot(self, index, xref):
        """Elimina la anotación `xref` de la página `index`."""
        with self._lock:
            page = self._require()[index]
            target = self._find_annot(page, xref)
            self._snapshot()
            page.delete_annot(target)
            self.dirty = True
            self.rev += 1
            return self.info()

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

    def rotate_page(self, index=None, delta=90):
        """Gira páginas `delta` grados (múltiplos de 90; negativo = antihorario).

        `index` None = todo el documento; si no, solo esa página. La rotación es
        una propiedad de la página (no se re-rasteriza nada), así que no hay
        pérdida de calidad y se deshace con Ctrl+Z como cualquier otro cambio.
        """
        if delta % 90:
            raise ValueError('El giro debe ser múltiplo de 90 grados.')
        with self._lock:
            doc = self._require()
            idxs = range(doc.page_count) if index is None else [index]
            self._snapshot()
            for i in idxs:
                page = doc[i]
                page.set_rotation((page.rotation + delta) % 360)
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

    def move_page(self, index, to):
        """Mueve la página `index` para que quede en la posición `to` (0-based).

        El `move_page` de PyMuPDF inserta DELANTE de la página que ocupa `to`
        antes de borrar la original, así que al mover hacia delante hay que
        apuntar una posición más allá para que el resultado final sea `to`.
        """
        with self._lock:
            doc = self._require()
            count = doc.page_count
            if not (0 <= index < count and 0 <= to < count):
                raise ValueError('Posición de página fuera de rango.')
            if index == to:
                return self.info()
            self._snapshot()
            doc.move_page(index, -1 if to == count - 1 and to > index
                          else (to + 1 if to > index else to))
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
            # Un PDF que venía con clave debe seguir teniéndola al guardarlo: si
            # no, el «Guardar como» (o el guardado no incremental) la quitaría sin
            # avisar. Para quitarla está remove_password(), que es explícito.
            keep = {}
            if self.encrypted and self.password:
                keep = {'encryption': fitz.PDF_ENCRYPT_AES_256,
                        'user_pw': self.password, 'owner_pw': self.password}
            if self.path and os.path.abspath(target) == os.path.abspath(self.path):
                try:
                    doc.save(target, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
                except Exception:
                    # Guardado incremental no disponible: reescribir vía archivo temporal.
                    fd, tmp = tempfile.mkstemp(suffix='.pdf')
                    os.close(fd)
                    doc.save(tmp, **keep)
                    doc.close()
                    shutil.move(tmp, target)
                    self.doc = fitz.open(target)
                    if self.encrypted and self.password:
                        self.doc.authenticate(self.password)
            else:
                doc.save(target, **keep)
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

    # ---------- exportar a Word ----------
    def export_docx(self, target, indexes=None):
        """Exporta a un .docx REAL de Word con el diseño reconstruido.

        Antes se guardaba HTML renombrado a .doc: texto suelto sin el diseño de
        la página. Ahora exportword reconstruye cada página al estilo de los
        conversores en línea: fondo gráfico + texto editable posicionado.
        `indexes`: páginas 0-based; None = todas.

        La conversión corre FUERA del candado (tarda segundos): trabaja sobre
        la instantánea de solo lectura del documento, así no bloquea el render
        ni el resto de la interfaz mientras tanto.
        """
        import exportword
        own_tmp = None
        with self._lock:
            self._require()
            src = self._render_source()
            if src:
                path = src[1]
            else:
                # Documento cifrado (sin instantánea permanente): copia temporal
                # solo durante la conversión, se borra al terminar.
                fd, own_tmp = tempfile.mkstemp(suffix='.pdf')
                os.close(fd)
                self.doc.save(own_tmp)
                path = own_tmp
        try:
            exportword.convert(path, target, indexes)
        finally:
            if own_tmp:
                _try_remove(own_tmp)
        return target

    # ---------- extracción ----------
    def text(self, index=None):
        with self._lock:
            doc = self._require()
            if index is None:
                return '\n\n'.join(doc[i].get_text().strip() for i in range(doc.page_count)).strip()
            return doc[index].get_text().strip()

    # ---------- búsqueda ----------
    def search(self, query, limit=500):
        """Busca `query` en todo el documento.

        Devuelve una lista de coincidencias {page, rect, context}, en orden de
        página. `rect` va en puntos PDF (mismo sistema que el render), para que
        la interfaz pueda dibujar el resaltado encima de la página.
        `context` es la línea donde aparece, para la lista de resultados.
        """
        query = (query or '').strip()
        with self._lock:
            doc = self._require()
            if not query:
                return []
            out = []
            for i in range(doc.page_count):
                page = doc[i]
                try:
                    hits = page.search_for(query)
                except Exception:
                    continue
                if not hits:
                    continue
                lines = self._page_lines(page)
                for r in hits:
                    out.append({
                        'page': i,
                        'rect': [r.x0, r.y0, r.x1, r.y1],
                        'context': self._line_at(lines, r),
                    })
                    if len(out) >= limit:
                        return out
            return out

    @staticmethod
    def _page_lines(page):
        """Líneas de la página con su recuadro, para dar contexto a cada hallazgo."""
        lines = []
        for block in page.get_text('dict').get('blocks', []):
            for line in block.get('lines', []):
                text = ''.join(s.get('text', '') for s in line.get('spans', []))
                if text.strip():
                    lines.append((fitz.Rect(line['bbox']), text.strip()))
        return lines

    @staticmethod
    def _line_at(lines, rect):
        """Texto de la línea que contiene `rect` (el que más se solapa)."""
        best, best_area = '', 0
        for lrect, text in lines:
            inter = lrect & rect
            area = abs(inter) if not inter.is_empty else 0
            if area > best_area:
                best, best_area = text, area
        return best

    # ---------- OCR (documentos escaneados) ----------
    def ocr_text(self, index=None, lang=None, force=False):
        """Texto de la página (o del documento) usando OCR donde haga falta.

        En páginas con texto digital se devuelve ese texto tal cual (es exacto y
        además instantáneo); solo se pasa por OCR lo que parece escaneado. Con
        `force=True` se aplica OCR a todo.

        Devuelve {'text', 'ocrPages': nº de páginas reconocidas, 'lang'}.
        """
        import ocr as ocr_mod
        with self._lock:
            doc = self._require()
            idxs = range(doc.page_count) if index is None else [index]
            lang = lang or ocr_mod.best_lang()
            parts, n_ocr = [], 0
            for i in idxs:
                page = doc[i]
                if force or ocr_mod.page_needs_ocr(page):
                    parts.append(ocr_mod.page_text(page, lang))
                    n_ocr += 1
                else:
                    parts.append(page.get_text().strip())
            return {'text': '\n\n'.join(p for p in parts if p).strip(),
                    'ocrPages': n_ocr, 'lang': lang}

    def ocr_apply(self, index=None, lang=None):
        """Añade capa de texto invisible sobre las páginas escaneadas.

        Así el escaneo pasa a ser buscable y su texto seleccionable, sin cambiar
        el aspecto de la página. Solo toca las páginas que lo necesitan.
        """
        import ocr as ocr_mod
        with self._lock:
            doc = self._require()
            idxs = list(range(doc.page_count)) if index is None else [index]
            targets = [i for i in idxs if ocr_mod.page_needs_ocr(doc[i])]
            if not targets:
                info = self.info()
                info['ocrPages'] = 0
                return info
            lang = lang or ocr_mod.best_lang()
            self._snapshot()
            # Se reemplaza cada página escaneada por su versión con capa OCR.
            # Tesseract devuelve la página a 1pt por píxel (4,17x más grande a
            # 300 dpi), así que se reencaja en una página del tamaño original:
            # si no, exportar a Word produce páginas gigantes y las tolerancias
            # de detección de tablas dejan de cuadrar.
            for i in targets:
                rect = doc[i].rect
                data = ocr_mod.ocr_pdf_page(doc[i], lang)
                with fitz.open('pdf', data) as ocr_doc:
                    page = doc.new_page(i + 1, width=rect.width,
                                        height=rect.height)
                    page.show_pdf_page(page.rect, ocr_doc, 0)
                doc.delete_page(i)
            self.dirty = True
            self.rev += 1
            info = self.info()
            info['ocrPages'] = len(targets)
            info['lang'] = lang
            return info

    # ---------- mejora de resolución (escaneos borrosos) ----------
    @staticmethod
    def _page_is_scan(page, min_coverage=0.5):
        """True si la página es esencialmente una imagen (escaneo o foto).

        Se mide cuánta superficie de la página cubren sus imágenes. Un
        documento digital con un logo no llega al umbral; un escaneo (aunque
        tenga capa OCR encima) sí.
        """
        area = abs(page.rect)
        if not area:
            return False
        covered = 0.0
        for img in page.get_images(full=True):
            try:
                covered += sum(abs(r) for r in page.get_image_rects(img[0]))
            except Exception:
                continue
        return covered >= area * min_coverage

    @staticmethod
    def _page_native_scale(page):
        """Factor de render que reproduce la página a la resolución NATIVA de
        su imagen más detallada (px de imagen por punto de página).

        Renderizar a la escala nativa evita que MuPDF interpole: los píxeles
        del render son los píxeles reales del escaneo, y el reescalado fino lo
        hacemos después con Lanczos (mucho mejor). Sin imágenes devuelve None.
        """
        best = 0.0
        for img in page.get_images(full=True):
            try:
                rects = page.get_image_rects(img[0])
            except Exception:
                continue
            for r in rects:
                if r.width > 1:
                    best = max(best, img[2] / r.width)   # img[2] = ancho en px
        return best or None

    def enhance_pages(self, index=None, level='medium', dpi=ENHANCE_DPI,
                      force=False):
        """Mejora páginas escaneadas borrosas re-muestreándolas con cuidado.

        Cadena de procesado (elegida comparando métodos sobre escaneos reales;
        el enfoque agresivo + JPEG de la primera versión creaba halos y ruido):

        1. Render a la resolución NATIVA de la imagen incrustada (sin dejar
           que MuPDF invente píxeles interpolando).
        2. Reescalado a ~`dpi` con Lanczos, el filtro de re-muestreo que mejor
           conserva los bordes de las letras.
        3. Punto blanco: el fondo gris del escaneo se estira a blanco puro
           (percentil 97 por canal), sin desplazar los colores.
        4. Gamma > 1 según el nivel: da cuerpo al texto desvaído.
        5. Máscara de enfoque SUAVE (el «des-borroso» final, sin halos).
        6. Salida PNG sin pérdida: nada de artefactos JPEG sobre el texto.

        `index` None = todo el documento. Por defecto solo se tocan las
        páginas que parecen escaneadas: una página con texto digital perdería
        su texto seleccionable al convertirse en imagen. Con `force=True` se
        mejora también esa página (el usuario la eligió a propósito).

        La página mejorada pierde la capa OCR si la tenía (vuelve a ser solo
        imagen); basta con reaplicar el OCR después.
        """
        import numpy as np
        from PIL import Image, ImageFilter
        if level not in ENHANCE_LEVELS:
            raise ValueError(f'Nivel de mejora desconocido: {level}')
        gamma, radius, percent, threshold = ENHANCE_LEVELS[level]
        with self._lock:
            doc = self._require()
            idxs = list(range(doc.page_count)) if index is None else [index]
            targets = idxs if force else [i for i in idxs
                                          if self._page_is_scan(doc[i])]
            if not targets:
                info = self.info()
                info['enhanced'] = 0
                return info
            self._snapshot()
            for i in targets:
                page = doc[i]
                rect = page.rect
                side = max(rect.width, rect.height)
                # Escala objetivo (~300 dpi) con tope de píxeles por lado.
                target = min(dpi / 72.0, ENHANCE_MAX_SIDE / side)
                # Escala de render: la nativa de la imagen incrustada, sin
                # pasarse del objetivo (si el escaneo ya viene a más de
                # 300 dpi no hay nada que ampliar) ni bajar de 1:1.
                native = self._page_native_scale(page)
                render = max(1.0, min(native or target, target))
                pix = page.get_pixmap(matrix=fitz.Matrix(render, render),
                                      annots=True)
                img = Image.frombytes('RGB', (pix.width, pix.height),
                                      pix.samples)
                if target / render > 1.05:
                    img = img.resize((int(pix.width * target / render),
                                      int(pix.height * target / render)),
                                     Image.LANCZOS)
                # Punto blanco por canal (percentil 97 -> 255).
                a = np.asarray(img).astype(np.float32)
                wp = np.maximum(np.percentile(a, 97, axis=(0, 1)), 1.0)
                a = np.clip(a * (255.0 / wp), 0, 255)
                if gamma != 1.0:
                    a = ((a / 255.0) ** gamma) * 255.0
                img = Image.fromarray(a.astype(np.uint8))
                img = img.filter(ImageFilter.UnsharpMask(
                    radius=radius, percent=percent, threshold=threshold))
                buf = io.BytesIO()
                img.save(buf, format='PNG')
                # Reemplazar la página por su versión mejorada, mismo tamaño
                # en puntos (mismo patrón que ocr_apply: insertar y borrar).
                new = doc.new_page(i + 1, width=rect.width,
                                   height=rect.height)
                new.insert_image(new.rect, stream=buf.getvalue())
                doc.delete_page(i)
            self.dirty = True
            self.rev += 1
            info = self.info()
            info['enhanced'] = len(targets)
            return info

    def tables(self, index):
        with self._lock:
            page = self._require()[index]
            out = self._extract_tables(page.find_tables())
            if not out:
                # En un escaneo con capa OCR no hay líneas vectoriales que
                # delimiten la tabla (los bordes son píxeles de la imagen):
                # se detectan las líneas en la propia imagen y se rellenan las
                # celdas con las palabras del OCR. Si numpy no está en el
                # paquete se sigue con el último recurso en vez de fallar.
                try:
                    import scantables
                    out = scantables.page_tables(page)
                except ImportError:
                    pass
            if not out:
                # Último recurso: deducir la tabla por la alineación del texto.
                out = self._extract_tables(page.find_tables(strategy='text'))
            return out

    @staticmethod
    def _extract_tables(finder):
        out = []
        for t in finder.tables:
            rows = [[('' if c is None else str(c)) for c in row] for row in t.extract()]
            rows = [r for r in rows if any(c.strip() for c in r)]
            if rows:
                out.append({'rows': rows, 'cols': t.col_count, 'nrows': len(rows)})
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

    def open(self, path, password=None):
        """Abre un PDF en un documento NUEVO y devuelve su info (con docId)."""
        state = PdfState()
        info = state.open(path, password)   # puede lanzar PasswordRequired
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
