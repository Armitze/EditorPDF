"""Elige la fuente con la que reescribir un texto editado del documento.

El objetivo es que el texto nuevo se vea EXACTAMENTE con la misma fuente que
el original. Orden de preferencia:

1. La fuente incrustada en el propio PDF (extraída del documento), siempre que
   contenga todos los glifos del texto nuevo. Los PDFs suelen llevar solo un
   subconjunto de la fuente (los caracteres que se usaron), así que una letra
   nueva puede no existir en él; en ese caso se pasa al siguiente paso.
2. Nombres estándar (Helvetica, Times, Courier, Symbol, ZapfDingbats): la
   base-14 equivalente de PyMuPDF, que es la misma con la que se renderiza el
   original cuando no va incrustado.
3. La fuente instalada en Windows con el mismo nombre (p. ej. «Calibri-Bold»
   → calibrib.ttf).
4. Una fuente instalada de la misma familia y estilo (negrita / cursiva).
5. Una base-14 sustituta según serif / monoespaciada / negrita / cursiva.

`resolve()` devuelve un dict con lo necesario para `Page.insert_font` /
`Page.insert_text` y una etiqueta legible para que la interfaz diga qué fuente
se ha usado y con qué grado de fidelidad («exact», «system», «family» o
«substitute»).
"""
import hashlib
import os
import re
import threading

import fitz

# Tokens de estilo que se separan del nombre de familia.
_BOLD_WORDS = {'bold', 'black', 'heavy', 'semibold', 'demibold', 'extrabold',
               'ultrabold', 'demi'}
_ITALIC_WORDS = {'italic', 'oblique'}
_OTHER_STYLE_WORDS = {'regular', 'light', 'extralight', 'ultralight', 'thin',
                      'medium', 'normal'}
_NOISE_WORDS = {'mt', 'psmt', 'ps', 'std'}

# Nombres estándar del PDF → alias base-14 de PyMuPDF (misma fuente que usa
# MuPDF para dibujar el original cuando no está incrustado).
_BASE14 = {
    'helvetica': 'helv', 'helveticabold': 'hebo',
    'helveticaoblique': 'heit', 'helveticaitalic': 'heit',
    'helveticaboldoblique': 'hebi', 'helveticabolditalic': 'hebi',
    'courier': 'cour', 'courierbold': 'cobo',
    'courieroblique': 'coit', 'courieritalic': 'coit',
    'courierboldoblique': 'cobi', 'courierbolditalic': 'cobi',
    'timesroman': 'tiro', 'times': 'tiro', 'timesbold': 'tibo',
    'timesitalic': 'tiit', 'timesbolditalic': 'tibi',
    'symbol': 'symb', 'zapfdingbats': 'zadb',
}
_BASE14_LABEL = {
    'helv': 'Helvetica', 'hebo': 'Helvetica Bold', 'heit': 'Helvetica Oblique',
    'hebi': 'Helvetica Bold Oblique', 'cour': 'Courier', 'cobo': 'Courier Bold',
    'coit': 'Courier Oblique', 'cobi': 'Courier Bold Oblique',
    'tiro': 'Times Roman', 'tibo': 'Times Bold', 'tiit': 'Times Italic',
    'tibi': 'Times Bold Italic', 'symb': 'Symbol', 'zadb': 'ZapfDingbats',
}

_FONT_EXTS = ('.ttf', '.otf', '.ttc')

_index = None            # lista de fuentes del sistema (ver _system_fonts)
_index_lock = threading.Lock()


def _tokens(name):
    """Divide un nombre de fuente en palabras en minúscula.

    Quita el prefijo de subconjunto («ABCDEF+»), separa camelCase y corta por
    espacios, guiones, comas, puntos y guiones bajos.
    """
    n = (name or '').split('+')[-1]
    n = re.sub(r'([a-z])([A-Z])', r'\1 \2', n)
    return [t for t in re.split(r'[\s\-,_.]+', n.lower()) if t]


