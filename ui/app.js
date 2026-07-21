'use strict';

/* ===== Estado ===== */
const state = {
  fileName: 'Factura_F-2026-0847.pdf',
  // --- Pestañas (multi-documento, estilo Adobe) ---
  // Cada pestaña: {id, doc, fileName, activePage, pageSize}. Con 0 pestañas se
  // muestra el modo demo. state.doc/fileName/activePage/pageSize son un ESPEJO
  // de la pestaña activa, sincronizado en activateTab() para no reescribir todo.
  tabs: [],
  activeTabId: null,
  doc: null,               // null (demo) | {name, path, count, dirty, rev, docId}
  pageSize: null,          // {width, height} en puntos, página activa del PDF real
  activePage: 1,
  rightTab: 'edicion',
  leftHidden: false,       // panel de páginas (izquierda) oculto
  rightHidden: false,      // panel de propiedades (derecha) oculto
  readingModeApplied: false, // el modo lectura se aplica solo en la 1ª apertura
  selected: null,          // demo: null | 'logo' | 'table' | 'invnum' | 'invdate' | 'client' | 'total'
  tool: 'select',          // select | highlight | textbox | line | arrow
  zoom: 100,
  // Búsqueda: `hits` son las coincidencias del backend (con página y recuadro en
  // puntos PDF) y `hit` es la que está seleccionada ahora mismo.
  searchQuery: '',
  searchHits: [],
  searchHit: 0,
  modal: null,             // null | 'ocr' | 'export'
  ctx: null,               // demo: null | 'logo' | 'client' | 'table'
  editedIds: [],
  movedLogo: false,
  tableDetected: false,
  extractedTable: null,    // filas reales extraídas del PDF
  ocrDone: false,
  ocrScope: 'doc',         // doc | pg | sel
  exportFmt: 'word',       // word | excel | html
  annotColor: '#f2d024',
  signImage: null,         // data URL del PNG de firma importado (modo firmar)
  pages: [
    { edited: true, annot: true },
    {},
    { ocr: true },
    { annot: true },
    {},
    { ocr: true, edited: true },
    {},
    { annot: true },
  ],
  vals: {
    invnum: 'F-2026-0847',
    invdate: '09/07/2026',
    client: 'Distribuidora Andina S.A.',
    total: '$56,724.00',
  },
};

const LABELS = {
  invnum: 'Número de factura',
  invdate: 'Fecha de emisión',
  client: 'Cliente (Facturar a)',
  total: 'Total a pagar',
};

const DEMO_TABLE = [
  ['Descripción', 'Cant.', 'Precio unit.', 'Importe'],
  ['Consultoría contable mensual', '1', '12,500.00', '12,500.00'],
  ['Auditoría de estados financieros', '1', '24,000.00', '24,000.00'],
  ['Declaración anual de ISR', '1', '6,000.00', '6,000.00'],
  ['Conciliación bancaria (12 meses)', '12', '533.33', '6,400.00'],
];

const PAGE_DISPLAY_WIDTH = 768;

// La factura de demostración solo se muestra con ?demo=1 (útil para enseñar la
// interfaz sin abrir un PDF). Por defecto, sin documento se ve la bienvenida.
const DEMO_MODE = new URLSearchParams(location.search).has('demo');

// Búsqueda: se declaran aquí arriba porque activateTab las usa y está definida
// antes que el resto del código de búsqueda.
let searchTimer = 0;
let searchSeq = 0;   // descarta respuestas de búsquedas ya obsoletas

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Endpoints de ciclo de vida que NO se refieren a una pestaña concreta.
const NO_DOC_ID = ['/api/open', '/api/docs', '/api/window'];

// Añade ?docId=<pestaña activa> a las URLs de /api/ que operan sobre un
// documento, para que cada petición vaya a la pestaña correcta. Así los
// callsites (api.get/api.post) no necesitan pasar el docId a mano.
function withDocId(url) {
  if (!url.startsWith('/api/')) return url;
  const path = url.split('?')[0];
  if (NO_DOC_ID.includes(path)) return url;
  if (state.activeTabId == null) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}docId=${encodeURIComponent(state.activeTabId)}`;
}

// Convierte una respuesta de error en Error. `detail` puede ser texto o un
// objeto (p. ej. el 401 de un PDF protegido, que trae {message, wrong, path}):
// en ese caso se conserva en err.detail y err.status para poder reaccionar.
async function apiError(r) {
  const body = await r.json().catch(() => ({}));
  const d = body.detail;
  const msg = (d && typeof d === 'object' ? d.message : d) || r.statusText;
  const err = new Error(msg);
  err.status = r.status;
  if (d && typeof d === 'object') err.detail = d;
  return err;
}

const api = {
  async get(url) {
    const r = await fetch(withDocId(url));
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(withDocId(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw await apiError(r);
    return r.json();
  },
};

// URL de imagen (miniaturas/página) para la pestaña activa. Los <img src> no
// pasan por `api`, así que aquí añadimos docId (y el rev lo pone el llamador).
function imgUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return state.activeTabId == null ? path : `${path}${sep}docId=${encodeURIComponent(state.activeTabId)}`;
}

const inDoc = () => !!state.doc;

// Densidad de píxeles para las miniaturas (nítidas también con escalado de
// Windows >100%). Redondeada para que la URL sea estable y cachee.
const thumbDpr = () => Math.min(3, Math.round((window.devicePixelRatio || 1) * 100) / 100);
// Sin documento no hay páginas: las 8 de `state.pages` son de la demostración y
// solo cuentan en modo demo. Antes se mostraban siempre («8 páginas», miniaturas
// falsas y «3 anotaciones» en la barra de estado) aunque no hubiera nada abierto.
const pageCount = () => (inDoc() ? state.doc.count : (DEMO_MODE ? state.pages.length : 0));

function setState(patch) {
  Object.assign(state, patch);
  render();
}

/* ===== Pestañas (multi-documento) ===== */
const activeTab = () => state.tabs.find(t => t.id === state.activeTabId) || null;

// Vuelca el sub-estado de la pestaña activa a los espejos globales que lee
// el resto del render (state.doc, fileName, activePage, pageSize).
function syncMirror() {
  const t = activeTab();
  if (t) {
    state.doc = t.doc;
    state.fileName = t.fileName;
    state.activePage = t.activePage;
    state.pageSize = t.pageSize;
    $('#export-range').value = `1-${t.doc.count}`;
  } else {
    // Sin pestañas: modo demo.
    state.doc = null;
    state.fileName = 'Documento.pdf';
    state.activePage = 1;
    state.pageSize = null;
  }
}

// Crea (o actualiza) una pestaña a partir de un info del backend y devuelve su id.
function upsertTab(info, { resetPage = false } = {}) {
  let t = state.tabs.find(x => x.id === info.docId);
  if (!t) {
    t = { id: info.docId, doc: info, fileName: info.name, activePage: 1,
          pageSize: null, pageSizes: null, sizesRev: null };
    state.tabs.push(t);
  } else {
    t.doc = info;
    t.fileName = info.name;
    if (resetPage) t.activePage = 1;
  }
  t.activePage = Math.min(Math.max(1, t.activePage), info.count);
  return t.id;
}

// Activa una pestaña: sincroniza espejos, carga tamaño de página y re-renderiza.
async function activateTab(id) {
  // Los resultados son de otro documento: limpiarlos evita arrastrar resaltados
  // y contadores que ya no corresponden. Se tocan los campos directamente (sin
  // setState) porque activateTab ya re-renderiza al final.
  if (id !== state.activeTabId) {
    const input = $('#search-input');
    if (input) input.value = '';
    clearTimeout(searchTimer);
    searchSeq++;
    Object.assign(state, { searchQuery: '', searchHits: [], searchHit: 0 });
  }
  state.activeTabId = id;
  state.selected = null;
  state.ctx = null;
  syncMirror();
  const t = activeTab();
  if (t) {
    await loadPageSizes(t);
    t.pageSize = (t.pageSizes && t.pageSizes[t.activePage - 1]) || null;
    state.pageSize = t.pageSize;
  }
  render();
}

// Tamaños de TODAS las páginas de la pestaña (una sola llamada por revisión).
// La vista continua los necesita para reservar el alto de cada hoja antes de
// que su imagen cargue (sin saltos de scroll) y para convertir coordenadas.
async function loadPageSizes(t) {
  if (t.sizesRev === t.doc.rev && t.pageSizes) return;
  try {
    const r = await api.get('/api/pagesizes');
    t.pageSizes = r.sizes || [];
    t.sizesRev = t.doc.rev;
  } catch {
    t.pageSizes = null;
    t.sizesRev = null;
  }
}

/* ===== Documento real ===== */
// Aplica un info a SU pestaña (por docId). Si es la pestaña activa, refresca la
// vista; si no existe la pestaña aún, la crea (apertura) y la activa.
async function applyDoc(info, { resetPage = false } = {}) {
  if (!info || !info.open) return;
  // Muchos endpoints (undo, save, annot, pages…) devuelven pdf.info() SIN docId,
  // porque operan sobre la pestaña activa. Si falta, asumimos la activa.
  if (info.docId == null) info.docId = state.activeTabId;
  const id = upsertTab(info, { resetPage });
  if (id === state.activeTabId || state.activeTabId == null) {
    await activateTab(id);
  } else {
    render();  // pestaña de fondo: basta con refrescar la tira de pestañas
  }
}

// Modo lectura al abrir un PDF nuevo: ventana maximizada, paneles ocultos y el
// documento ajustado al ancho para que se vea grande. Solo se aplica en la
// PRIMERA apertura de la sesión; después respetamos cómo dejó el usuario los
// paneles y el zoom.
async function enterReadingMode() {
  if (state.readingModeApplied) return;
  state.readingModeApplied = true;
  // Maximizar la ventana (solo en la app de escritorio).
  const bridge = window.pywebview && window.pywebview.api;
  if (bridge && bridge.maximize_window) {
    try { await bridge.maximize_window(); } catch {}
  }
  state.leftHidden = true;
  state.rightHidden = true;
  render();
  // Tras aplicar el layout (paneles ocultos), ajustar el zoom al ancho.
  requestAnimationFrame(() => {
    const z = fitZoomToWidth();
    if (z !== state.zoom) setState({ zoom: z }); else render();
  });
}

/* ===== PDF protegido con contraseña ===== */

// Pide la contraseña al usuario. Devuelve la cadena, o null si cancela.
// `wrong` = el intento anterior falló (se muestra el aviso en rojo).
function askPassword(fileName, wrong = false) {
  return new Promise(resolve => {
    const modal = $('#modal-password');
    const input = $('#pw-input');
    $('#pw-file').textContent = fileName || 'El documento';
    $('#pw-error').hidden = !wrong;
    modal.classList.toggle('modal-password-wrong', wrong);
    input.value = '';
    modal.classList.add('is-open');
    setTimeout(() => input.focus(), 30);

    const done = value => {
      modal.classList.remove('is-open', 'modal-password-wrong');
      input.value = '';            // no dejar la clave en el DOM
      $('#pw-accept').removeEventListener('click', onOk);
      $('#pw-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => done(input.value || '');
    const onCancel = () => done(null);
    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    $('#pw-accept').addEventListener('click', onOk);
    $('#pw-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// Abre `path` pidiendo la contraseña las veces que haga falta. Devuelve la info
// del documento abierto, o null si el usuario cancela.
async function openWithPassword(path, fileName) {
  let password = null;
  let wrong = false;
  for (;;) {
    try {
      const r = await api.post('/api/open', { path, password });
      return (r.docs && r.docs[0]) || r.doc || null;
    } catch (e) {
      if (e.status !== 401) throw e;
      const name = (e.detail && e.detail.name) || fileName;
      password = await askPassword(name, wrong);
      if (password === null) return null;   // canceló
      wrong = true;   // a partir de aquí, un 401 significa clave incorrecta
    }
  }
}

async function openPdf() {
  try {
    const r = await api.post('/api/open', {});
    if (r.cancelled) {
      if (!window.pywebview) toast('El diálogo de apertura requiere la app de escritorio');
      return;
    }
    // El backend puede devolver varias pestañas (selección múltiple).
    const opened = r.docs || [r.doc || r];
    for (const info of opened) upsertTab(info, { resetPage: true });
    await activateTab(opened[0].docId);   // activa la primera abierta
    await enterReadingMode();
    if (opened.length === 1) {
      toast(`«${opened[0].name}» abierto · ${opened[0].count} páginas`);
    } else {
      toast(`${opened.length} documentos abiertos en pestañas`);
    }
  } catch (e) {
    // 401 = el PDF elegido tiene contraseña: pedirla y reintentar.
    if (e.status === 401 && e.detail && e.detail.path) {
      const info = await openWithPassword(e.detail.path, e.detail.name);
      if (!info) return;                   // canceló
      upsertTab(info, { resetPage: true });
      await activateTab(info.docId);
      await enterReadingMode();
      toast(`«${info.name}» abierto · ${info.count} páginas`);
      return;
    }
    toast('No se pudo abrir el PDF: ' + e.message);
  }
}

async function saveDoc(saveAs) {
  if (!inDoc()) { toast('Abre un PDF para guardar'); return false; }
  try {
    const r = await api.post('/api/save', { saveAs: !!saveAs });
    if (r.cancelled) return false;
    await applyDoc(r);
    toast('Documento guardado');
    return true;
  } catch (e) {
    toast('Error al guardar: ' + e.message);
    return false;
  }
}

// Cierra una pestaña concreta. Si tiene cambios, pide confirmación primero.
async function closeTab(id) {
  const t = state.tabs.find(x => x.id === id);
  if (!t) return;
  if (t.doc && t.doc.dirty) {
    pendingClose = { kind: 'tab', id };
    $('#confirm-file').textContent = t.fileName;
    $('#modal-close-confirm').classList.add('is-open');
    return;
  }
  await discardAndCloseTab(id);
}

// Cierra la pestaña en el backend y en la UI, activando una vecina.
async function discardAndCloseTab(id) {
  const idx = state.tabs.findIndex(x => x.id === id);
  if (idx < 0) return;
  try { await api.post(`/api/close?docId=${encodeURIComponent(id)}`, {}); } catch {}
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    await activateTab(next ? next.id : null);
  } else {
    render();
  }
}

// Estado del diálogo de cierre: qué se está cerrando (una pestaña o la ventana).
let pendingClose = null;

// Cierre de la VENTANA: si alguna pestaña tiene cambios, pide confirmación.
function requestClose() {
  const dirty = state.tabs.filter(t => t.doc && t.doc.dirty);
  if (dirty.length) {
    pendingClose = { kind: 'window' };
    const names = dirty.map(t => t.fileName).join(', ');
    $('#confirm-file').textContent = names;
    $('#modal-close-confirm').classList.add('is-open');
  } else {
    api.post('/api/window', { action: 'close' }).catch(() => {});
  }
}

function changePage(n) {
  const t = activeTab();
  n = Math.max(1, Math.min(Math.max(1, pageCount()), n));
  state.selected = null;
  state.ctx = null;
  if (inDoc()) {
    // Vista continua: «ir a la página n» es desplazarse hasta su hoja.
    setActivePage(n);
    scrollToPage(n);
    return;
  }
  state.activePage = n;
  if (t) t.activePage = n;
  render();
}

const getPageEl = i => $(`#real-doc .pdf-page[data-page="${i}"]`);

