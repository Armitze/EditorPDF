"""Detección de tablas en páginas escaneadas (a partir de la imagen).

`find_tables` de PyMuPDF solo ve líneas VECTORIALES, así que en un escaneo
(donde la tabla son píxeles) no encuentra nada aunque el OCR ya haya dejado la
capa de texto. Aquí se detectan las líneas de la tabla en la propia imagen:

1. Se rasteriza la página y se binariza (píxeles oscuros).
2. Se localizan los segmentos de línea horizontales y verticales (ventanas de
   píxeles oscuros casi continuas, finas y largas).
3. Los segmentos que se cruzan se agrupan en componentes (cada componente es
   una tabla o un grupo de cajas contiguas).
4. Cada componente se divide en bandas por sus líneas horizontales; en cada
   banda, las columnas son las líneas verticales que la atraviesan y las filas
   se deducen agrupando las palabras del OCR por su altura.
5. Cada palabra (atómica, con su recuadro del OCR) cae en la celda que
   contiene su centro: los importes nunca se parten por la mitad.

Solo depende de numpy además de PyMuPDF; no hace falta OpenCV.
"""
import bisect

import fitz
import numpy as np

# Ancho de trabajo del análisis, en píxeles. La página se rasteriza a este
# ancho tenga el tamaño que tenga, así los umbrales en píxeles valen siempre.
# A este ancho los trazos de las letras quedan por debajo del mínimo de línea
# vertical; con más resolución se confunden con líneas de columna.
TARGET_W = 1600

DARK_H = 160        # umbral de gris para líneas horizontales (ruido-sensibles)
DARK_V = 190        # umbral para verticales: las líneas de columna suelen ser
                    # las más tenues del escaneo y hay que apurar más
GAP_FRAC = 0.85     # fracción de la ventana que debe ser oscura (tolera poros)
MAX_THICK = 8       # grosor máximo (px) de una línea (más grueso = dibujo/foto)
MIN_H_LEN = 110     # longitud mínima (px) de una línea horizontal
MIN_V_LEN = 32      # longitud mínima (px) de una línea vertical: más que la
                    # altura de una letra, menos que una celda de tabla
JOIN_TOL = 8        # distancia (px) para considerar que dos líneas se tocan
CLUSTER_TOL = 6     # distancia (px) para fundir líneas casi coincidentes
MIN_COL_W = 16      # ancho mínimo (px) de una columna (evita astillas)


def _segments(dark, min_len, axis):
    """Segmentos de línea: [(centro_perpendicular, a0, a1)] en píxeles.

    `axis=1` busca horizontales; `axis=0`, verticales (se analiza la matriz
    traspuesta). Un segmento es una banda fina de ventanas de `min_len`
    píxeles casi todas oscuras; las bandas contiguas se funden en una.
    """
    if axis == 0:
        dark = dark.T
    n_rows = dark.shape[0]
    c = np.zeros((n_rows, dark.shape[1] + 1), dtype=np.int32)
    np.cumsum(dark, axis=1, out=c[:, 1:])
    win = c[:, min_len:] - c[:, :-min_len]
    hit = win >= int(min_len * GAP_FRAC)
    linepix = np.zeros_like(dark, dtype=bool)
    for r, x in zip(*np.nonzero(hit)):
        linepix[r, x:x + min_len] = True

    segs, open_segs = [], []   # abiertos: [r0, x0, x1, r1]
    for r in range(n_rows):
        xs = np.nonzero(linepix[r])[0]
        if xs.size:
            cuts = np.nonzero(np.diff(xs) > 1)[0]
            starts = np.concatenate(([0], cuts + 1))
            ends = np.concatenate((cuts, [xs.size - 1]))
            runs = [(int(xs[s]), int(xs[e])) for s, e in zip(starts, ends)]
        else:
            runs = []
        keep = []
        for x0, x1 in runs:
            for seg in open_segs:
                if x0 <= seg[2] and x1 >= seg[1]:      # se solapan en x
                    seg[1], seg[2], seg[3] = min(seg[1], x0), max(seg[2], x1), r
                    keep.append(seg)
                    break
            else:
                keep.append([r, x0, x1, r])
        segs.extend(s for s in open_segs if s not in keep)
        open_segs = keep
    segs.extend(open_segs)
    return [((s[0] + s[3]) / 2, s[1], s[2]) for s in segs
            if s[3] - s[0] + 1 <= MAX_THICK and s[2] - s[1] >= min_len]


