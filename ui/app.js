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

const api = {
  async get(url) {
    const r = await fetch(withDocId(url));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(withDocId(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
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
const pageCount = () => (inDoc() ? state.doc.count : state.pages.length);

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
    t = { id: info.docId, doc: info, fileName: info.name, activePage: 1, pageSize: null };
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
  state.activeTabId = id;
  state.selected = null;
  state.ctx = null;
  syncMirror();
  const t = activeTab();
  if (t) {
    try {
      t.pageSize = await api.get(`/api/pagesize/${t.activePage - 1}`);
    } catch { t.pageSize = null; }
    state.pageSize = t.pageSize;
  }
  render();
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

async function changePage(n) {
  const t = activeTab();
  state.activePage = n;
  if (t) t.activePage = n;
  state.selected = null;
  state.ctx = null;
  if (inDoc()) {
    try {
      state.pageSize = await api.get(`/api/pagesize/${n - 1}`);
      if (t) t.pageSize = state.pageSize;
    } catch { state.pageSize = null; }
  }
  render();
}

/* ===== Render ===== */
function render() {
  renderTitlebar();
  renderTabs();
  renderPanels();
  renderPages();
  renderDoc();
  renderContextMenus();
  renderTools();
  renderZoom();
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
          `<img class="page-thumb-img" loading="lazy" src="${imgUrl(`/api/thumb/${i}?r=${state.doc.rev}`)}" alt="Página ${n}">` +
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

let pageQualityTimer = null;
let loadedPageKey = '';
let loadedTextKey = '';

function renderDoc() {
  const real = inDoc();
  $('#demo-doc').hidden = real;
  $('#real-doc').hidden = !real;
  if (real) {
    // Resolución de render acorde al zoom (nítido al acercar): 100%→2x … 300%→6x
    const targetScale = Math.min(6, Math.max(2, Math.ceil(state.zoom / 50)));
    const img = $('#page-image');
    const key = `${state.activeTabId}|${state.activePage - 1}|${state.doc.rev}`;
    const baseSrc = imgUrl(`/api/page/${state.activePage - 1}?r=${state.doc.rev}`);
    if (loadedPageKey !== key) {
      // Página o revisión nueva: carga inmediata
      loadedPageKey = key;
      img.dataset.scale = targetScale;
      img.src = `${baseSrc}&scale=${targetScale}`;
    } else if (Number(img.dataset.scale || 0) < targetScale) {
      // Solo se sube la calidad (nunca se baja: evita recargas al alejar)
      clearTimeout(pageQualityTimer);
      pageQualityTimer = setTimeout(() => {
        img.dataset.scale = targetScale;
        img.src = `${baseSrc}&scale=${targetScale}`;
      }, 220);
    }
    const overlay = $('#annot-overlay');
    const drawing = state.tool !== 'select';
    overlay.style.pointerEvents = drawing ? 'auto' : 'none';
    overlay.classList.toggle('is-drawing', drawing);
    // Capa de texto seleccionable: se reconstruye al cambiar de página/revisión.
    const tl = $('#text-layer');
    tl.classList.toggle('is-select', !drawing);
    if (drawing) hideSelPopup();
    if (loadedTextKey !== key) {
      loadedTextKey = key;
      loadTextLayer(state.activePage - 1, key);
    }
    return;
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

function renderZoom() {
  const zf = state.zoom / 100;
  const scaleEl = $('#page-scale');
  scaleEl.style.transform = `scale(${zf})`;
  // El transform no afecta al layout: dimensionar el contenedor para que el
  // área de scroll coincida con el tamaño visual y el centrado sea correcto.
  const margin = $('#page-margin');
  margin.style.width = Math.round(PAGE_DISPLAY_WIDTH * zf) + 'px';
  margin.style.height = Math.round(scaleEl.offsetHeight * zf) + 'px';
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
  let ocrOn, changes;
  if (inDoc()) {
    ocrOn = state.ocrDone;
    changes = state.doc.dirty ? 'Cambios sin guardar' : 'Sin cambios pendientes';
  } else {
    const pageInfo = state.pages[state.activePage - 1] || {};
    ocrOn = state.ocrDone || !!pageInfo.ocr;
    changes = `${state.editedIds.length} ediciones · ${state.movedLogo ? 1 : 0} imagen movida · 3 anotaciones`;
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
      `<img loading="lazy" src="${imgUrl(`/api/thumb/${i}?r=${state.doc.rev}`)}" alt="Página ${i + 1}">` +
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
const previewState = { page: 0 };

function previewOpen() {
  return !$('#page-preview').hidden;
}

function renderPagePreview() {
  const i = previewState.page;
  const count = state.doc.count;
  $('#preview-img').src = imgUrl(`/api/page/${i}?r=${state.doc.rev}&scale=3`);
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
  const next = Math.max(220, Math.min(img.naturalWidth * 2, Math.round(current * factor)));
  body.classList.add('is-zoomed');
  img.style.width = next + 'px';
  const nrect = img.getBoundingClientRect();
  body.scrollLeft += (nrect.left + fx * nrect.width) - e.clientX;
  body.scrollTop += (nrect.top + fy * nrect.height) - e.clientY;
}

function openPagePreview(i) {
  previewState.page = i;
  resetPreviewZoom();
  $('#page-preview').hidden = false;
  renderPagePreview();
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

/* ===== OCR / texto ===== */
async function runOcr(closeModal) {
  if (inDoc()) {
    try {
      const scope = state.ocrScope === 'doc' ? 'doc' : 'pg';
      const r = await api.get(`/api/text?scope=${scope}&page=${state.activePage - 1}`);
      $('#ocr-text').value = r.text || '(No se encontró texto en el documento)';
      setState({ ocrDone: true, modal: closeModal ? null : state.modal, rightTab: 'ocr' });
      toast('Texto extraído del documento');
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
const draw = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };

function overlayLocalPoint(e) {
  const rect = $('#annot-overlay').getBoundingClientRect();
  const zf = state.zoom / 100;
  return {
    x: (e.clientX - rect.left) / zf,
    y: (e.clientY - rect.top) / zf,
  };
}

function toPdfPoint(p) {
  const img = $('#page-image');
  const w = state.pageSize ? state.pageSize.width : PAGE_DISPLAY_WIDTH;
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
  const a = toPdfPoint({ x: draw.x0, y: draw.y0 });
  const b = toPdfPoint({ x: draw.x1, y: draw.y1 });
  const rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  const body = {
    page: state.activePage - 1,
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
  const a = toPdfPoint({ x: draw.x0, y: draw.y0 });
  const b = toPdfPoint({ x: draw.x1, y: draw.y1 });
  const rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  try {
    const info = await api.post('/api/sign', {
      page: state.activePage - 1,
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
  const overlay = $('#annot-overlay');
  const input = $('#annot-text-input');

  overlay.addEventListener('pointerdown', e => {
    if (!inDoc() || state.tool === 'select' || !input.hidden) return;
    e.preventDefault();
    const p = overlayLocalPoint(e);
    draw.active = true;
    draw.x0 = draw.x1 = p.x;
    draw.y0 = draw.y1 = p.y;
    overlay.setPointerCapture(e.pointerId);
    ghostUpdate();
  });

  overlay.addEventListener('pointermove', e => {
    if (!draw.active) return;
    const p = overlayLocalPoint(e);
    draw.x1 = p.x; draw.y1 = p.y;
    ghostUpdate();
  });

  overlay.addEventListener('pointerup', async e => {
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
let textLayerHasText = false;

async function loadTextLayer(index, key) {
  const tl = $('#text-layer');
  tl.innerHTML = '';
  textLayerHasText = false;
  hideSelPopup();
  let data;
  try {
    data = await api.get(`/api/words/${index}`);
  } catch { return; }
  // La respuesta puede llegar tarde: ignorar si ya cambiamos de página/pestaña.
  if (loadedTextKey !== key) return;
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
  textLayerHasText = spans.length > 0;
}

// Recuadros de la selección actual convertidos a puntos PDF (uno por renglón).
function selectionQuads() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const tl = $('#text-layer');
  if (!tl.contains(sel.anchorNode) || !tl.contains(sel.focusNode)) return null;
  const tlRect = tl.getBoundingClientRect();
  if (!tlRect.width) return null;
  const pw = state.pageSize ? state.pageSize.width : PAGE_DISPLAY_WIDTH;
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
  return quads.length ? quads : null;
}

function hideSelPopup() {
  const p = $('#sel-popup');
  if (p && !p.hidden) p.hidden = true;
}

function showSelPopup() {
  if (!inDoc() || state.tool !== 'select') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelPopup(); return; }
  const tl = $('#text-layer');
  if (!tl.contains(sel.anchorNode)) { hideSelPopup(); return; }
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
  const quads = selectionQuads();
  if (!quads) { toast('Selecciona texto del documento primero'); return; }
  try {
    const info = await api.post('/api/annot', {
      page: state.activePage - 1,
      kind,
      color: color || state.annotColor,
      opacity: parseFloat($('#slider-opacity').value) / 100,
      quads,
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
  const tl = $('#text-layer');
  const popup = $('#sel-popup');
  // Mostrar el menú al terminar de arrastrar una selección.
  tl.addEventListener('mouseup', () => setTimeout(showSelPopup, 0));
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
  window.__openExternal = async (ids) => {
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
  };

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

  // Zoom
  const zoomBy = d => setState({ zoom: Math.max(40, Math.min(300, state.zoom + d)) });
  $('#btn-zoom-in').addEventListener('click', () => zoomBy(10));
  $('#btn-zoom-out').addEventListener('click', () => zoomBy(-10));
  $('#btn-zoom-fit').addEventListener('click', () => setState({ zoom: 100 }));

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

  // La altura del lienzo cambia cuando carga la imagen de página
  $('#page-image').addEventListener('load', renderZoom);

  // Rueda sin Ctrl en el borde del documento: pasar de página
  let pageTurnAt = 0;
  $('#canvas-scroll').addEventListener('wheel', e => {
    if (e.ctrlKey) return;
    const sc = $('#canvas-scroll');
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
    const atTop = sc.scrollTop <= 2;
    const now = Date.now();
    if (e.deltaY > 0 && atBottom && state.activePage < pageCount()) {
      e.preventDefault();
      if (now - pageTurnAt < 450) return; // amortigua la inercia del scroll
      pageTurnAt = now;
      changePage(state.activePage + 1).then(() => { sc.scrollTop = 0; });
    } else if (e.deltaY < 0 && atTop && state.activePage > 1) {
      e.preventDefault();
      if (now - pageTurnAt < 450) return;
      pageTurnAt = now;
      changePage(state.activePage - 1).then(() => { sc.scrollTop = sc.scrollHeight; });
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
      if (!docs.length) return;
      for (const info of docs) upsertTab(info, { resetPage: true });
      await activateTab(docs[0].docId);
      await enterReadingMode();
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