// Actualiza la página activa SIN re-render completo: se llama en cada scroll,
// así que solo toca los indicadores (barra de estado, miniatura activa…).
function setActivePage(n) {
  const t = activeTab();
  state.activePage = n;
  if (t) {
    t.activePage = n;
    t.pageSize = (t.pageSizes && t.pageSizes[n - 1]) || t.pageSize;
    state.pageSize = t.pageSize;
  }
  $('#status-page').textContent = n;
  $$('.modal-active-page').forEach(el => { el.textContent = n; });
  $$('#page-list .page-item').forEach(el => {
    const active = Number(el.dataset.page) === n;
    el.classList.toggle('is-active', active);
    if (active) el.scrollIntoView({ block: 'nearest' });
  });
}

// Desplaza el lienzo hasta el principio de la página `n` (1-based).
function scrollToPage(n, smooth = false) {
  const el = getPageEl(n - 1);
  const sc = $('#canvas-scroll');
  if (!el || !sc) return;
  const top = sc.scrollTop + el.getBoundingClientRect().top
    - sc.getBoundingClientRect().top - 14;
  sc.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// Al desplazarse, la página activa pasa a ser la más centrada en el viewport.
let scrollRaf = 0;
function onCanvasScroll() {
  if (!inDoc() || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (!inDoc()) return;
    const sc = $('#canvas-scroll');
    const midY = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let best = 0;
    let bestDist = Infinity;
    for (const el of $$('#real-doc .pdf-page')) {
      const r = el.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - midY);
      if (d < bestDist) { bestDist = d; best = Number(el.dataset.page) + 1; }
    }
    if (best && best !== state.activePage) setActivePage(best);
  });
}

/* ===== Render ===== */
function render() {
  renderTitlebar();
  renderTabs();
  renderPanels();
  renderPages();
  // renderZoom antes que renderDoc: fija el ancho real de la página, y renderDoc
  // lo necesita para pedir el PNG a la escala exacta de pantalla.
  renderZoom();
  renderDoc();
  renderContextMenus();
  renderTools();
  renderSearch();
  renderRightPanel();
  renderModals();
  renderStatusbar();
  renderUndo();
}

function renderTitlebar() {
  // El nombre del documento vive ahora en la pestaña activa; en la barra de
  // título mostramos el de la pestaña activa (o el de bienvenida en modo demo).
  $('#file-name').textContent = state.tabs.length ? state.fileName : 'Sin documento';
}

// Dibuja la tira de pestañas (una por documento) + botón «nueva».
function renderTabs() {
  const strip = $('#tab-list');
  if (!strip) return;
  strip.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeTabId ? ' is-active' : '');
    el.dataset.tab = t.id;
    el.title = t.fileName;
    const dot = (t.doc && t.doc.dirty) ? '<span class="tab-dirty" title="Cambios sin guardar"></span>' : '';
    el.innerHTML =
      `${dot}<span class="tab-name">${escapeHtml(t.fileName)}</span>` +
      `<span class="tab-close" title="Cerrar pestaña">✕</span>`;
    el.addEventListener('click', ev => {
      if (ev.target.classList.contains('tab-close')) { ev.stopPropagation(); closeTab(t.id); return; }
      if (t.id !== state.activeTabId) activateTab(t.id);
    });
    strip.appendChild(el);
  }
  // La tira se oculta si no hay pestañas (modo demo/bienvenida).
  const wrap = $('#tabstrip');
  if (wrap) wrap.classList.toggle('is-hidden', state.tabs.length === 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPages() {
  const list = $('#page-list');
  list.innerHTML = '';
  const total = pageCount();
  for (let i = 0; i < total; i++) {
    const n = i + 1;
    const item = document.createElement('div');
    item.className = 'page-item' + (n === state.activePage ? ' is-active' : '');
    item.dataset.page = n;
    let inner;
    if (inDoc()) {
      inner =
        `<div class="page-thumb-wrap">` +
          `<img class="page-thumb-img" loading="lazy" src="${imgUrl(`/api/thumb/${i}?r=${state.doc.rev}&dpr=${thumbDpr()}`)}" alt="Página ${n}">` +
          `<span class="page-active-ring"></span>` +
        `</div>`;
    } else {
      const p = state.pages[i];
      inner =
        `<div class="page-thumb-wrap">` +
          `<div class="page-thumb">` +
            `<div class="sk-title"></div>` +
            `<div class="sk-line w88"></div><div class="sk-line w80"></div><div class="sk-line w90"></div>` +
            `<div class="sk-block"></div>` +
            `<div class="sk-line w70"></div><div class="sk-line w60"></div>` +
          `</div>` +
          `<div class="page-flags">` +
            (p.edited ? `<span class="page-flag f-edited" title="Editada"></span>` : '') +
            (p.ocr ? `<span class="page-flag f-ocr" title="OCR aplicado"></span>` : '') +
            (p.annot ? `<span class="page-flag f-annot" title="Con anotaciones"></span>` : '') +
          `</div>` +
          `<span class="page-active-ring"></span>` +
        `</div>`;
    }
    item.innerHTML = `<span class="page-num">${n}</span>` + inner;
    item.addEventListener('click', () => changePage(n));
    list.appendChild(item);
  }
  $('#page-count').textContent = `${total} página${total === 1 ? '' : 's'}`;
  $('#status-page-total').textContent = total;
  $$('.modal-page-total').forEach(el => { el.textContent = total; });
}

let builtDocKey = '';       // «pestaña|rev» construida ahora mismo en #real-doc
let pageQualityTimer = 0;
let pageObserver = null;

// Observa qué hojas están cerca del viewport para cargar su imagen y su capa
// de texto bajo demanda (con margen: precarga ~1 pantalla por delante).
function ensureObserver() {
  if (!pageObserver) {
    pageObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        en.target._visible = en.isIntersecting;
        if (en.isIntersecting) ensurePage(en.target);
      }
    }, { root: $('#canvas-scroll'), rootMargin: '900px 0px' });
  }
  return pageObserver;
}

// Ancho de página en píxeles FÍSICOS de esta pantalla para el zoom actual.
// devicePixelRatio refleja el escalado de Windows (100% = 1, 125% = 1.25…),
// así que la resolución pedida se ajusta sola a cada pantalla.
function targetPixelWidth() {
  return Math.max(1, Math.round(
    PAGE_DISPLAY_WIDTH * (state.zoom / 100) * (window.devicePixelRatio || 1)));
}

// Escala de render para que el PNG de la página `i` salga con LOS MISMOS
// píxeles que ocupa en pantalla: sin remuestreo, texto como en Adobe.
// Redondeada a 4 decimales para que la URL sea estable y el navegador cachee.
function targetScaleFor(i) {
  const t = activeTab();
  const sz = t && t.pageSizes && t.pageSizes[i];
  const ptW = (sz && sz.width) || PAGE_DISPLAY_WIDTH;
  return Math.max(0.2, Math.min(6, Math.round((targetPixelWidth() / ptW) * 10000) / 10000));
}

// Pone al día una hoja: imagen a la escala actual y capa de texto de su
// revisión. Solo toca la red cuando la clave (pestaña|rev|escala) cambió.
function ensurePage(el) {
  const t = activeTab();
  if (!inDoc() || !t || !t.pageSizes) return;
  const i = Number(el.dataset.page);
  const rev = state.doc.rev;
  const img = el.querySelector('.pp-img');
  const scale = targetScaleFor(i);
  const wanted = `${state.activeTabId}|${rev}|${scale}`;
  if (img.dataset.key !== wanted) {
    img.dataset.key = wanted;
    img.src = imgUrl(`/api/page/${i}?r=${rev}&scale=${scale}`);
  }
  const textKey = `${state.activeTabId}|${rev}|${i}`;
  if (el.dataset.textKey !== textKey) {
    el.dataset.textKey = textKey;
    loadPageText(el, i, textKey);
  }
}

// Devuelve los elementos de dibujo compartidos a su contenedor neutro (viven
// dentro de la última página donde se dibujó; antes de vaciar el DOM hay que
// rescatarlos o desaparecerían con ella).
function stashDrawExtras() {
  const holder = $('#draw-extras');
  for (const id of ['#draw-ghost-rect', '#draw-ghost-line', '#annot-text-input']) {
    const el = $(id);
    if (el && el.parentElement !== holder) {
      el.hidden = true;
      holder.appendChild(el);
    }
  }
}

// Construye una hoja por página del documento (vista continua).
function buildRealPages(t, sameTab) {
  const rd = $('#real-doc');
  const sc = $('#canvas-scroll');
  const keep = sameTab ? sc.scrollTop : null;
  ensureObserver().disconnect();
  stashDrawExtras();
  rd.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < t.doc.count; i++) {
    const el = document.createElement('div');
    el.className = 'pdf-page';
    el.dataset.page = i;
    el.innerHTML =
      `<img class="pp-img" alt="Página ${i + 1}" draggable="false">` +
      `<div class="pp-search"></div><div class="pp-text"></div><div class="pp-annot"></div>`;
    frag.appendChild(el);
    ensureObserver().observe(el);
  }
  rd.appendChild(frag);
  applyZoomLayout();
  // Misma pestaña (rev nueva): conservar el punto de lectura. Pestaña nueva:
  // colocarse en su página activa recordada.
  if (keep != null) sc.scrollTop = keep;
  else scrollToPage(t.activePage);
}

function renderDoc() {
  const real = inDoc();
  // Sin PDF abierto se muestra la bienvenida, no la factura de demostración:
  // parecía un documento real y confundía (sobre todo detrás del diálogo de
  // contraseña). La demo sigue disponible con ?demo=1 para probar la interfaz.
  $('#welcome-doc').hidden = real || DEMO_MODE;
  $('#demo-doc').hidden = real || !DEMO_MODE;
  $('#real-doc').hidden = !real;
  if (real) {
    const t = activeTab();
    const key = `${state.activeTabId}|${state.doc.rev}`;
    if (builtDocKey !== key && t && t.pageSizes) {
      const rd = $('#real-doc');
      const sameTab = builtDocKey.split('|')[0] === String(state.activeTabId);
      if (sameTab && rd.childElementCount === t.doc.count) {
        // Misma pestaña y mismo nº de páginas (anotación, firma, giro…): basta
        // refrescar tamaños e imágenes visibles. Reutilizar los <img> evita el
        // parpadeo en blanco: la imagen vieja se ve hasta que llega la nueva.
        applyZoomLayout();
        for (const el of rd.children) if (el._visible) ensurePage(el);
      } else {
        buildRealPages(t, sameTab);
      }
      builtDocKey = key;
    }
    const drawing = state.tool !== 'select';
    $('#real-doc').classList.toggle('is-drawing', drawing);
    if (drawing) hideSelPopup();
    return;
  }
  if (builtDocKey) {
    builtDocKey = '';
    stashDrawExtras();
    if (pageObserver) pageObserver.disconnect();
    $('#real-doc').innerHTML = '';
  }
  ['invnum', 'invdate', 'client', 'total'].forEach(id => {
    $('#v-' + id).textContent = state.vals[id];
    const el = $('#el-' + id);
    el.classList.toggle('is-selected', state.selected === id);
    el.classList.toggle('is-edited', state.editedIds.includes(id));
  });
  $('#el-logo').classList.toggle('is-selected', state.selected === 'logo');
  $('#el-logo').classList.toggle('is-moved', state.movedLogo);
  $('#el-table').classList.toggle('is-selected', state.selected === 'table');
}