def _merge_parallel(segs):
    """Funde segmentos casi colineales y solapados (líneas dobles del escaneo)."""
    segs = sorted(segs)
    out = []
    for p, a0, a1 in segs:
        for seg in out:
            if abs(seg[0] - p) <= CLUSTER_TOL and a0 <= seg[2] + JOIN_TOL and a1 >= seg[1] - JOIN_TOL:
                seg[1], seg[2] = min(seg[1], a0), max(seg[2], a1)
                break
        else:
            out.append([p, a0, a1])
    return [tuple(s) for s in out]


def _components(hsegs, vsegs):
    """Agrupa líneas que se tocan. Devuelve [(h_del_grupo, v_del_grupo)]."""
    n = len(hsegs) + len(vsegs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        parent[find(i)] = find(j)

    for i, (y, x0, x1) in enumerate(hsegs):
        for j, (x, y0, y1) in enumerate(vsegs):
            if (x0 - JOIN_TOL <= x <= x1 + JOIN_TOL
                    and y0 - JOIN_TOL <= y <= y1 + JOIN_TOL):
                union(i, len(hsegs) + j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), ([], []))
    for i, seg in enumerate(hsegs):
        groups[find(i)][0].append(seg)
    for j, seg in enumerate(vsegs):
        groups[find(len(hsegs) + j)][1].append(seg)
    return [g for g in groups.values() if g[0] or g[1]]


def _cluster(values, tol):
    """Agrupa valores cercanos y devuelve el promedio de cada grupo."""
    out = []
    for v in sorted(values):
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(g) / len(g) for g in out]


def _merge_boxes(comps):
    """Funde componentes cuyos rectángulos se solapan.

    Un borde tenue o roto en el escaneo parte una misma tabla en varios grupos
    de líneas; si sus cajas se tocan, son la misma tabla.
    """
    def bbox(hs, vs):
        return (min([s[1] for s in hs] + [s[0] for s in vs]) - JOIN_TOL,
                min([s[0] for s in hs] + [s[1] for s in vs]) - JOIN_TOL,
                max([s[2] for s in hs] + [s[0] for s in vs]) + JOIN_TOL,
                max([s[0] for s in hs] + [s[2] for s in vs]) + JOIN_TOL)

    comps = [[list(hs), list(vs), None] for hs, vs in comps]
    for c in comps:
        c[2] = bbox(c[0], c[1])
    merged = True
    while merged:
        merged = False
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                a, b = comps[i][2], comps[j][2]
                if a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]:
                    comps[i][0].extend(comps[j][0])
                    comps[i][1].extend(comps[j][1])
                    comps[i][2] = bbox(comps[i][0], comps[i][1])
                    del comps[j]
                    merged = True
                    break
            if merged:
                break
    return [(c[0], c[1]) for c in comps]