def describe(name, bold=False, italic=False):
    """(clave_completa, familia, negrita, cursiva) normalizados de un nombre.

    `bold` / `italic` permiten aportar los flags del texto (algunos PDFs no
    llevan el estilo en el nombre de la fuente).
    """
    toks = [t for t in _tokens(name) if t not in _NOISE_WORDS]
    is_bold = bold or any(t in _BOLD_WORDS for t in toks)
    is_italic = italic or any(t in _ITALIC_WORDS for t in toks)
    full = ''.join(t for t in toks if t != 'regular')
    family = ''.join(t for t in toks
                     if t not in _BOLD_WORDS and t not in _ITALIC_WORDS
                     and t not in _OTHER_STYLE_WORDS)
    return full, family, is_bold, is_italic


def display_name(name):
    """Nombre legible de la fuente tal como aparece en el PDF («Calibri-Bold»)."""
    return (name or '').split('+')[-1] or 'desconocida'


# ---------- fuentes instaladas ----------
def _font_dirs():
    dirs = [os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')]
    local = os.environ.get('LOCALAPPDATA')
    if local:
        dirs.append(os.path.join(local, 'Microsoft', 'Windows', 'Fonts'))
    return [d for d in dirs if os.path.isdir(d)]


def _scan_system_fonts():
    fonts = []
    seen = set()
    for d in _font_dirs():
        try:
            names = sorted(os.listdir(d))
        except OSError:
            continue
        for fn in names:
            if not fn.lower().endswith(_FONT_EXTS):
                continue
            path = os.path.join(d, fn)
            try:
                f = fitz.Font(fontfile=path)
                name = f.name or ''
                full, family, bold, italic = describe(name, f.is_bold, f.is_italic)
                if not full or full in seen:
                    continue
                seen.add(full)
                fonts.append({
                    'path': path, 'name': name, 'full': full, 'family': family,
                    'bold': bool(bold), 'italic': bool(italic),
                    'serif': bool(f.is_serif), 'mono': bool(f.is_monospaced),
                })
            except Exception:
                continue
    return fonts


def _system_fonts():
    global _index
    with _index_lock:
        if _index is None:
            _index = _scan_system_fonts()
        return _index


def warm_up():
    """Indexa las fuentes del sistema en segundo plano (tarda ~1 s la 1ª vez)."""
    if _index is not None:
        return
    threading.Thread(target=_system_fonts, daemon=True).start()


def _find_system(name, bold, italic):
    """Fuente instalada con el mismo nombre; si no, misma familia y estilo."""
    full, family, want_bold, want_italic = describe(name, bold, italic)
    fonts = _system_fonts()
    if not full:
        return None, None
    for f in fonts:
        if f['full'] == full:
            return f, 'system'
    # Con los flags del texto (p. ej. «Arial» con flag negrita) el nombre
    # completo puede no coincidir pero la familia+estilo sí.
    same = [f for f in fonts if f['family'] == family]
    if not same:
        return None, None
    for f in same:
        if f['bold'] == want_bold and f['italic'] == want_italic:
            return f, 'family'
    for f in same:
        if not f['bold'] and not f['italic']:
            return f, 'family'
    return same[0], 'family'


# ---------- fuente incrustada ----------
def _page_font_candidates(page, name, bold=False, italic=False):
    """Fuentes de la página que corresponden al nombre `name` del texto.

    La extracción de texto da el nombre «de la fuente cargada» («Calibri»,
    «Calibri-Bold») y el recurso del PDF su BaseFont («ABCDEF+Calibri Bold»,
    «Calibri Regular»…): no coinciden letra a letra, así que se comparan las
    claves normalizadas (nombre completo primero; familia+estilo después).
    Devuelve [(xref, ext, tipo, basefont)] ordenadas de mejor a peor.
    """
    full, family, want_bold, want_italic = describe(name, bold, italic)
    exact, similar = [], []
    for xref, ext, ftype, basefont, *_ in page.get_fonts(full=True):
        f_full, f_family, f_bold, f_italic = describe(basefont)
        if f_full == full:
            exact.append((xref, ext, ftype, basefont))
        elif f_family == family and f_bold == want_bold and f_italic == want_italic:
            similar.append((xref, ext, ftype, basefont))
    return exact + similar


def is_embedded(page, name, bold=False, italic=False):
    """True si la fuente `name` del texto va incrustada en la página."""
    return any(ext != 'n/a' and ftype != 'Type3'
               for _x, ext, ftype, _b in _page_font_candidates(page, name, bold, italic))


def _embedded_fonts(doc, page, name, bold=False, italic=False):
    """[(xref, buffer)] de las fuentes incrustadas que corresponden a `name`."""
    out = []
    for xref, ext, ftype, _basefont in _page_font_candidates(page, name, bold, italic):
        if ext == 'n/a' or ftype == 'Type3':
            continue
        try:
            _bn, _ext, _t, buf = doc.extract_font(xref)
        except Exception:
            continue
        if buf:
            out.append((xref, buf))
    return out


def _covers(font, text):
    """True si la fuente tiene glifo para TODOS los caracteres del texto."""
    for ch in set(text):
        if ch in '\r\n\t':
            continue
        try:
            if not font.has_glyph(ord(ch)):
                return False
        except Exception:
            return False
    return True


def _base14_by_flags(bold, italic, serif, mono):
    if mono:
        base = 'co'
    elif serif:
        base = 'ti'
    else:
        base = 'he'
    if base == 'ti':
        style = 'bi' if bold and italic else 'bo' if bold else 'it' if italic else 'ro'
    else:
        style = 'bi' if bold and italic else 'bo' if bold else 'it' if italic else 'ur' if base == 'co' else 'lv'
    return base + style


def _alias(kind, key):
    """Nombre de recurso único por fuente (evita mezclar dos fuentes con el
    mismo alias en una página; PyMuPDF reutiliza el alias si ya existe)."""
    h = hashlib.sha1(str(key).encode('utf-8', 'replace')).hexdigest()[:8]
    return f'Ed{kind}{h}'


def resolve(doc, page, span, text):
    """Fuente con la que escribir `text` en lugar del `span` original.

    `span` es un span de `page.get_text('dict')` (claves font, flags, size…).
    Devuelve dict: {alias, fontfile, fontbuffer, kind, label, font}.
    `font` es un fitz.Font para medir anchos; `kind` es 'exact', 'base14',
    'system', 'family' o 'substitute'.
    """
    name = span.get('font') or ''
    flags = int(span.get('flags') or 0)
    f_italic = bool(flags & 2)
    f_serif = bool(flags & 4)
    f_mono = bool(flags & 8)
    f_bold = bool(flags & 16)

    # 1. Fuente incrustada con todos los glifos.
    for xref, buf in _embedded_fonts(doc, page, name, f_bold, f_italic):
        try:
            font = fitz.Font(fontbuffer=buf)
        except Exception:
            continue
        if _covers(font, text):
            return {'alias': _alias('X', xref), 'fontfile': None,
                    'fontbuffer': buf, 'kind': 'exact',
                    'label': display_name(name), 'font': font}

    full, family, bold, italic = describe(name, f_bold, f_italic)

    # 2. Nombres estándar → base-14 (idéntica a la que dibuja el original).
    b14 = _BASE14.get(full)
    if b14:
        font = fitz.Font(b14)
        if _covers(font, text):
            return {'alias': b14, 'fontfile': None, 'fontbuffer': None,
                    'kind': 'base14', 'label': _BASE14_LABEL[b14], 'font': font}

    # 3 / 4. Fuente instalada (mismo nombre o misma familia y estilo).
    sysf, how = _find_system(name, f_bold, f_italic)
    if sysf:
        try:
            font = fitz.Font(fontfile=sysf['path'])
            if _covers(font, text):
                return {'alias': _alias('S', sysf['path']), 'fontfile': sysf['path'],
                        'fontbuffer': None, 'kind': how, 'label': sysf['name'],
                        'font': font}
        except Exception:
            pass

    # 5. Sustituta base-14 por características.
    b14 = _base14_by_flags(bold, italic, f_serif, f_mono)
    return {'alias': b14, 'fontfile': None, 'fontbuffer': None,
            'kind': 'substitute', 'label': _BASE14_LABEL[b14],
            'font': fitz.Font(b14)}


KIND_TEXT = {
    'exact': 'misma fuente incrustada en el PDF',
    'base14': 'fuente estándar del PDF',
    'system': 'misma fuente, instalada en Windows',
    'family': 'fuente de la misma familia instalada en Windows',
    'substitute': 'fuente sustituta (la original no está disponible)',
}