function renderContextMenus() {
  ['logo', 'client', 'table'].forEach(id => {
    $('#ctx-' + id).classList.toggle('is-open', state.ctx === id);
  });
}

function renderPanels() {
  const left = $('#panel-left');
  const right = $('#panel-right');
  if (left) left.classList.toggle('is-collapsed', state.leftHidden);
  if (right) right.classList.toggle('is-collapsed', state.rightHidden);
  const lb = $('#btn-toggle-left');
  const rb = $('#btn-toggle-right');
  if (lb) lb.classList.toggle('is-active', !state.leftHidden);
  if (rb) rb.classList.toggle('is-active', !state.rightHidden);
}

function renderTools() {
  $$('.tool-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tool === state.tool));
  $$('.an-tool').forEach(b => b.classList.toggle('is-active', b.dataset.tool === state.tool));
  $$('.an-color').forEach(s => s.classList.toggle('is-active', s.dataset.color === state.annotColor));
  // El botón «cambiar firma» solo aparece cuando ya hay una firma recordada.
  const changeBtn = $('#tool-sign-change');
  if (changeBtn) changeBtn.classList.toggle('is-hidden', !state.signImage);
}

// Calcula el zoom «ajustar al ancho»: la página llena el ancho visible del
// lienzo (con un pequeño margen), de modo que se vea lo más grande posible
// horizontalmente. Acotado a 40–300. Requiere el layout ya aplicado.
function fitZoomToWidth() {
  const scroller = $('#canvas-scroll');
  if (!scroller) return state.zoom;
  const availW = scroller.clientWidth - 64;   // margen lateral cómodo
  if (availW <= 0) return state.zoom;
  const z = Math.round((availW / PAGE_DISPLAY_WIDTH) * 100);
  return Math.max(40, Math.min(300, z));
}

// «Ajustar»: que la página quepa ENTERA (ancho y alto). Con una página apaisada
// —al girarla, por ejemplo— ajustar solo al ancho la deja altísima y se sale de
// la pantalla, así que se toma el menor de los dos ajustes.
function fitZoomToPage() {
  const scroller = $('#canvas-scroll');
  if (!scroller || !state.pageSize) return fitZoomToWidth();
  const availW = scroller.clientWidth - 64;
  const availH = scroller.clientHeight - 64;
  if (availW <= 0 || availH <= 0) return state.zoom;
  // Alto del lienzo base (768 px de ancho) según la proporción real de la página.
  const baseH = PAGE_DISPLAY_WIDTH * (state.pageSize.height / state.pageSize.width);
  const z = Math.round(Math.min(availW / PAGE_DISPLAY_WIDTH, availH / baseH) * 100);
  return Math.max(40, Math.min(300, z));
}

// Da a una hoja su ancho CSS (puede ser fraccionario: se elige para que caiga
// exacto en píxeles físicos), reserva el alto vía aspect-ratio (antes de que
// cargue la imagen, para que el scroll no salte) y escala sus capas 768-base.
function layoutPage(el, sz, cssW) {
  el.style.width = cssW + 'px';
  el.style.height = '';
  el.style.aspectRatio = `${sz.width} / ${sz.height}`;
  const ratio = sz.height / Math.max(sz.width, 1);
  const baseH = Math.round(PAGE_DISPLAY_WIDTH * ratio) + 'px';
  const zfExact = cssW / PAGE_DISPLAY_WIDTH;
  for (const cls of ['.pp-text', '.pp-annot', '.pp-search']) {
    const layer = el.querySelector(cls);
    layer.style.transform = `scale(${zfExact})`;
    layer.style.height = baseH;
  }
}

// Aplica el zoom actual a todas las hojas. El ancho CSS se calcula desde un nº
// ENTERO de píxeles físicos (px/devicePixelRatio): con escalado de Windows al
// 125%/150% un ancho CSS entero cae entre píxeles y el navegador re-muestrea la
// imagen (el «texto suavizado»); con el ancho exacto no hay remuestreo.
function applyZoomLayout() {
  const t = activeTab();
  if (!t || !t.pageSizes) return;
  const dpr = window.devicePixelRatio || 1;
  const W = targetPixelWidth() / dpr;
  const rd = $('#real-doc');
  rd.style.gap = Math.max(6, Math.round(18 * (state.zoom / 100))) + 'px';
  for (const el of rd.children) {
    const sz = t.pageSizes[Number(el.dataset.page)];
    if (sz) layoutPage(el, sz, W);
  }
}

// El zoom cambió: re-pedir los PNG visibles a la escala nueva, con una espera
// para no pedir una imagen por cada pulsación mientras se mueve el zoom (tanto
// al acercar —falta resolución— como al alejar —el navegador reduciría una
// imagen grande y volvería a difuminar el texto—).
function schedulePageQuality() {
  clearTimeout(pageQualityTimer);
  pageQualityTimer = setTimeout(() => {
    if (!inDoc()) return;
    for (const el of $$('#real-doc .pdf-page')) if (el._visible) ensurePage(el);
  }, 220);
}

function renderZoom() {
  const zf = state.zoom / 100;
  const scaleEl = $('#page-scale');
  const margin = $('#page-margin');
  if (inDoc()) {
    // Documento real: NADA de transform:scale(). El navegador reducía el PNG a
    // 768px y luego lo estiraba otra vez (dos remuestreos), y por eso el texto
    // se veía difuminado frente a Adobe. Ahora se le da a la imagen su ancho
    // real en CSS y el PNG se pide a esa misma resolución: un solo remuestreo.
    scaleEl.style.transform = 'none';
    scaleEl.style.width = Math.round(PAGE_DISPLAY_WIDTH * zf) + 'px';
    margin.style.width = Math.round(PAGE_DISPLAY_WIDTH * zf) + 'px';
    margin.style.height = 'auto';
    applyZoomLayout();
    schedulePageQuality();
  } else {
    // Demo: es HTML con tipografías y cajas, así que sí se escala con transform.
    scaleEl.style.transform = `scale(${zf})`;
    scaleEl.style.width = '';
    margin.style.width = Math.round(PAGE_DISPLAY_WIDTH * zf) + 'px';
    margin.style.height = Math.round(scaleEl.offsetHeight * zf) + 'px';
  }
  const label = state.zoom + '%';
  $('#zoom-label').textContent = label;
  $('#status-zoom').textContent = label;
}

// Zoom con Ctrl+rueda anclado al puntero: el punto del documento bajo el
// cursor permanece bajo el cursor tras el cambio de escala.
function zoomAtPointer(e, delta) {
  const z0 = state.zoom;
  const z1 = Math.max(40, Math.min(300, z0 + delta));
  if (z1 === z0) return;
  const scroller = $('#canvas-scroll');
  const margin = $('#page-margin');
  const rect = scroller.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // Punto del documento (sin escalar) bajo el cursor
  const docX = (scroller.scrollLeft + cx - margin.offsetLeft) / (z0 / 100);
  const docY = (scroller.scrollTop + cy - margin.offsetTop) / (z0 / 100);
  setState({ zoom: z1 });
  // Tras el re-render el contenedor cambió de tamaño (y de centrado)
  scroller.scrollLeft = docX * (z1 / 100) + margin.offsetLeft - cx;
  scroller.scrollTop = docY * (z1 / 100) + margin.offsetTop - cy;
}

function renderRightPanel() {
  $$('.rp-tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === state.rightTab));
  $$('.rp-panel').forEach(p => p.classList.toggle('is-open', p.dataset.panel === state.rightTab));

  // Edición: subpaneles según selección (solo documento demo)
  const selType = inDoc() || state.selected == null ? null
    : state.selected === 'logo' ? 'image'
    : state.selected === 'table' ? 'table'
    : 'text';
  $('#ed-none').hidden = selType != null;
  $('#ed-text').hidden = selType !== 'text';
  $('#ed-image').hidden = selType !== 'image';
  $('#ed-table').hidden = selType !== 'table';
  if (selType === 'text') {
    $('#sel-label').textContent = LABELS[state.selected] || '';
    $('#sel-edited-badge').hidden = !state.editedIds.includes(state.selected);
    const ta = $('#sel-textarea');
    if (document.activeElement !== ta) ta.value = state.vals[state.selected];
  }

  // Extracción
  $('#ex-detected').hidden = !state.tableDetected;
  $('#ex-empty').hidden = state.tableDetected;

  // OCR
  $('#ocr-result').hidden = !state.ocrDone;
  $('#ocr-pending').hidden = state.ocrDone;
  $$('.scope-card').forEach(c => c.classList.toggle('is-active', c.dataset.scope === state.ocrScope));
}

function renderModals() {
  $('#modal-ocr').classList.toggle('is-open', state.modal === 'ocr');
  $('#modal-export').classList.toggle('is-open', state.modal === 'export');
  $('#modal-split').classList.toggle('is-open', state.modal === 'split');
  $$('.fmt-card').forEach(c => c.classList.toggle('is-active', c.dataset.fmt === state.exportFmt));
  $$('.modal-active-page').forEach(el => { el.textContent = state.activePage; });
}

function renderStatusbar() {
  $('#status-page').textContent = state.activePage;
  // «Quitar clave» solo tiene sentido si el documento abierto está protegido.
  $('#btn-remove-pw').hidden = !(inDoc() && state.doc.encrypted);
  let ocrOn, changes;
  if (inDoc()) {
    ocrOn = state.ocrDone;
    changes = state.doc.dirty ? 'Cambios sin guardar' : 'Sin cambios pendientes';
  } else if (DEMO_MODE) {
    const pageInfo = state.pages[state.activePage - 1] || {};
    ocrOn = state.ocrDone || !!pageInfo.ocr;
    changes = `${state.editedIds.length} ediciones · ${state.movedLogo ? 1 : 0} imagen movida · 3 anotaciones`;
  } else {
    // Sin documento no hay nada que contar (antes decía «3 anotaciones» siempre).
    ocrOn = false;
    changes = 'Sin documento abierto';
  }
  const st = $('#ocr-status');
  st.textContent = ocrOn ? 'Aplicado' : 'Pendiente';
  st.classList.toggle('is-done', ocrOn);
  st.classList.toggle('is-pending', !ocrOn);
  $('#change-text').textContent = changes;
}

/* ===== Deshacer / rehacer ===== */
const demoHistory = { undo: [], redo: [] };

function demoSnapshotData() {
  return JSON.parse(JSON.stringify({
    vals: state.vals,
    editedIds: state.editedIds,
    movedLogo: state.movedLogo,
    pages: state.pages,
    activePage: state.activePage,
  }));
}

function demoSnapshot(tag) {
  const top = demoHistory.undo[demoHistory.undo.length - 1];
  if (tag && top && top.tag === tag) return; // agrupa la escritura continua en un mismo campo
  demoHistory.undo.push({ tag: tag || null, data: demoSnapshotData() });
  if (demoHistory.undo.length > 30) demoHistory.undo.shift();
  demoHistory.redo.length = 0;
}

function demoRestore(entry) {
  Object.assign(state, JSON.parse(JSON.stringify(entry.data)));
  state.activePage = Math.min(state.activePage, state.pages.length);
  render();
}

async function undoAction() {
  if (inDoc()) {
    if (!state.doc.undo) return;
    try {
      await applyDoc(await api.post('/api/undo'));
      toast('Acción deshecha');
    } catch (e) { toast(e.message); }
    return;
  }
  if (!demoHistory.undo.length) return;
  const entry = demoHistory.undo.pop();
  demoHistory.redo.push({ tag: null, data: demoSnapshotData() });
  demoRestore(entry);
}

async function redoAction() {
  if (inDoc()) {
    if (!state.doc.redo) return;
    try {
      await applyDoc(await api.post('/api/redo'));
      toast('Acción rehecha');
    } catch (e) { toast(e.message); }
    return;
  }
  if (!demoHistory.redo.length) return;
  const entry = demoHistory.redo.pop();
  demoHistory.undo.push({ tag: null, data: demoSnapshotData() });
  demoRestore(entry);
}

function renderUndo() {
  const canUndo = inDoc() ? state.doc.undo > 0 : demoHistory.undo.length > 0;
  const canRedo = inDoc() ? state.doc.redo > 0 : demoHistory.redo.length > 0;
  $('#btn-undo').classList.toggle('is-disabled', !canUndo);
  $('#btn-redo').classList.toggle('is-disabled', !canRedo);
}

/* ===== Separar en grupos (selección visual de páginas) ===== */
const GROUP_COLORS = ['#2563a8', '#2e9e6b', '#e07b39', '#8b5cf6', '#c0555a', '#0e9aa7', '#b8860b', '#5a616b'];
const splitState = { groups: [], active: 0 };

// «1-3, 7» → [0,1,2,6] (orden indicado, sin duplicados, dentro del documento)
function pagesFromRangeSpec(spec, count) {
  const pages = [];
  const seen = new Set();
  for (let part of String(spec || '').split(',')) {
    part = part.trim();
    if (!part) continue;
    let from, to;
    if (part.includes('-')) {
      const [a, b] = part.split('-', 2);
      from = parseInt(a, 10); to = parseInt(b, 10);
    } else {
      from = to = parseInt(part, 10);
    }
    if (isNaN(from) || isNaN(to)) continue;
    for (let p = from - 1; p <= to - 1; p++) {
      if (p >= 0 && p < count && !seen.has(p)) { seen.add(p); pages.push(p); }
    }
  }
  return pages;
}

// [0,1,2,6] → «1-3, 7»
function rangeSpecFromPages(pages) {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts = [];
  let start = null, prev = null;
  for (const p of sorted) {
    if (start === null) { start = prev = p; continue; }
    if (p === prev + 1) { prev = p; continue; }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
    start = prev = p;
  }
  if (start !== null) parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`);
  return parts.join(', ');
}

function splitActiveGroup() {
  return splitState.groups[splitState.active];
}

function buildSplitRow(g, index) {
  const row = document.createElement('div');
  row.className = 'split-row';
  row.dataset.g = index;
  row.innerHTML =
    `<span class="split-color" style="background:${g.color}"></span>` +
    `<input class="split-name rp-input" placeholder="Nombre del grupo" value="${escapeHtml(g.name)}">` +
    `<input class="split-range rp-input" placeholder="p. ej. 1-3, 7" value="${escapeHtml(rangeSpecFromPages(g.pages))}">` +
    `<button class="split-del btn-page-icon btn-page-del" title="Quitar grupo">` +
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/></svg></button>`;
  row.addEventListener('click', () => setActiveSplitGroup(index));
  row.querySelector('.split-name').addEventListener('input', e => { g.name = e.target.value; });
  row.querySelector('.split-range').addEventListener('input', e => {
    g.pages = pagesFromRangeSpec(e.target.value, state.doc.count);
    updateSplitTiles();
  });
  row.querySelector('.split-del').addEventListener('click', e => {
    e.stopPropagation();
    if (splitState.groups.length <= 1) { toast('Debe existir al menos un grupo'); return; }
    splitState.groups.splice(index, 1);
    splitState.active = Math.min(splitState.active, splitState.groups.length - 1);
    renderSplitRows();
    updateSplitTiles();
  });
  return row;
}

function renderSplitRows() {
  const wrap = $('#split-groups');
  wrap.innerHTML = '';
  splitState.groups.forEach((g, i) => wrap.appendChild(buildSplitRow(g, i)));
  markActiveSplitRow();
}

function markActiveSplitRow() {
  $$('.split-row').forEach(row =>
    row.classList.toggle('is-active', Number(row.dataset.g) === splitState.active));
}

function setActiveSplitGroup(index) {
  splitState.active = index;
  markActiveSplitRow();
  updateSplitTiles();
}

function syncSplitRangeInput(index) {
  const row = $(`.split-row[data-g="${index}"]`);
  if (row) row.querySelector('.split-range').value = rangeSpecFromPages(splitState.groups[index].pages);
}

function buildSplitGrid() {
  const grid = $('#split-grid');
  grid.innerHTML = '';
  for (let i = 0; i < state.doc.count; i++) {
    const tile = document.createElement('div');
    tile.className = 'split-tile';
    tile.dataset.page = i;
    tile.innerHTML =
      `<img loading="lazy" src="${imgUrl(`/api/thumb/${i}?r=${state.doc.rev}&dpr=${thumbDpr()}`)}" alt="Página ${i + 1}">` +
      `<span class="split-tile-num">${i + 1}</span>` +
      `<span class="split-tile-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg></span>` +
      `<span class="split-tile-dots"></span>` +
      `<span class="split-tile-zoom" title="Ver página ampliada"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6M11 8v6M8 11h6"/></svg></span>`;
    tile.addEventListener('click', () => {
      togglePageInActiveGroup(i);
    });
    tile.querySelector('.split-tile-zoom').addEventListener('click', e => {
      e.stopPropagation();
      openPagePreview(i);
    });
    grid.appendChild(tile);
  }
  updateSplitTiles();
}

function updateSplitTiles() {
  const active = splitActiveGroup();
  $$('.split-tile').forEach(tile => {
    const p = Number(tile.dataset.page);
    const checked = active.pages.includes(p);
    tile.classList.toggle('checked', checked);
    tile.style.setProperty('--gcolor', active.color);
    const dots = splitState.groups
      .filter((g, gi) => gi !== splitState.active && g.pages.includes(p))
      .map(g => `<span style="background:${g.color}" title="${escapeHtml(g.name)}"></span>`)
      .join('');
    tile.querySelector('.split-tile-dots').innerHTML = dots;
  });
}

function togglePageInActiveGroup(i) {
  const g = splitActiveGroup();
  const pos = g.pages.indexOf(i);
  if (pos >= 0) g.pages.splice(pos, 1);
  else g.pages.push(i);
  syncSplitRangeInput(splitState.active);
  updateSplitTiles();
}

/* ===== Vista previa ampliada (zoom) ===== */
// `width`: ancho en px CSS al que se está mostrando la imagen (0 = aún sin zoom).
// `ptWidth`: ancho en puntos PDF de la página previsualizada (puede no ser la
// activa, así que no vale state.pageSize; se cachea al abrirla/navegar).
const previewState = { page: 0, width: 0, scale: 0, ptWidth: 0 };

function previewOpen() {
  return !$('#page-preview').hidden;
}

// Escala de render que hace falta para que la vista previa se vea nítida a
// `cssWidth` px de ancho. Antes era fija (3x) y, como se puede ampliar más allá
// del tamaño nativo, la imagen acababa estirada y borrosa. Ahora se pide la
// resolución que realmente se va a mostrar, contando los píxeles físicos
// (devicePixelRatio) y sin pasarse: se redondea a 0.5 para reaprovechar la
// caché del navegador en lugar de recargar por cada rueda del ratón.
function previewScaleFor(cssWidth) {
  const ptWidth = previewState.ptWidth || PAGE_DISPLAY_WIDTH;
  const target = (cssWidth * (window.devicePixelRatio || 1)) / ptWidth;
  return Math.max(2, Math.min(6, Math.ceil(target * 2) / 2));
}

function renderPagePreview() {
  const i = previewState.page;
  const count = state.doc.count;
  const img = $('#preview-img');
  // Sin zoom aún: el CSS la ajusta al hueco disponible (max-width/height).
  const shown = previewState.width || $('#preview-body').clientWidth - 140;
  const scale = previewScaleFor(shown);
  previewState.scale = scale;
  img.src = imgUrl(`/api/page/${i}?r=${state.doc.rev}&scale=${scale}`);
  $('#preview-label').textContent = `Página ${i + 1} de ${count}`;
  $('#preview-prev').classList.toggle('is-disabled', i === 0);
  $('#preview-next').classList.toggle('is-disabled', i === count - 1);
  const g = splitActiveGroup();
  const checked = g.pages.includes(i);
  const btn = $('#preview-check');
  btn.classList.toggle('is-checked', checked);
  btn.style.setProperty('--gcolor', g.color);
  $('#preview-check-text').textContent = checked
    ? `Marcada en «${(g.name || '').trim() || 'grupo activo'}» — quitar`
    : `Marcar en «${(g.name || '').trim() || 'grupo activo'}»`;
}

function resetPreviewZoom() {
  $('#preview-img').style.width = '';
  $('#preview-body').classList.remove('is-zoomed');
  previewState.width = 0;
}

function previewWheelZoom(e) {
  const img = $('#preview-img');
  const body = $('#preview-body');
  const rect = img.getBoundingClientRect();
  // Fracción de la imagen bajo el cursor (anclar el zoom al puntero)
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  const current = img.clientWidth || img.naturalWidth;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  // El tope se mide en px de PANTALLA, no sobre naturalWidth: antes el máximo
  // era naturalWidth*2, es decir, estirar la imagen al doble (y verla borrosa).
  // Ahora pedimos más resolución al backend, así que podemos ampliar de verdad.
  const ptWidth = previewState.ptWidth || PAGE_DISPLAY_WIDTH;
  const maxWidth = (ptWidth * 6) / (window.devicePixelRatio || 1);  // 6x = tope del backend
  const next = Math.max(220, Math.min(maxWidth, Math.round(current * factor)));
  body.classList.add('is-zoomed');
  img.style.width = next + 'px';
  previewState.width = next;
  // Si al ampliar hace falta más resolución de la cargada, la recargamos.
  requestPreviewQuality(next);
  const nrect = img.getBoundingClientRect();
  body.scrollLeft += (nrect.left + fx * nrect.width) - e.clientX;
  body.scrollTop += (nrect.top + fy * nrect.height) - e.clientY;
}

// Sube la resolución de la vista previa cuando el zoom la deja corta. Igual que
// en la página principal: solo se sube (nunca se baja, para no recargar al
// alejar) y con una pequeña espera para no pedir una imagen por cada rueda.
let previewQualityTimer = 0;

function requestPreviewQuality(cssWidth) {
  const need = previewScaleFor(cssWidth);
  if (need <= previewState.scale) return;
  clearTimeout(previewQualityTimer);
  previewQualityTimer = setTimeout(() => {
    if (!previewOpen()) return;
    previewState.scale = need;
    $('#preview-img').src = imgUrl(
      `/api/page/${previewState.page}?r=${state.doc.rev}&scale=${need}`);
  }, 220);
}

// Tamaño real (en puntos) de la página previsualizada: la necesita
// previewScaleFor para acertar con la resolución. Se pide en segundo plano y,
// si cambia respecto al fallback, se repinta con la escala correcta.
async function loadPreviewPageSize(i) {
  previewState.ptWidth = (state.pageSize && state.pageSize.width) || PAGE_DISPLAY_WIDTH;
  try {
    const sz = await api.get(`/api/pagesize/${i}`);
    if (!previewOpen() || previewState.page !== i) return;
    if (sz && sz.width && sz.width !== previewState.ptWidth) {
      previewState.ptWidth = sz.width;
      renderPagePreview();
    }
  } catch { /* nos quedamos con el fallback */ }
}

function openPagePreview(i) {
  previewState.page = i;
  resetPreviewZoom();
  $('#page-preview').hidden = false;
  renderPagePreview();
  loadPreviewPageSize(i);
}

function closePagePreview() {
  $('#page-preview').hidden = true;
}

function navPagePreview(delta) {
  const next = previewState.page + delta;
  if (next < 0 || next >= state.doc.count) return;
  previewState.page = next;
  resetPreviewZoom();
  renderPagePreview();
  loadPreviewPageSize(next);
}

function newSplitGroup() {
  const n = splitState.groups.length + 1;
  return {
    name: `${docBaseName()}_grupo_${n}`,
    color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length],
    pages: [],
  };
}

function openSplitModal() {
  if (!inDoc()) { toast('Abre un PDF para separar páginas'); return; }
  const count = state.doc.count;
  const half = Math.ceil(count / 2);
  splitState.groups = [];
  splitState.active = 0;
  const g1 = newSplitGroup();
  g1.pages = Array.from({ length: half }, (_, i) => i);
  splitState.groups.push(g1);
  if (count > 1) {
    const g2 = newSplitGroup();
    g2.pages = Array.from({ length: count - half }, (_, i) => half + i);
    splitState.groups.push(g2);
  }
  renderSplitRows();
  buildSplitGrid();
  setState({ modal: 'split', ctx: null });
}

function addSplitGroup() {
  splitState.groups.push(newSplitGroup());
  splitState.active = splitState.groups.length - 1;
  renderSplitRows();
  updateSplitTiles();
}

async function runSplitGroups() {
  const groups = splitState.groups.map((g, i) => ({
    name: (g.name || '').trim() || `Grupo ${i + 1}`,
    range: rangeSpecFromPages(g.pages),
  }));
  const empty = groups.filter(g => !g.range);
  if (empty.length) {
    toast(`Marca al menos una página en «${empty[0].name}»`);
    return;
  }
  try {
    const r = await api.post('/api/split-groups', { groups });
    if (r.cancelled) return;
    setState({ modal: null });
    toast(`${r.paths.length} PDF${r.paths.length === 1 ? '' : 's'} guardado${r.paths.length === 1 ? '' : 's'} en ${r.folder}`);
  } catch (e) {
    toast('Error al separar: ' + e.message);
  }
}

/* ===== Acciones demo ===== */
function select(id) {
  setState({
    selected: id,
    ctx: null,
    rightTab: id === 'table' ? 'extraccion' : state.rightTab,
  });
}

function openCtx(id) {
  setState({ ctx: id, selected: id });
}

function clearAll() {
  setState({ selected: null, ctx: null });
}

function editValue(id, value) {
  demoSnapshot('edit:' + id);
  state.vals[id] = value;
  if (!state.editedIds.includes(id)) state.editedIds.push(id);
  render();
}

function toggleMoveLogo() {
  demoSnapshot();
  setState({ movedLogo: !state.movedLogo, selected: 'logo', ctx: null });
}

/* ===== Extracción ===== */
async function detectTable() {
  if (!inDoc()) {
    setState({ tableDetected: true, selected: 'table', rightTab: 'extraccion', ctx: null });
    return;
  }
  try {
    const r = await api.get(`/api/tables?page=${state.activePage - 1}`);
    if (!r.tables.length) {
      state.extractedTable = null;
      setState({ tableDetected: false, rightTab: 'extraccion' });
      toast('No se detectaron tablas en esta página');
      return;
    }
    const t = r.tables[0];
    state.extractedTable = t;
    renderExtractedTable(t, r.tables.length);
    setState({ tableDetected: true, rightTab: 'extraccion', ctx: null });
  } catch (e) {
    toast('Error al detectar tablas: ' + e.message);
  }
}

function renderExtractedTable(t, totalTables) {
  $('#ex-detected .ed-title').textContent =
    `${totalTables} tabla${totalTables === 1 ? '' : 's'} detectada${totalTables === 1 ? '' : 's'}`;
  $('.ex-info').innerHTML = `${t.cols} columnas · ${t.nrows} filas · página ${state.activePage}`;
  const table = $('.ex-table');
  const head = t.rows[0] || [];
  const body = t.rows.slice(1, 7);
  table.querySelector('thead').innerHTML =
    '<tr>' + head.map(c => `<th class="th-left">${escapeHtml(c)}</th>`).join('') + '</tr>';
  table.querySelector('tbody').innerHTML = body.map(row =>
    '<tr>' + row.map(c => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>'
  ).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function currentTableRows() {
  return inDoc() && state.extractedTable ? state.extractedTable.rows : DEMO_TABLE;
}

async function exportTable(fmt) {
  if (inDoc()) {
    try {
      const r = await api.post('/api/export-table', { page: state.activePage - 1, fmt });
      if (!r.cancelled) toast('Tabla guardada en ' + r.path);
    } catch (e) {
      toast('Error al exportar: ' + e.message);
    }
    return;
  }
  const rows = currentTableRows();
  if (fmt === 'csv') {
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    download(docBaseName() + '_tabla.csv', '﻿' + csv, 'text/csv;charset=utf-8');
    toast('Tabla exportada como CSV');
  } else {
    download(docBaseName() + '_tabla.xls',
      `<html><head><meta charset="utf-8"></head><body>${rowsToHtml(rows)}</body></html>`,
      'application/vnd.ms-excel');
    toast('Tabla exportada como Excel');
  }
}

/* ===== Girar páginas ===== */

// dir: 'left' | 'right'. `whole` = todo el documento en vez de la página actual.
async function rotatePage(dir, whole = false) {
  if (!inDoc()) { toast('Abre un PDF para girarlo'); return; }
  try {
    const r = await api.post('/api/pages', {
      action: dir === 'left' ? 'rotate-left' : 'rotate-right',
      page: state.activePage - 1,
      scope: whole ? 'doc' : 'pg',
    });
    // El tamaño ANTES de aplicar nada: applyDoc refresca los tamaños de todas
    // las páginas (revisión nueva), así que se guarda aquí para comparar.
    const antes = state.pageSize && { ...state.pageSize };
    await applyDoc(r);
    // Si la página pasó de vertical a apaisada (o al revés), el zoom anterior se
    // calculó para la otra orientación y la página se saldría del área visible:
    // se reajusta al ancho.
    const giroImpar = antes && state.pageSize
      && (antes.width > antes.height) !== (state.pageSize.width > state.pageSize.height);
    if (giroImpar) state.zoom = fitZoomToPage();
    // Los recuadros de la búsqueda son del tamaño anterior: se rehace.
    if (state.searchQuery) await runSearch(state.searchQuery);
    render();
    toast(whole ? 'Documento girado' : `Página ${state.activePage} girada`);
  } catch (e) {
    toast('No se pudo girar: ' + e.message);
  }
}

/* ===== Buscar texto en el documento ===== */

// Lanza la búsqueda con una pequeña espera: así no se pide una por cada tecla.
function searchDebounced(q) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 260);
}

async function runSearch(q) {
  q = (q || '').trim();
  if (!inDoc() || !q) {
    setState({ searchQuery: q, searchHits: [], searchHit: 0 });
    return;
  }
  const seq = ++searchSeq;
  try {
    const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;   // llegó tarde: ya hay otra búsqueda
    setState({ searchQuery: q, searchHits: r.hits || [], searchHit: 0 });
    if (r.hits && r.hits.length) {
      gotoHit(0);
    } else {
      // Un escaneo sin OCR no tiene texto que buscar: merece explicación.
      const digital = (await api.get('/api/text?scope=doc&page=0')).text || '';
      toast(digital.trim()
        ? `No se encontró «${q}»`
        : 'Este documento está escaneado: aplica OCR para poder buscar');
    }
  } catch (e) {
    if (seq === searchSeq) toast('Error al buscar: ' + e.message);
  }
}

// Salta a la coincidencia `i`: se desplaza hasta su página y la resalta.
function gotoHit(i) {
  const hits = state.searchHits;
  if (!hits.length) return;
  const n = ((i % hits.length) + hits.length) % hits.length;   // circular
  const hit = hits[n];
  state.searchHit = n;
  if (inDoc()) {
    if (hit.page + 1 !== state.activePage) setActivePage(hit.page + 1);
    renderSearch();          // actualiza el contador y la clase is-current
    scrollHitIntoView(hit);
  } else {
    setState({ searchHit: n, activePage: hit.page + 1 });
  }
}

function scrollHitIntoView(hit) {
  const scroller = $('#canvas-scroll');
  const pageEl = getPageEl(hit.page);
  const t = activeTab();
  const sz = t && t.pageSizes && t.pageSizes[hit.page];
  if (!scroller || !pageEl || !sz) return;
  // rect viene en puntos PDF; pasarlo a píxeles de pantalla de SU página.
  const f = (pageEl.getBoundingClientRect().width || PAGE_DISPLAY_WIDTH) / sz.width;
  const top = scroller.scrollTop + pageEl.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top + hit.rect[1] * f;
  scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 2),
                      behavior: 'smooth' });
}