def _rows_from_words(words, y0, y1):
    """Cortes de fila dentro de una banda, agrupando palabras por su altura."""
    heights = sorted(w[3] - w[1] for w in words)
    if not heights:
        return []
    med = heights[len(heights) // 2]
    # El OCR lee los bordes verticales de la tabla como '|' altísimos que
    # puentean varias filas: no cuentan para decidir dónde empieza cada una.
    ys = sorted(w[3] for w in words if w[3] - w[1] <= med * 2)
    if not ys:
        return []
    gap = max(5.0, med * 0.5)
    cuts, prev = [], ys[0]
    for y in ys[1:]:
        if y - prev > gap:
            cuts.append((y + prev) / 2 - heights[len(heights) // 2] / 2)
        prev = y
    return cuts


def page_tables(page):
    """Tablas de una página escaneada: [{'rows', 'cols', 'nrows'}].

    Necesita que la página tenga capa de texto (OCR aplicado): las líneas se
    ven en la imagen, pero el contenido de las celdas sale del texto.
    """
    rect = page.rect
    if rect.width <= 0 or not page.get_text().strip():
        return []
    zoom = TARGET_W / rect.width
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)

    hsegs = _merge_parallel(_segments(img < DARK_H, MIN_H_LEN, axis=1))
    vsegs = _segments(img < DARK_V, MIN_V_LEN, axis=0)
    # Segunda pasada de verticales a más resolución: las líneas de columna de
    # 1 px de un escaneo se difuminan al reescalar y solo aparecen aquí. El
    # mínimo sube en proporción para que los trazos de letras no cuenten.
    hi = 1.5
    pix2 = page.get_pixmap(matrix=fitz.Matrix(zoom * hi, zoom * hi),
                           colorspace=fitz.csGRAY)
    img2 = np.frombuffer(pix2.samples, dtype=np.uint8).reshape(pix2.height,
                                                               pix2.width)
    vsegs += [(x / hi, y0 / hi, y1 / hi)
              for x, y0, y1 in _segments(img2 < DARK_V,
                                         int(MIN_V_LEN * hi), axis=0)]
    vsegs = _merge_parallel(vsegs)
    if not hsegs and not vsegs:
        return []

    # Palabras del OCR en píxeles de la imagen analizada.
    words = [(w[0] * zoom, w[1] * zoom, w[2] * zoom, w[3] * zoom, w[4])
             for w in page.get_text('words')]
    word_h = sorted(w[3] - w[1] for w in words) if words else [12]
    med_h = word_h[len(word_h) // 2]

    # Un grupo de verticales sin ninguna horizontal no es una tabla: es un
    # código de barras, un logotipo o ruido del escaneo.
    comps = [c for c in _components(hsegs, vsegs) if c[0]]
    out = []
    for hs, vs in _merge_boxes(comps):
        if len(hs) + len(vs) < 3:      # un par de rayas sueltas no es una tabla
            continue
        x0 = min([s[1] for s in hs] + [s[0] for s in vs])
        x1 = max([s[2] for s in hs] + [s[0] for s in vs])
        y0 = min([s[0] for s in hs] + [s[1] for s in vs])
        y1 = max([s[0] for s in hs] + [s[2] for s in vs])
        inside = [w for w in words
                  if x0 - JOIN_TOL <= (w[0] + w[2]) / 2 <= x1 + JOIN_TOL
                  and y0 - JOIN_TOL <= (w[1] + w[3]) / 2 <= y1 + JOIN_TOL]
        if not inside:
            continue

        # Bandas horizontales del componente, cortadas solo por líneas que lo
        # crucen de verdad: una raya corta es el borde de una caja interior,
        # no una división de toda la tabla.
        wide = [s[0] for s in hs if s[2] - s[1] >= (x1 - x0) * 0.35]
        band_cuts = _cluster(wide + [y0, y1], CLUSTER_TOL)
        rows = []
        for b0, b1 in zip(band_cuts, band_cuts[1:]):
            if b1 - b0 < med_h * 0.5:
                continue
            band_words = [w for w in inside if b0 <= (w[1] + w[3]) / 2 < b1]
            if not band_words:
                continue
            # Columnas: posiciones x cuyas líneas verticales (aunque estén
            # rotas en trozos) cubren la mayor parte de la altura de la banda.
            in_band = [s for s in vs if s[2] > b0 and s[1] < b1]
            bounds = []
            for x in _cluster([s[0] for s in in_band], CLUSTER_TOL):
                cov = sum(min(s[2], b1) - max(s[1], b0) for s in in_band
                          if abs(s[0] - x) <= CLUSTER_TOL * 1.5)
                if cov >= (b1 - b0) * 0.55:
                    bounds.append(x)
            bounds = _cluster(bounds + [x0, x1], CLUSTER_TOL)
            bounds = [b for k, b in enumerate(bounds)
                      if k == 0 or b - bounds[k - 1] >= MIN_COL_W]
            # Filas dentro de la banda por la altura de las palabras.
            row_cuts = _rows_from_words(band_words, b0, b1)
            edges = [b0] + row_cuts + [b1]
            grid = [[[] for _ in range(max(1, len(bounds) - 1))]
                    for _ in range(len(edges) - 1)]
            for w in band_words:
                cy = (w[1] + w[3]) / 2
                cx = (w[0] + w[2]) / 2
                r = min(len(grid) - 1,
                        max(0, bisect.bisect_right(edges, cy) - 1))
                c = min(len(grid[0]) - 1,
                        max(0, bisect.bisect_right(bounds, cx) - 1))
                grid[r][c].append(w)
            for r in grid:
                # Los '|' son los bordes de la tabla leídos como texto por el
                # OCR: fuera de las celdas.
                cells = [' '.join(w[4] for w in sorted(ws, key=lambda w: (round(w[1]), w[0])))
                         .replace('|', ' ') for ws in r]
                cells = [' '.join(c.split()) for c in cells]
                if any(cells):
                    rows.append(cells)
        if not rows:
            continue
        ncols = max(len(r) for r in rows)
        if ncols < 2 and len(rows) < 3:
            continue
        rows = [r + [''] * (ncols - len(r)) for r in rows]
        out.append({'rows': rows, 'cols': ncols, 'nrows': len(rows), '_y': y0})
    out.sort(key=lambda t: t.pop('_y'))
    return out
