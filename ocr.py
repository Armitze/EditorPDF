"""Reconocimiento óptico de caracteres (OCR) con Tesseract.

El OCR hace falta cuando el PDF es un escaneo: la página es una imagen y no
tiene texto digital, así que `page.get_text()` devuelve cadena vacía. Aquí se
renderiza la página a imagen y se pasa por Tesseract para obtener el texto.

Tesseract es un programa aparte (no un paquete de Python) y en Windows no suele
quedar en el PATH, así que se busca también en sus rutas habituales de
instalación. Todo ocurre en local: ninguna página sale del equipo.
"""
import os
import shutil
import sys

import fitz

# Resolución de render para OCR. Tesseract está afinado para ~300 dpi; como los
# PDFs son de 72 dpi, hace falta escalar ~4.17x. Menos resolución = más errores.
OCR_DPI = 300
_SCALE = OCR_DPI / 72


def _bundled_dir():
    """Carpeta `tesseract/` que se distribuye DENTRO de la app.

    Es la opción preferente: así el OCR funciona sin que nadie instale nada.
    En el .exe congelado los datos van a sys._MEIPASS; en desarrollo, junto a
    este archivo.
    """
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, 'tesseract')


# Rutas típicas del instalador de Windows: solo como respaldo, por si alguien
# ya lo tiene instalado y la copia embebida faltara.
_WIN_PATHS = (
    r'C:\Program Files\Tesseract-OCR',
    r'C:\Program Files (x86)\Tesseract-OCR',
    os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR'),
    os.path.expandvars(r'%USERPROFILE%\AppData\Local\Tesseract-OCR'),
)


class OcrUnavailable(Exception):
    """Tesseract no está instalado o no se encuentra."""


def _find_dir():
    """Carpeta de Tesseract: primero la embebida, luego el sistema."""
    d = _bundled_dir()
    if os.path.isfile(os.path.join(d, 'tesseract.exe')):
        return d
    exe = shutil.which('tesseract')
    if exe:
        return os.path.dirname(exe)
    for d in _WIN_PATHS:
        if os.path.isfile(os.path.join(d, 'tesseract.exe')):
            return d
    return None


def find_exe():
    """Ruta al ejecutable de Tesseract, o None."""
    d = _find_dir()
    if not d:
        return None
    for name in ('tesseract.exe', 'tesseract'):
        exe = os.path.join(d, name)
        if os.path.isfile(exe):
            return exe
    return shutil.which('tesseract')


def tessdata_dir():
    """Carpeta `tessdata` (los modelos de idioma), o None.

    PyMuPDF la necesita explícitamente: no lee la variable TESSDATA_PREFIX por
    su cuenta si Tesseract no está en el PATH.
    """
    env = os.environ.get('TESSDATA_PREFIX')
    if env and os.path.isdir(env):
        return env
    d = _find_dir()
    if d:
        td = os.path.join(d, 'tessdata')
        if os.path.isdir(td):
            return td
    return None


def available():
    """True si se puede hacer OCR (Tesseract + modelos de idioma)."""
    return bool(find_exe() and tessdata_dir())


def languages():
    """Idiomas instalados (p. ej. ['spa', 'eng']). Lista vacía si no hay OCR."""
    td = tessdata_dir()
    if not td:
        return []
    return sorted(f[:-12] for f in os.listdir(td) if f.endswith('.traineddata'))


def best_lang(preferred=('spa', 'eng')):
    """Mejor idioma disponible: español si está, si no inglés, si no el primero."""
    langs = languages()
    for p in preferred:
        if p in langs:
            return p
    return langs[0] if langs else 'eng'


def status():
    """Estado del OCR, para que la interfaz explique qué falta."""
    exe = find_exe()
    return {
        'available': available(),
        'exe': exe,
        'tessdata': tessdata_dir(),
        'languages': languages(),
        'lang': best_lang() if available() else None,
    }


def _require():
    if not find_exe():
        raise OcrUnavailable(
            'Tesseract no está instalado. Instálalo para poder usar el OCR '
            'en documentos escaneados.')
    if not tessdata_dir():
        raise OcrUnavailable(
            'No se encuentran los modelos de idioma de Tesseract (tessdata).')


def page_text(page, lang=None):
    """Texto de una página mediante OCR. `page` es un fitz.Page.

    Se usa siempre OCR (aunque la página tuviera texto): quien llama decide.
    """
    _require()
    lang = lang or best_lang()
    td = tessdata_dir()
    # full=True -> OCR de toda la página (no solo de las imágenes incrustadas),
    # que es lo correcto en un escaneo, donde la página entera es una imagen.
    tp = page.get_textpage_ocr(flags=0, language=lang, dpi=OCR_DPI,
                               full=True, tessdata=td)
    return page.get_text(textpage=tp).strip()


def page_needs_ocr(page, min_chars=12):
    """True si la página parece escaneada (sin texto digital aprovechable)."""
    return len(page.get_text().strip()) < min_chars


def ocr_pdf_page(page, lang=None):
    """Devuelve los bytes de un PDF de UNA página con capa de texto invisible.

    Es lo que permite que un escaneo pase a ser buscable/seleccionable: la
    imagen se conserva igual y por debajo se añade el texto reconocido.
    """
    _require()
    lang = lang or best_lang()
    td = tessdata_dir()
    pix = page.get_pixmap(matrix=fitz.Matrix(_SCALE, _SCALE))
    return pix.pdfocr_tobytes(language=lang, tessdata=td)