function renderSearch() {
  const box = $('#search-box');
  const count = $('#search-count');
  const hits = state.searchHits;
  const has = !!state.searchQuery;
  if (box) box.classList.toggle('is-active', has);
  if (count) {
    count.hidden = !has;
    count.textContent = hits.length ? `${state.searchHit + 1}/${hits.length}` : 'Sin resultados';
    count.classList.toggle('is-empty', has && !hits.length);
  }
  for (const [id, show] of [['#search-prev', hits.length > 1],
                            ['#search-next', hits.length > 1],
                            ['#search-clear', has]]) {
    const el = $(id);
    if (el) el.hidden = !show;
  }
  // Resaltados: cada coincidencia se dibuja en la capa de SU página (en la
  // vista continua todas las páginas están presentes a la vez).
  const t = activeTab();
  $$('#real-doc .pp-search').forEach(l => { l.innerHTML = ''; });
  if (!inDoc() || !t || !t.pageSizes || !hits.length) return;
  const frags = new Map();   // página -> fragmento con sus resaltados
  hits.forEach((h, i) => {
    const sz = t.pageSizes[h.page];
    if (!sz) return;
    const f = PAGE_DISPLAY_WIDTH / sz.width;   // puntos PDF -> lienzo 768
    const [x0, y0, x1, y1] = h.rect;
    const el = document.createElement('div');
    el.className = 'search-hit' + (i === state.searchHit ? ' is-current' : '');
    el.style.left = (x0 * f) + 'px';
    el.style.top = (y0 * f) + 'px';
    el.style.width = ((x1 - x0) * f) + 'px';
    el.style.height = ((y1 - y0) * f) + 'px';
    let frag = frags.get(h.page);
    if (!frag) { frag = document.createDocumentFragment(); frags.set(h.page, frag); }
    frag.appendChild(el);
  });
  for (const [page, frag] of frags) {
    const pageEl = getPageEl(page);
    if (pageEl) pageEl.querySelector('.pp-search').appendChild(frag);
  }
}

