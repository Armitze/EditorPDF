"""Renderizado de páginas PDF en procesos aparte (aprovecha varios núcleos).

PyMuPDF no suelta el GIL y cada documento serializa sus operaciones con un
candado, así que renderizar muchas páginas en el proceso principal es
secuencial aunque las peticiones lleguen en paralelo. Este módulo delega el
rasterizado en un ProcessPoolExecutor: cada worker abre su PROPIA copia del
PDF (un archivo de solo lectura en disco) y renderiza sin bloquear al resto.

El proceso principal pide renders con `render(...)`. Si el pool no está
disponible o falla, devuelve None y el llamador renderiza en su propio
proceso como antes (misma calidad, solo que sin paralelismo).
"""
import glob
import os
import tempfile
import threading
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import fitz  # PyMuPDF

# Prefijo de las instantáneas temporales que los workers abren (ver pdfcore).
SNAP_PREFIX = 'pdfeditorpro_snap_'

_pool = None
_pool_lock = threading.Lock()
_broken = False


def _n_workers():
    # Un worker por núcleo menos uno (para la app y el SO), acotado a 2..6:
    # más de ~6 páginas a la vez apenas mejora y multiplica la memoria.
    return max(2, min(6, (os.cpu_count() or 2) - 1))


def _get_pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=_n_workers())
        return _pool


def warmup():
    """Arranca los workers ya (para que el primer render no espere al spawn)."""
    try:
        pool = _get_pool()
        for _ in range(_n_workers()):
            pool.submit(_noop)
    except Exception:
        pass


def shutdown():
    """Cierra el pool. Llamar antes de borrar las instantáneas temporales."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.shutdown(wait=True, cancel_futures=True)
            _pool = None


def clean_stale_snapshots():
    """Borra instantáneas huérfanas de sesiones anteriores (cierre forzado)."""
    pattern = os.path.join(tempfile.gettempdir(), SNAP_PREFIX + '*')
    for path in glob.glob(pattern):
        try:
            os.remove(path)
        except OSError:
            pass  # en uso por otra instancia: se queda


def render(cache_key, path, index, scale=None, thumb_width=None):
    """PNG de la página `index` renderizado en el pool, o None si no se pudo.

    `cache_key` identifica documento+revisión: cada worker cachea el documento
    abierto bajo esa clave, así una revisión nueva nunca reutiliza un handle
    viejo. Si se pasa `thumb_width`, la escala se calcula en el worker para
    que la miniatura salga con ese ancho en píxeles.
    """
    global _broken
    if _broken:
        return None
    try:
        fut = _get_pool().submit(_render_png, cache_key, path, index, scale, thumb_width)
        return fut.result(timeout=60)
    except BrokenProcessPool:
        _broken = True   # el pool murió: a partir de aquí, render en el proceso principal
        return None
    except Exception:
        # Error del worker (página inexistente, instantánea borrada…): el
        # llamador renderiza en su proceso y reporta el error real si lo hay.
        return None


# ---------- lo que corre DENTRO de cada worker ----------

_docs = OrderedDict()   # cache_key -> fitz.Document (cache por proceso worker)
_MAX_DOCS = 4


def _noop():
    return None


def _open_cached(cache_key, path):
    doc = _docs.get(cache_key)
    if doc is None:
        while len(_docs) >= _MAX_DOCS:
            _docs.popitem(last=False)[1].close()
        doc = fitz.open(path)
        _docs[cache_key] = doc
    else:
        _docs.move_to_end(cache_key)
    return doc


def _render_png(cache_key, path, index, scale, thumb_width):
    doc = _open_cached(cache_key, path)
    page = doc[index]
    if thumb_width:
        scale = thumb_width / max(page.rect.width, 1)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), annots=True)
    return pix.tobytes('png')