function clearSearch() {
  const input = $('#search-input');
  if (input) input.value = '';
  clearTimeout(searchTimer);
  searchSeq++;
  setState({ searchQuery: '', searchHits: [], searchHit: 0 });
}

/* ===== OCR / texto ===== */

// ¿Hay OCR? Se consulta una vez y se recuerda (Tesseract no aparece ni
// desaparece a mitad de sesión).
let ocrStatusCache = null;

async function ocrAvailable() {
  if (ocrStatusCache === null) {
    try {
      ocrStatusCache = await api.get('/api/ocr-status');
    } catch {
      ocrStatusCache = { available: false };
    }
  }
  return !!ocrStatusCache.available;
}

async function runOcr(closeModal) {
  if (inDoc()) {
    const scope = state.ocrScope === 'doc' ? 'doc' : 'pg';
    const page = state.activePage - 1;
    try {
      // Primero el texto digital: es exacto e inmediato. Si la página está
      // escaneada no habrá nada, y entonces toca OCR de verdad.
      const r = await api.get(`/api/text?scope=${scope}&page=${page}`);
      if ((r.text || '').trim()) {
        $('#ocr-text').value = r.text;
        setState({ ocrDone: true, modal: closeModal ? null : state.modal, rightTab: 'ocr' });
        toast('Texto extraído del documento');
        return;
      }
      // Sin texto digital => documento escaneado: OCR.
      if (!(await ocrAvailable())) {
        toast('Este documento está escaneado y el OCR no está disponible');
        return;
      }
      toast('Documento escaneado: reconociendo texto…');
      const o = await api.post('/api/ocr', { scope, page, apply: true });
      $('#ocr-text').value = o.text || '(No se reconoció texto en la imagen)';
      if (o.doc) applyDoc(o.doc);
      setState({ ocrDone: true, modal: closeModal ? null : state.modal, rightTab: 'ocr' });
      toast(o.ocrPages
        ? `OCR aplicado a ${o.ocrPages} ${o.ocrPages === 1 ? 'página' : 'páginas'} · ahora es buscable`
        : 'No se reconoció texto en la imagen');
    } catch (e) {
      toast('Error al extraer texto: ' + e.message);
    }
    return;
  }
  const pages = state.pages.map((p, i) => {
    if (state.ocrScope === 'doc' || i === state.activePage - 1) return { ...p, ocr: true };
    return p;
  });
  setState({ ocrDone: true, pages, modal: closeModal ? null : state.modal });
  toast('OCR completado · 98% de confianza');
}

/* ===== Anotaciones sobre el PDF ===== */
// `page`/`layer`: página (0-based) y capa .pp-annot donde se está dibujando.
const draw = { active: false, page: 0, layer: null, x0: 0, y0: 0, x1: 0, y1: 0 };

// Punto del ratón en coordenadas del lienzo base (768 px, sin zoom) de la capa
// donde se dibuja. La capa lleva transform:scale(zoom), así que el factor se
// deduce del propio rect en vez de suponerlo.
function overlayLocalPoint(e) {
  const rect = draw.layer.getBoundingClientRect();
  const zf = (rect.width || PAGE_DISPLAY_WIDTH) / PAGE_DISPLAY_WIDTH;
  return {
    x: (e.clientX - rect.left) / zf,
    y: (e.clientY - rect.top) / zf,
  };
}

// Lienzo base (768 px) -> puntos PDF de la página `pageIndex`.
function toPdfPoint(p, pageIndex) {
  const t = activeTab();
  const sz = t && t.pageSizes && t.pageSizes[pageIndex];
  const w = sz ? sz.width : PAGE_DISPLAY_WIDTH;
  const f = w / PAGE_DISPLAY_WIDTH;
  return { x: p.x * f, y: p.y * f };
}

function ghostUpdate() {
  const x = Math.min(draw.x0, draw.x1), y = Math.min(draw.y0, draw.y1);
  const w = Math.abs(draw.x1 - draw.x0), h = Math.abs(draw.y1 - draw.y0);
  if (state.tool === 'line' || state.tool === 'arrow') {
    const svg = $('#draw-ghost-line');
    svg.hidden = false;
    const line = svg.querySelector('line');
    line.setAttribute('x1', draw.x0); line.setAttribute('y1', draw.y0);
    line.setAttribute('x2', draw.x1); line.setAttribute('y2', draw.y1);
  } else {
    const box = $('#draw-ghost-rect');
    box.hidden = false;
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }
}

function ghostHide() {
  $('#draw-ghost-rect').hidden = true;
  $('#draw-ghost-line').hidden = true;
}

async function commitAnnot(text) {
  const a = toPdfPoint({ x: draw.x0, y: draw.y0 }, draw.page);
  const b = toPdfPoint({ x: draw.x1, y: draw.y1 }, draw.page);
  const rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  const body = {
    page: draw.page,
    kind: state.tool,
    color: state.annotColor,
    width: parseFloat($('#slider-thickness').value),
    opacity: parseFloat($('#slider-opacity').value) / 100,
  };
  if (state.tool === 'line' || state.tool === 'arrow') {
    body.p1 = [a.x, a.y];
    body.p2 = [b.x, b.y];
  } else {
    body.rect = rect;
    if (state.tool === 'textbox') body.text = text || '';
  }
  try {
    const info = await api.post('/api/annot', body);
    await applyDoc(info);
  } catch (e) {
    toast('Error al anotar: ' + e.message);
  }
}

/* ===== Firma (importar PNG) ===== */
// Paso 1: si ya hay una firma importada en esta sesión, la reutiliza y entra en
// modo colocar; si no, pide el PNG. Requiere un documento abierto.
function startSignature() {
  if (!inDoc()) { toast('Abre un PDF para firmar'); return; }
  if (state.signImage) {
    setState({ tool: 'sign' });
    toast('Dibuja el recuadro para colocar la firma · «Cambiar firma» para importar otra');
  } else {
    importSignature();
  }
}

// Abre el selector para importar (o reemplazar) el PNG de la firma.
function importSignature() {
  if (!inDoc()) { toast('Abre un PDF para firmar'); return; }
  $('#sign-file').click();
}

// Lee el PNG elegido, lo recuerda y entra en modo «colocar firma».
function onSignFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';   // permite volver a elegir el mismo archivo
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Elige una imagen (PNG)'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.signImage = reader.result;   // data URL (recordada toda la sesión)
    setState({ tool: 'sign' });
    toast('Dibuja el recuadro donde quieres colocar la firma');
  };
  reader.onerror = () => toast('No se pudo leer la imagen');
  reader.readAsDataURL(file);
}

// Paso final: con el rectángulo dibujado, insertar la firma en el PDF.
async function commitSignature() {
  if (!state.signImage) { toast('Primero importa una imagen de firma'); return; }
  const a = toPdfPoint({ x: draw.x0, y: draw.y0 }, draw.page);
  const b = toPdfPoint({ x: draw.x1, y: draw.y1 }, draw.page);
  const rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  try {
    const info = await api.post('/api/sign', {
      page: draw.page,
      rect,
      image: state.signImage,
      keepRatio: true,
      opacity: parseFloat($('#slider-opacity').value) / 100,
    });
    await applyDoc(info);
    toast('Firma añadida');
  } catch (err) {
    toast('Error al firmar: ' + err.message);
  }
}

function initDrawing() {
  // Delegación sobre el contenedor de páginas: cada hoja tiene su propia capa
  // .pp-annot, y los «fantasmas» del dibujo se mueven a la capa donde se
  // empieza a dibujar (así el trazo aparece sobre esa página).
  const rd = $('#real-doc');
  const input = $('#annot-text-input');

  rd.addEventListener('pointerdown', e => {
    if (!inDoc() || state.tool === 'select' || !input.hidden) return;
    const layer = e.target.closest('.pp-annot');
    if (!layer) return;
    e.preventDefault();
    draw.layer = layer;
    draw.page = Number(layer.closest('.pdf-page').dataset.page);
    layer.appendChild($('#draw-ghost-rect'));
    layer.appendChild($('#draw-ghost-line'));
    layer.appendChild(input);
    const p = overlayLocalPoint(e);
    draw.active = true;
    draw.x0 = draw.x1 = p.x;
    draw.y0 = draw.y1 = p.y;
    layer.setPointerCapture(e.pointerId);
    ghostUpdate();
  });

  rd.addEventListener('pointermove', e => {
    if (!draw.active) return;
    const p = overlayLocalPoint(e);
    draw.x1 = p.x; draw.y1 = p.y;
    ghostUpdate();
  });

  rd.addEventListener('pointerup', async e => {
    if (!draw.active) return;
    draw.active = false;
    const p = overlayLocalPoint(e);
    draw.x1 = p.x; draw.y1 = p.y;
    ghostHide();
    const tiny = Math.abs(draw.x1 - draw.x0) < 4 && Math.abs(draw.y1 - draw.y0) < 4;
    if (state.tool === 'sign') {
      // Un simple clic coloca la firma con un tamaño por defecto (200×80 px).
      if (tiny) { draw.x1 = draw.x0 + 200; draw.y1 = draw.y0 + 80; }
      await commitSignature();
      return;
    }
    if (tiny && state.tool !== 'textbox') return;
    if (state.tool === 'textbox') {
      if (tiny) { draw.x1 = draw.x0 + 170; draw.y1 = draw.y0 + 22; }
      Object.assign(input.style, {
        left: Math.min(draw.x0, draw.x1) + 'px',
        top: Math.min(draw.y0, draw.y1) + 'px',
      });
      input.value = '';
      input.hidden = false;
      input.focus();
      return;
    }
    await commitAnnot();
  });

  input.addEventListener('keydown', async e => {
    if (e.key === 'Enter') {
      const text = input.value.trim();
      input.hidden = true;
      if (text) await commitAnnot(text);
    } else if (e.key === 'Escape') {
      input.hidden = true;
    }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => { input.hidden = true; });
}

/* ===== Capa de texto seleccionable + resaltado de texto (estilo Adobe) ===== */

// Carga las palabras de la página `index` en la capa de texto de SU hoja.
async function loadPageText(el, index, key) {
  const tl = el.querySelector('.pp-text');
  tl.innerHTML = '';
  let data;
  try {
    data = await api.get(`/api/words/${index}`);
  } catch { return; }
  // La respuesta puede llegar tarde: ignorar si la hoja ya se reconstruyó o
  // cambió de revisión mientras tanto.
  if (el.dataset.textKey !== key || !el.isConnected) return;
  buildTextLayer(tl, data);
}

function buildTextLayer(tl, data) {
  const f = PAGE_DISPLAY_WIDTH / (data.width || PAGE_DISPLAY_WIDTH);
  const frag = document.createDocumentFragment();
  const spans = [];
  for (const w of data.words) {
    const [x0, y0, x1, y1, text] = w;
    if (!text) continue;
    const span = document.createElement('span');
    span.textContent = text;
    const h = (y1 - y0) * f;
    span.style.left = (x0 * f) + 'px';
    span.style.top = (y0 * f) + 'px';
    span.style.height = h + 'px';
    span.style.fontSize = (h * 0.92) + 'px';
    span.dataset.w = (x1 - x0) * f;   // ancho objetivo en px de pantalla
    frag.appendChild(span);
    spans.push(span);
  }
  tl.appendChild(frag);
  // Escalar cada palabra horizontalmente para que cubra su recuadro real.
  for (const span of spans) {
    const natural = span.offsetWidth;
    if (natural > 0) {
      span.style.transform = `scaleX(${Number(span.dataset.w) / natural})`;
    }
  }
}

// Capa de texto (.pp-text) que contiene el nodo `n`, o null.
function textLayerOf(n) {
  const el = n && (n.nodeType === 1 ? n : n.parentElement);
  return el ? el.closest('.pp-text') : null;
}

// Selección actual convertida a puntos PDF: {page, quads} (un quad por
// renglón), o null si no hay selección válida dentro de una página.
function selectionQuads() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const tl = textLayerOf(sel.anchorNode);
  // La anotación va a UNA página: si la selección cruza de hoja, no vale.
  if (!tl || textLayerOf(sel.focusNode) !== tl) return null;
  const pageEl = tl.closest('.pdf-page');
  const page = Number(pageEl.dataset.page);
  const tlRect = tl.getBoundingClientRect();
  if (!tlRect.width) return null;
  const t = activeTab();
  const sz = t && t.pageSizes && t.pageSizes[page];
  const pw = sz ? sz.width : PAGE_DISPLAY_WIDTH;
  const factor = pw / tlRect.width;   // px de pantalla (ya escalados) → puntos PDF
  const quads = [];
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    quads.push([
      (r.left - tlRect.left) * factor,
      (r.top - tlRect.top) * factor,
      (r.right - tlRect.left) * factor,
      (r.bottom - tlRect.top) * factor,
    ]);
  }
  return quads.length ? { page, quads } : null;
}

function hideSelPopup() {
  const p = $('#sel-popup');
  if (p && !p.hidden) p.hidden = true;
}

function showSelPopup() {
  if (!inDoc() || state.tool !== 'select') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelPopup(); return; }
  const tl = textLayerOf(sel.anchorNode);
  if (!tl) { hideSelPopup(); return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width) { hideSelPopup(); return; }
  const popup = $('#sel-popup');
  popup.hidden = false;
  // Centrado sobre la selección, sin salirse de la ventana.
  const pw = popup.offsetWidth, ph = popup.offsetHeight;
  let left = rect.left + rect.width / 2 - pw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = rect.top - ph - 9;
  if (top < 8) top = rect.bottom + 9;       // si no cabe arriba, va debajo
  popup.style.left = Math.round(left) + 'px';
  popup.style.top = Math.round(top) + 'px';
  const arrow = rect.left + rect.width / 2 - left;
  popup.style.setProperty('--arrow', Math.max(12, Math.min(pw - 12, arrow)) + 'px');
}

async function applyTextAnnot(kind, color) {
  const sel = selectionQuads();
  if (!sel) { toast('Selecciona texto del documento primero'); return; }
  try {
    const info = await api.post('/api/annot', {
      page: sel.page,
      kind,
      color: color || state.annotColor,
      opacity: parseFloat($('#slider-opacity').value) / 100,
      quads: sel.quads,
    });
    window.getSelection().removeAllRanges();
    hideSelPopup();
    await applyDoc(info);
    toast(kind === 'underline' ? 'Texto subrayado'
      : kind === 'strikeout' ? 'Texto tachado' : 'Texto resaltado');
  } catch (e) {
    toast('No se pudo anotar: ' + e.message);
  }
}

function copySelection() {
  const text = String(window.getSelection());
  if (!text) return;
  navigator.clipboard.writeText(text)
    .then(() => toast('Texto copiado al portapapeles'))
    .catch(() => toast('No se pudo copiar'));
  hideSelPopup();
}

function initTextSelection() {
  const popup = $('#sel-popup');
  // Mostrar el menú al terminar de arrastrar una selección (delegado: las
  // capas de texto son una por página y se reconstruyen con el documento).
  $('#real-doc').addEventListener('mouseup', () => setTimeout(showSelPopup, 0));
  // Ocultarlo cuando la selección desaparece.
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideSelPopup();
  });
  // No perder la selección al pulsar los botones del menú.
  popup.addEventListener('mousedown', e => e.preventDefault());
  popup.querySelectorAll('.sel-act').forEach(btn => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.selact;
      if (act === 'copy') copySelection();
      else applyTextAnnot(act);
    });
  });
  popup.querySelectorAll('.sel-color').forEach(sw => {
    sw.addEventListener('click', () => applyTextAnnot('highlight', sw.dataset.color));
  });
  // Reposicionar/ocultar al desplazar el lienzo.
  $('#canvas-scroll').addEventListener('scroll', hideSelPopup);
}

/* ===== Utilidades ===== */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function rowsToHtml(rows) {
  return '<table border="1">' + rows.map((row, i) =>
    '<tr>' + row.map(c => (i === 0 ? `<th>${escapeHtml(c)}</th>` : `<td>${escapeHtml(c)}</td>`)).join('') + '</tr>'
  ).join('') + '</table>';
}

function docBaseName() {
  return state.fileName.replace(/\.pdf$/i, '');
}

function exportDemoDocument() {
  const v = state.vals;
  const body =
    `<h1>FACTURA</h1><p>N.º ${v.invnum}<br>Fecha ${v.invdate}</p>` +
    `<h3>De</h3><p>Contadores Asociados S.A. de C.V.<br>RFC: CAS-980312-XI1<br>Av. Reforma 1250, Piso 8<br>Ciudad de México, CDMX 06600</p>` +
    `<h3>Facturar a</h3><p>${v.client}<br>RFC: DAN-050916-Q2A<br>Calle Larco 345, Miraflores<br>Lima, Perú 15074</p>` +
    rowsToHtml(DEMO_TABLE) +
    `<p>Subtotal: $48,900.00<br>IVA (16%): $7,824.00<br><strong>Total: ${v.total}</strong></p>` +
    `<p><strong>Condiciones de pago:</strong> Transferencia bancaria a 15 días. CLABE 012 180 00123456789 0 · BBVA.</p>`;
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${docBaseName()}</title></head><body>${body}</body></html>`;
  if (state.exportFmt === 'word') {
    download(docBaseName() + '.doc', html, 'application/msword');
    toast('Documento exportado como Word');
  } else if (state.exportFmt === 'excel') {
    download(docBaseName() + '.xls', `<html><head><meta charset="utf-8"></head><body>${rowsToHtml(DEMO_TABLE)}</body></html>`, 'application/vnd.ms-excel');
    toast('Tablas exportadas como Excel');
  } else {
    download(docBaseName() + '.html', html, 'text/html');
    toast('Documento exportado como HTML');
  }
  setState({ modal: null });
}

async function exportDocument() {
  if (!inDoc()) { exportDemoDocument(); return; }
  try {
    const r = await api.post('/api/export', {
      fmt: state.exportFmt,
      range: $('#export-range').value,
    });
    if (!r.cancelled) toast('Exportado en ' + r.path);
    setState({ modal: null });
  } catch (e) {
    toast('Error al exportar: ' + e.message);
  }
}

/* ===== Fusionar PDFs ===== */
function closeMergeChoice() {
  $('#modal-merge-choice').classList.remove('is-open');
}

async function runMerge(mode) {
  closeMergeChoice();
  if (!inDoc()) { toast('Abre un PDF para fusionar'); return; }
  try {
    const r = await api.post('/api/merge', { mode });
    if (r.cancelled) return;
    await applyDoc(r, { resetPage: mode === 'new' });
    if (mode === 'new') {
      toast(`Documento nuevo con ${r.count} página${r.count === 1 ? '' : 's'} — usa Guardar para conservarlo`);
    } else {
      toast(`${r.added} página${r.added === 1 ? '' : 's'} añadida${r.added === 1 ? '' : 's'} al documento`);
    }
  } catch (e) { toast('Error al fusionar: ' + e.message); }
}

/* ===== Arrastre de la barra de título ===== */
// Franja superior (en px de pantalla) dentro de la cual soltar maximiza.
const SNAP_TOP_ZONE = 8;

function initTitlebarDrag() {
  const bar = $('#titlebar-drag');
  if (!bar) return;
  const bridge = () => window.pywebview && window.pywebview.api;

  // Doble clic en la barra: maximizar / restaurar.
  bar.addEventListener('dblclick', () => {
    const api = bridge();
    if (api && api.toggle_maximize) api.toggle_maximize();
  });

  bar.addEventListener('mousedown', e => {
    if (e.button !== 0) return;             // solo botón izquierdo
    const api = bridge();
    if (!api || !api.drag_start) return;    // sin app de escritorio, no hacemos nada
    e.preventDefault();

    let dragging = true;
    let pending = null;   // último evento por procesar (coalescido con rAF)
    let scheduled = false;
    api.drag_start(e.screenX, e.screenY);

    const flush = () => {
      scheduled = false;
      if (!dragging || !pending || !api.drag_move) return;
      const { sx, sy } = pending;
      pending = null;
      // El origen de la pantalla suele ser 0; screenY <= zona => borde superior.
      const snapTop = sy <= (window.screen.availTop || 0) + SNAP_TOP_ZONE;
      api.drag_move(sx, sy, snapTop);
    };

    const onMove = ev => {
      if (!dragging) return;
      pending = { sx: ev.screenX, sy: ev.screenY };
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
    };
    const onUp = () => {
      dragging = false;
      if (api.drag_end) api.drag_end();
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
}

/* ===== Eventos ===== */
function init() {
  // Controles de ventana
  const winAction = a => api.post('/api/window', { action: a }).catch(() => {});
  $('#win-minimize').addEventListener('click', () => winAction('minimize'));
  $('#win-maximize').addEventListener('click', () => winAction('maximize'));
  $('#win-close').addEventListener('click', requestClose);

  // Arrastre de la barra de título con «snap» al maximizar en el borde superior.
  initTitlebarDrag();

  // Confirmación de cierre con cambios sin guardar (pestaña o ventana completa).
  const closeModal = () => { $('#modal-close-confirm').classList.remove('is-open'); pendingClose = null; };
  $('#confirm-cancel').addEventListener('click', closeModal);

  $('#confirm-discard').addEventListener('click', async () => {
    const pc = pendingClose;
    $('#modal-close-confirm').classList.remove('is-open');
    pendingClose = null;
    if (pc && pc.kind === 'tab') {
      await discardAndCloseTab(pc.id);
    } else {
      winAction('close');   // ventana: descartar todo y cerrar
    }
  });

  $('#confirm-save').addEventListener('click', async () => {
    const pc = pendingClose;
    $('#modal-close-confirm').classList.remove('is-open');
    pendingClose = null;
    if (pc && pc.kind === 'tab') {
      // Guardar esa pestaña y, si se guarda, cerrarla.
      if (state.activeTabId !== pc.id) await activateTab(pc.id);
      const ok = await saveDoc(false);
      if (ok) await discardAndCloseTab(pc.id);
    } else {
      // Ventana: guardar TODAS las pestañas con cambios, luego cerrar.
      const dirty = state.tabs.filter(t => t.doc && t.doc.dirty);
      for (const t of dirty) {
        await activateTab(t.id);
        const ok = await saveDoc(false);
        if (!ok) return;   // canceló un "Guardar como": abortar el cierre
      }
      winAction('close');
    }
  });
  // Lo invoca el backend cuando el cierre viene del SO (Alt+F4) con cambios pendientes
  window.__requestClose = requestClose;

  // Lo invoca el backend cuando OTRA instancia envía un PDF (doble-clic con la
  // app ya abierta): añade esas pestañas y activa la primera.
  // Los avisos se encadenan: si llegan dos archivos casi a la vez, el segundo
  // espera a que el primero termine de montar su pestaña en vez de solaparse.
  let colaExterna = Promise.resolve();
  window.__openExternal = (ids) => {
    colaExterna = colaExterna.then(async () => {
      try {
        const all = ((await api.get('/api/docs')).docs) || [];
        const nuevos = all.filter(d => ids.includes(d.docId));
        if (!nuevos.length) return;
        for (const info of nuevos) upsertTab(info, { resetPage: true });
        await activateTab(nuevos[0].docId);
        await enterReadingMode();
        toast(nuevos.length === 1
          ? `«${nuevos[0].name}» abierto en una pestaña nueva`
          : `${nuevos.length} documentos abiertos en pestañas`);
      } catch (e) {
        toast('No se pudo abrir el archivo recibido: ' + e.message);
      }
    });
  };

  // Lo invoca el backend cuando el PDF recibido de otra instancia (doble-clic)
  // está protegido: se pide la clave y se abre. Antes se descartaba en silencio.
  window.__openLocked = (paths) => {
    colaExterna = colaExterna.then(async () => {
      for (const path of paths || []) {
        try {
          const info = await openWithPassword(path, path.split(/[\\/]/).pop());
          if (!info) continue;             // canceló: seguimos con el resto
          upsertTab(info, { resetPage: true });
          await activateTab(info.docId);
          await enterReadingMode();
          toast(`«${info.name}» abierto · ${info.count} páginas`);
        } catch (e) {
          toast('No se pudo abrir el documento protegido: ' + e.message);
        }
      }
    });
  };

  // --- Girar páginas (con Alt: todo el documento) ---
  $('#btn-rotate-left').addEventListener('click', e => rotatePage('left', e.altKey));
  $('#btn-rotate-right').addEventListener('click', e => rotatePage('right', e.altKey));

  // --- Buscar en el documento ---
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', e => searchDebounced(e.target.value));
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter salta al siguiente; si aún no hay resultados, busca ya (sin espera).
      if (state.searchHits.length) gotoHit(state.searchHit + (e.shiftKey ? -1 : 1));
      else { clearTimeout(searchTimer); runSearch(searchInput.value); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
      searchInput.blur();
    }
  });
  $('#search-next').addEventListener('click', () => gotoHit(state.searchHit + 1));
  $('#search-prev').addEventListener('click', () => gotoHit(state.searchHit - 1));
  $('#search-clear').addEventListener('click', () => { clearSearch(); searchInput.focus(); });

  // Ctrl+F: atajo estándar para ir al buscador.
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  // Botón de la pantalla de bienvenida — mismo diálogo que «Abrir PDF».
  $('#btn-welcome-open').addEventListener('click', openPdf);

  // Nueva pestaña (botón «+» de la tira) — abre el diálogo, igual que «Abrir PDF».
  $('#btn-new-tab').addEventListener('click', openPdf);

  // Mostrar/ocultar paneles laterales.
  $('#btn-toggle-left').addEventListener('click', () => setState({ leftHidden: !state.leftHidden }));
  $('#btn-toggle-right').addEventListener('click', () => setState({ rightHidden: !state.rightHidden }));

  // Toolbar
  $('#btn-open').addEventListener('click', openPdf);
  $('#btn-save').addEventListener('click', () => saveDoc(false));
  $('#btn-split').addEventListener('click', openSplitModal);
  $('#btn-add-group').addEventListener('click', addSplitGroup);
  $('#btn-split-run').addEventListener('click', runSplitGroups);

  // Vista previa ampliada de páginas (modal Separar)
  $('#preview-close').addEventListener('click', closePagePreview);
  $('#preview-prev').addEventListener('click', () => navPagePreview(-1));
  $('#preview-next').addEventListener('click', () => navPagePreview(1));
  $('#preview-check').addEventListener('click', () => {
    togglePageInActiveGroup(previewState.page);
    renderPagePreview();
  });
  $('#preview-img').addEventListener('click', e => {
    e.stopPropagation();
    const body = $('#preview-body');
    if (body.classList.contains('is-zoomed')) resetPreviewZoom();
    else body.classList.add('is-zoomed');
  });
  $('#page-preview').addEventListener('click', e => {
    if (e.target === $('#page-preview') || e.target === $('#preview-body')) closePagePreview();
  });
  $('#btn-undo').addEventListener('click', undoAction);
  $('#btn-redo').addEventListener('click', redoAction);
  $('#btn-merge').addEventListener('click', () => {
    if (!inDoc()) { toast('Abre un PDF para fusionar'); return; }
    $('#modal-merge-choice').classList.add('is-open');
  });
  $('#merge-cancel').addEventListener('click', closeMergeChoice);
  $('#merge-current').addEventListener('click', () => runMerge('current'));
  $('#merge-new').addEventListener('click', () => runMerge('new'));
  $('#btn-ocr-modal').addEventListener('click', () => setState({ modal: 'ocr', ctx: null }));
  $('#btn-export-modal').addEventListener('click', () => setState({ modal: 'export', ctx: null }));

  // Quitar la contraseña: guarda una copia sin cifrar (pregunta dónde).
  $('#btn-remove-pw').addEventListener('click', async () => {
    if (!inDoc() || !state.doc.encrypted) return;
    try {
      const r = await api.post('/api/remove-password', {});
      if (r.cancelled) return;
      await applyDoc(r);   // rellena el docId (es la pestaña activa) y refresca
      toast(`Contraseña eliminada · guardado en «${r.savedTo}»`);
    } catch (e) {
      toast('No se pudo quitar la contraseña: ' + e.message);
    }
  });

  // Páginas
  $('#btn-add-page').addEventListener('click', async () => {
    if (inDoc()) {
      try {
        await applyDoc(await api.post('/api/pages', { action: 'add', page: state.activePage - 1 }));
        changePage(state.activePage + 1);
      } catch (e) { toast(e.message); }
      return;
    }
    demoSnapshot();
    state.pages.push({});
    setState({ activePage: state.pages.length });
  });
  $('#btn-dup-page').addEventListener('click', async () => {
    if (inDoc()) {
      try {
        await applyDoc(await api.post('/api/pages', { action: 'duplicate', page: state.activePage - 1 }));
        changePage(state.activePage + 1);
      } catch (e) { toast(e.message); }
      return;
    }
    demoSnapshot();
    const i = state.activePage - 1;
    state.pages.splice(i + 1, 0, { ...state.pages[i] });
    setState({ activePage: i + 2 });
  });
  $('#btn-del-page').addEventListener('click', async () => {
    if (inDoc()) {
      try {
        const info = await api.post('/api/pages', { action: 'delete', page: state.activePage - 1 });
        await applyDoc(info);
        changePage(Math.min(state.activePage, info.count));
      } catch (e) { toast(e.message); }
      return;
    }
    if (state.pages.length <= 1) return;
    demoSnapshot();
    state.pages.splice(state.activePage - 1, 1);
    setState({ activePage: Math.min(state.activePage, state.pages.length) });
  });

  // Canvas: clic fuera limpia selección; clic en la página no
  $('#canvas-scroll').addEventListener('click', clearAll);
  $('#page-margin').addEventListener('click', e => e.stopPropagation());

  // Elementos seleccionables del documento demo
  ['invnum', 'invdate', 'total'].forEach(id => {
    $('#el-' + id).addEventListener('click', e => { e.stopPropagation(); select(id); });
  });
  $('#el-client').addEventListener('click', e => { e.stopPropagation(); select('client'); });
  $('#el-logo').addEventListener('click', e => { e.stopPropagation(); select('logo'); });
  $('#el-table').addEventListener('click', e => { e.stopPropagation(); select('table'); });

  // Menús contextuales (demo)
  $('#el-logo').addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); openCtx('logo'); });
  $('#el-client').addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); openCtx('client'); });
  $('#el-table').addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); openCtx('table'); });
  $$('.ctx-menu').forEach(m => m.addEventListener('click', e => e.stopPropagation()));
  $$('.ctx-item').forEach(item => {
    item.addEventListener('click', () => {
      const action = item.dataset.ctxAction;
      if (action === 'move-logo') toggleMoveLogo();
      else if (action === 'detect') detectTable();
      else setState({ ctx: null });
    });
  });

  // Herramientas (tira flotante + pestaña Anotaciones)
  $$('.tool-btn, .an-tool').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (b.dataset.tool === 'sign') { startSignature(); return; }
      setState({ tool: b.dataset.tool });
    });
  });
  // Importar la firma PNG y, tras cargarla, entrar en modo «colocar firma».
  $('#sign-file').addEventListener('change', onSignFileChosen);
  // Botón para reemplazar la firma recordada por otra imagen.
  $('#tool-sign-change').addEventListener('click', e => { e.stopPropagation(); importSignature(); });
  $$('.an-color').forEach(s => {
    s.addEventListener('click', () => setState({ annotColor: s.dataset.color }));
  });
  $('#slider-thickness').addEventListener('input', e => {
    $('#thickness-val').textContent = e.target.value + ' px';
  });
  $('#slider-opacity').addEventListener('input', e => {
    $('#opacity-val').textContent = e.target.value + ' %';
  });

  // Zoom. En la vista continua el alto total cambia con la escala: hay que
  // reanclar el scroll proporcionalmente o la vista «salta» a otra página.
  const setZoom = z1 => {
    const z0 = state.zoom;
    z1 = Math.max(40, Math.min(300, z1));
    if (z1 === z0) return;
    const sc = $('#canvas-scroll');
    const center = sc.scrollTop + sc.clientHeight / 2;
    setState({ zoom: z1 });
    if (inDoc()) sc.scrollTop = Math.max(0, center * (z1 / z0) - sc.clientHeight / 2);
  };
  $('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 10));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 10));
  // «Ajustar»: encajar la página entera. Antes ponía el zoom a 100% fijo, que
  // no ajusta a nada (y con una página apaisada se salía de la pantalla).
  $('#btn-zoom-fit').addEventListener('click', () => {
    setZoom(inDoc() ? fitZoomToPage() : 100);
  });

  // Ctrl + rueda del ratón: zoom del lienzo y de la vista previa ampliada
  document.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault(); // evita el zoom del navegador/WebView
    if (previewOpen()) {
      previewWheelZoom(e);
      return;
    }
    if ($('#canvas-scroll').contains(e.target)) {
      zoomAtPointer(e, e.deltaY < 0 ? 10 : -10);
    }
  }, { passive: false });

  // Vista continua: al desplazarse, la página activa es la más visible.
  $('#canvas-scroll').addEventListener('scroll', onCanvasScroll, { passive: true });

  // Ajuste fino de nitidez: el PNG puede llegar 1px más ancho de lo pedido
  // (redondeo interno de PyMuPDF). Al cargar, se fija el ancho CSS de la hoja a
  // naturalWidth/devicePixelRatio: cada píxel del PNG cae en un píxel físico
  // EXACTO de la pantalla y el navegador no re-muestrea nada. (`load` no
  // burbujea: se escucha en fase de captura.)
  $('#real-doc').addEventListener('load', e => {
    const img = e.target;
    if (!img.classList || !img.classList.contains('pp-img') || !img.naturalWidth) return;
    const el = img.closest('.pdf-page');
    const t = activeTab();
    const sz = t && t.pageSizes && t.pageSizes[Number(el.dataset.page)];
    if (!sz) return;
    const cssW = img.naturalWidth / (window.devicePixelRatio || 1);
    // Solo si esta imagen corresponde al zoom actual: una respuesta vieja (se
    // está re-pidiendo a otra escala) no debe imponer su ancho.
    if (Math.abs(cssW - parseFloat(el.style.width || 0)) < 3) layoutPage(el, sz, cssW);
  }, true);

  // Si la ventana se mueve a una pantalla con otro escalado (o cambia el
  // escalado de Windows), devicePixelRatio cambia: se re-pide todo a la
  // densidad nueva para que siga viéndose nítido en ESA pantalla.
  const watchDpr = () => {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener('change', () => {
        if (inDoc()) { renderZoom(); renderPages(); }
        watchDpr();   // re-suscribirse a la densidad nueva
      }, { once: true });
  };
  watchDpr();

  // Rueda sin Ctrl en el borde del documento (solo DEMO): pasar de página.
  // El documento real es continuo: el scroll normal ya recorre las páginas.
  $('#canvas-scroll').addEventListener('wheel', e => {
    if (e.ctrlKey || inDoc()) return;
    const sc = $('#canvas-scroll');
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    const atTop = sc.scrollTop <= 2;
    if (e.deltaY > 0 && atBottom && state.activePage < pageCount()) {
      e.preventDefault();
      changePage(state.activePage + 1);
    } else if (e.deltaY < 0 && atTop && state.activePage > 1) {
      e.preventDefault();
      changePage(state.activePage - 1);
    }
  }, { passive: false });

  // Pestañas del panel derecho
  $$('.rp-tab').forEach(b => b.addEventListener('click', () => setState({ rightTab: b.dataset.tab })));

  // Colapsar / expandir panel derecho
  const setPanelCollapsed = c => {
    $('.panel-right').classList.toggle('is-collapsed', c);
    $('#rp-reopen').classList.toggle('is-visible', c);
  };
  $('#rp-collapse').addEventListener('click', () => setPanelCollapsed(true));
  $('#rp-reopen').addEventListener('click', () => setPanelCollapsed(false));

  // Edición de texto (demo)
  $('#sel-textarea').addEventListener('input', e => {
    if (state.selected && !['logo', 'table'].includes(state.selected)) {
      editValue(state.selected, e.target.value);
    }
  });
  $('#btn-move-logo').addEventListener('click', toggleMoveLogo);
  $('#btn-goto-extract').addEventListener('click', () => setState({ rightTab: 'extraccion' }));

  // Extracción
  $('#btn-detect').addEventListener('click', detectTable);
  $('#btn-redetect').addEventListener('click', detectTable);
  $('#btn-excel').addEventListener('click', () => exportTable('excel'));
  $('#btn-csv').addEventListener('click', () => exportTable('csv'));
  $('#btn-copy').addEventListener('click', () => {
    const tsv = currentTableRows().map(r => r.join('\t')).join('\n');
    navigator.clipboard.writeText(tsv)
      .then(() => toast('Tabla copiada al portapapeles'))
      .catch(() => toast('No se pudo copiar la tabla'));
  });

  // OCR (pestaña y modal comparten alcance)
  $$('.scope-card').forEach(c => c.addEventListener('click', () => setState({ ocrScope: c.dataset.scope })));
  $('#btn-ocr-run').addEventListener('click', () => runOcr(false));
  $('#btn-ocr-run-modal').addEventListener('click', () => runOcr(true));
  $('#btn-ocr-insert').addEventListener('click', () => toast('Texto insertado en el documento'));

  // Modales
  $$('.overlay').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) setState({ modal: null }); });
  });
  $$('[data-close]').forEach(b => b.addEventListener('click', () => setState({ modal: null })));
  $$('.fmt-card').forEach(c => c.addEventListener('click', () => setState({ exportFmt: c.dataset.fmt })));
  $('#btn-export-run').addEventListener('click', exportDocument);
  $$('.checkbox').forEach(cb => cb.addEventListener('click', () => cb.classList.toggle('checked')));

  // Teclado
  document.addEventListener('keydown', e => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveDoc(e.shiftKey);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoAction(); else undoAction();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoAction();
      return;
    }
    // Girar la página: Ctrl+Mayús+L / Ctrl+Mayús+R (con Alt, todo el documento).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !typing
        && ['l', 'r'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      rotatePage(e.key.toLowerCase() === 'l' ? 'left' : 'right', e.altKey);
      return;
    }
    if (previewOpen()) {
      if (e.key === 'Escape') closePagePreview();
      else if (e.key === 'ArrowLeft') navPagePreview(-1);
      else if (e.key === 'ArrowRight') navPagePreview(1);
      else if (e.key === 'Enter' && !typing) {
        togglePageInActiveGroup(previewState.page);
        renderPagePreview();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#annot-text-input').hidden) $('#annot-text-input').hidden = true;
      else if (state.modal) setState({ modal: null });
      else if (state.ctx) setState({ ctx: null });
      else if (state.selected) clearAll();
    }
  });

  initDrawing();
  initTextSelection();
  render();

  // ¿Hay ya documentos abiertos (p. ej. argumento de línea de comandos)?
  // Reconstruye una pestaña por cada uno y activa la primera.
  api.get('/api/docs')
    .then(async r => {
      const docs = (r && r.docs) || [];
      for (const info of docs) upsertTab(info, { resetPage: true });
      if (docs.length) {
        await activateTab(docs[0].docId);
        await enterReadingMode();
      }
      // PDF protegido pasado por línea de comandos (doble-clic con la app
      // cerrada): ya está la interfaz, así que ahora sí podemos pedir la clave.
      if (r && r.locked) {
        const info = await openWithPassword(r.locked, r.locked.split(/[\\/]/).pop());
        if (info) {
          upsertTab(info, { resetPage: true });
          await activateTab(info.docId);
          await enterReadingMode();
          toast(`«${info.name}» abierto · ${info.count} páginas`);
        }
      }
    })
    .catch(() => {});
}

/* ===== Actualización automática ===== */
// El backend comprueba al arrancar si hay versión nueva y lleva la descarga.
// Aquí solo se hace polling del estado y se pinta el aviso, las notas y el
// progreso; el reemplazo y reinicio los hace un proceso externo (ver updater.py).
const upd = {
  poll: 0,
  available: null,   // release nuevo, o null
  dismissed: false,  // el usuario pulsó «Ahora no» esta sesión
  applying: false,
};

function bytesToMB(n) {
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

async function updateTick() {
  let st;
  try {
    st = await api.get('/api/update/status');
  } catch { return; }
  // Mostrar la versión actual en la barra de estado (útil para saber qué
  // versión corre y para confirmar de un vistazo que la actualización se aplicó).
  if (st.current) $('#status-version').textContent = 'v' + st.current;
  // Fuera del .exe (desarrollo) no hay nada que actualizar.
  if (!st.supported) { clearInterval(upd.poll); return; }
  upd.available = st.available;

  // Banner: solo si hay versión nueva, no se ha descartado y el modal no está abierto.
  const banner = $('#update-banner');
  const showBanner = !!st.available && !upd.dismissed
    && !$('#modal-update').classList.contains('is-open');
  banner.hidden = !showBanner;
  if (st.available) {
    $('#update-banner-text').textContent =
      `Versión ${st.available.version} · ${bytesToMB(st.available.size || 0)}`;
  }

  // Si el modal está abierto, reflejar descarga / error / listo.
  if ($('#modal-update').classList.contains('is-open')) {
    renderUpdateModal(st);
  }

  // Cuando la descarga termina y el usuario ya dio a instalar, aplicar sola.
  if (st.state === 'ready' && upd.applying) {
    upd.applying = false;
    try { await api.post('/api/update/apply'); } catch (e) {
      $('#update-error').hidden = false;
      $('#update-error').textContent = 'No se pudo aplicar: ' + e.message;
    }
  }
}

function renderUpdateModal(st) {
  const downloading = st.state === 'downloading';
  const wrap = $('#update-progress-wrap');
  wrap.hidden = !(downloading || st.state === 'applying');
  if (downloading) {
    const pct = Math.round((st.progress || 0) * 100);
    $('#update-progress-bar').style.width = pct + '%';
    $('#update-progress-label').textContent = `Descargando… ${pct}%`;
  } else if (st.state === 'applying') {
    $('#update-progress-bar').style.width = '100%';
    $('#update-progress-label').textContent = 'Instalando y reiniciando…';
  }
  const err = $('#update-error');
  err.hidden = !st.error;
  if (st.error) err.textContent = st.error;
  // Botón: deshabilitado mientras trabaja.
  const btn = $('#update-install');
  btn.disabled = downloading || st.state === 'applying';
  btn.textContent = downloading ? 'Descargando…'
    : st.state === 'applying' ? 'Reiniciando…' : 'Descargar e instalar';
}

function openUpdateModal() {
  const a = upd.available;
  if (!a) return;
  $('#update-banner').hidden = true;
  $('#update-ver-cur').textContent = 'Actual';
  $('#update-ver-new').textContent = `Versión ${a.version}`;
  $('#update-notes').textContent = a.notes || 'Mejoras y correcciones.';
  $('#update-progress-wrap').hidden = true;
  $('#update-error').hidden = true;
  $('#update-install').disabled = false;
  $('#update-install').textContent = 'Descargar e instalar';
  $('#modal-update').classList.add('is-open');
}

function closeUpdateModal() {
  $('#modal-update').classList.remove('is-open');
}

async function startUpdate() {
  upd.applying = true;   // al terminar la descarga, aplicar automáticamente
  $('#update-error').hidden = true;
  try {
    await api.post('/api/update/download');
  } catch (e) {
    upd.applying = false;
    $('#update-error').hidden = false;
    $('#update-error').textContent = 'No se pudo iniciar la descarga: ' + e.message;
  }
}

function initUpdates() {
  $('#update-go').addEventListener('click', openUpdateModal);
  $('#update-later').addEventListener('click', () => {
    upd.dismissed = true;
    $('#update-banner').hidden = true;
  });
  $('#update-install').addEventListener('click', startUpdate);
  $('#update-modal-close').addEventListener('click', closeUpdateModal);
  $('#update-cancel').addEventListener('click', async () => {
    if (upd.applying) { try { await api.post('/api/update/cancel'); } catch {} upd.applying = false; }
    closeUpdateModal();
  });
  // Primer chequeo enseguida y luego cada 30 s (por si la descarga avanza o
  // aparece una versión más nueva mientras la app sigue abierta).
  updateTick();
  upd.poll = setInterval(updateTick, 30000);
}

document.addEventListener('DOMContentLoaded', () => { init(); initUpdates(); });
