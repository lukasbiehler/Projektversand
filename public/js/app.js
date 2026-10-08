// Einstieg: Routing, Echtzeit-Aktualisierung, Hardware-Scanner, Benutzer
import { h, state, loadMeta, getUser, setUser, formDialog, isEditable, debounce, openCode, toast, feedback, showError, runCleanups, get, post, modal, confirmDialog } from './core.js';
import * as home from './views/home.js';
import * as project from './views/project.js';
import * as hu from './views/hu.js';
import * as delivery from './views/delivery.js';
import * as search from './views/search.js';
import * as materials from './views/materials.js';
import * as settings from './views/settings.js';
import * as scan from './views/scan.js';
import * as loadplan from './views/loadplan.js';

const ROUTES = [
  [/^\/?$/, home, 'home'],
  [/^\/scan$/, scan, 'scan'],
  [/^\/search$/, search, 'search'],
  [/^\/materials$/, materials, 'materials'],
  [/^\/settings$/, settings, 'settings'],
  [/^\/p\/(\d+)(?:\/([a-z]+))?$/, project, 'home'],
  [/^\/hu\/(\d+)$/, hu, 'home'],
  [/^\/d\/(\d+)$/, delivery, 'home'],
  [/^\/lp\/(\d+)$/, loadplan, 'home'],
];

let current = null;
const appEl = document.getElementById('app');
const banner = document.getElementById('banner');

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function route() {
  const { path, query } = parseHash();
  let match = null;
  for (const [rx, view, nav] of ROUTES) {
    const m = path.match(rx);
    if (m) { match = { view, nav, params: m.slice(1) }; break; }
  }
  state.scanHandler = null;
  state.dirty = false;
  banner.hidden = true;
  for (const a of document.querySelectorAll('#mainnav a')) a.classList.toggle('active', a.dataset.nav === (match ? match.nav : ''));
  if (!match) {
    appEl.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'empty' }, 'Seite nicht gefunden. ', h('a', { href: '#/' }, 'Zur Startseite'))));
    return;
  }
  const ctx = {
    root: appEl, params: match.params, query, projectId: null,
    refresh: () => refresh(),
    show(node) { if (current && current.ctx === ctx) { appEl.replaceChildren(node); } },
    alive() { return current && current.ctx === ctx; },
  };
  current = { view: match.view, ctx };
  appEl.replaceChildren(h('p', { class: 'muted' }, 'Wird geladen …'));
  window.scrollTo(0, 0);
  await renderCurrent();
}

async function renderCurrent() {
  const c = current;
  runCleanups();
  try {
    await c.view.render(c.ctx);
  } catch (err) {
    if (current !== c) return;
    appEl.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'empty' },
      h('p', { class: 'err' }, err.message || String(err)), h('p', null, h('a', { href: '#/' }, 'Zur Startseite')))));
  }
}

async function refresh() {
  if (!current) return;
  const y = window.scrollY;
  const active = document.activeElement;
  const scanId = active && active.dataset && active.dataset.scan ? active.id : null;
  state.dirty = false;
  pending = false;
  banner.hidden = true;
  await renderCurrent();
  window.scrollTo(0, y);
  if (scanId) {
    const el = document.getElementById(scanId);
    if (el) {
      // Bereits getippte Zeichen im Scanfeld übernehmen (auch solche, die während des Neuaufbaus dazukamen)
      if (el !== active && active.value) el.value = active.value;
      el.focus({ preventScroll: true });
    }
  }
}

// ------------------------------------------------------------------ Echtzeit (Server-Sent Events)
function canAutoRefresh() {
  const a = document.activeElement;
  if (state.modalOpen > 0 || state.dirty) return false;
  if (isEditable(a) && !(a.dataset && a.dataset.scan) && !(a.dataset && a.dataset.nodirty)) return false;
  return true;
}

function showBanner() {
  banner.replaceChildren(
    h('span', null, 'Es liegen neue Daten von anderen Geräten vor.'),
    h('button', { type: 'button', class: 'btn small', onclick: () => refresh() }, 'Aktualisieren'));
  banner.hidden = false;
}

let pending = false;
const liveRefresh = debounce(() => {
  if (canAutoRefresh()) { refresh(); return; }
  pending = true;
  if (state.modalOpen === 0) showBanner();
}, 350);
window.addEventListener('pv-changed', () => liveRefresh());
window.addEventListener('pv-modal-closed', () => {
  if (pending && state.modalOpen === 0) setTimeout(() => { if (canAutoRefresh()) refresh(); else showBanner(); }, 60);
});

function connectLive() {
  const dot = document.getElementById('live');
  const es = new EventSource('/api/stream');
  es.onopen = () => { dot.classList.add('on'); dot.title = 'Echtzeit-Verbindung aktiv'; };
  es.onerror = () => { dot.classList.remove('on'); dot.title = 'Keine Echtzeit-Verbindung – wird automatisch wiederhergestellt'; };
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    if (d.type !== 'change' || !current) return;
    const pid = current.ctx.projectId;
    if (pid && d.project_id && d.project_id !== pid) return;
    liveRefresh();
  };
}

/** Ohne dauerhafte Verbindung (Demo auf Vercel): Änderungen alle 5 Sekunden abfragen */
function startPolling() {
  const dot = document.getElementById('live');
  let last = null;
  let instance = null;
  const tick = async () => {
    if (document.hidden) return;
    try {
      const r = await get(`/changes?since=${last || 0}`);
      dot.classList.add('on');
      dot.title = 'Aktualisierung alle 5 Sekunden';
      if (instance && r.instance !== instance) { instance = r.instance; last = r.last; liveRefresh(); return; }
      instance = r.instance;
      if (last !== null && r.last !== last) {
        const pid = current && current.ctx.projectId;
        if (!pid || r.last < last || r.projects.includes(pid) || r.projects.includes(null)) liveRefresh();
      }
      last = r.last;
    } catch {
      dot.classList.remove('on');
      dot.title = 'Server nicht erreichbar';
    }
  };
  // Eigene Buchungen aktualisieren die Ansicht bereits selbst – Stand nachziehen, damit die nächste Abfrage
  // die Seite nicht ein zweites Mal neu aufbaut
  window.addEventListener('pv-changed', async () => {
    try {
      const r = await get('/changes');
      if (r.instance === instance && last !== null && r.last > last) last = r.last;
    } catch { /* nächste Abfrage meldet den Fehler */ }
  });
  tick();
  setInterval(tick, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

/** Hinweisleiste der Demo-Version mit Zurücksetzen und Beispieldateien */
function showDemoBanner() {
  const el = document.getElementById('demo-banner');
  const reset = async (mode) => {
    const text = mode === 'empty'
      ? 'Alle Daten löschen und mit einer leeren Demo starten (passend zur Testanleitung)?'
      : 'Alle Daten verwerfen und das Beispielprojekt P-25001 neu laden?';
    if (!(await confirmDialog(text, { ok: 'Zurücksetzen', danger: true }))) return;
    try {
      await post('/demo/reset', { mode });
      location.hash = '#/';
      location.reload();
    } catch (err) { showError(err); }
  };
  const files = [
    ['1_materialstamm.csv', 'Materialstamm (SAP-Materialnummern mit Barcodes)'],
    ['2_sap_projektbedarf.xlsx', 'SAP-Export Projektmaterial (PSP-Elemente)'],
    ['3_packliste_elektrik.csv', 'Excel-Packliste'],
    ['4_ladegut_zusatz.csv', 'Zusätzliches Ladegut für die Ladeplanung'],
  ];
  el.replaceChildren(
    h('span', null, h('b', null, 'Demo-Version'), ' – Daten sind nicht dauerhaft und werden zurückgesetzt. Bitte keine echten Firmendaten eingeben.'),
    h('button', { type: 'button', class: 'btn small', onclick: () => modal({
      title: 'Beispieldateien für den Import',
      body: [h('p', { class: 'hint' }, 'Passend zur Testanleitung (docs/TESTANLEITUNG.md). Für die Anleitung vorher „Leer starten“.'),
        h('ul', null, files.map(([f, d]) => h('li', null, h('a', { href: `/beispieldaten/${f}`, download: f }, f), ` – ${d}`)))],
      actions: [{ label: 'Schließen', cls: 'primary' }],
    }) }, 'Beispieldateien'),
    h('button', { type: 'button', class: 'btn small', onclick: () => reset('sample') }, 'Beispielprojekt neu laden'),
    h('button', { type: 'button', class: 'btn small', onclick: () => reset('empty') }, 'Leer starten'));
  el.hidden = false;
}

// Änderungen in Formularen merken, damit Live-Aktualisierung keine Eingaben verwirft
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!appEl.contains(t)) return;
  if (t.dataset && (t.dataset.scan || t.dataset.nodirty)) return;
  state.dirty = true;
});

// ------------------------------------------------------------------ Hardware-Scanner (Tastatur-Emulation) überall
let buf = '';
let last = 0;
document.addEventListener('keydown', (e) => {
  if (state.modalOpen > 0 || isEditable(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
  const now = performance.now();
  if (now - last > 120) buf = '';
  last = now;
  if (e.key === 'Enter') {
    if (buf.length >= 3) { e.preventDefault(); dispatchScan(buf); }
    buf = '';
  } else if (e.key.length === 1) {
    buf += e.key;
  }
});

async function dispatchScan(code) {
  try {
    if (state.scanHandler) {
      // Ansichten leiten meist an ihr Scanfeld weiter, das selbst Rückmeldung gibt (Rückgabe undefined)
      const res = await state.scanHandler(code);
      if (typeof res === 'boolean') feedback(res);
    } else {
      feedback(await openCode(code));
    }
  } catch (err) {
    feedback(false);
    showError(err);
  }
}

// ------------------------------------------------------------------ Benutzer
function updateUserBtn() {
  const b = document.getElementById('userbtn');
  const u = getUser();
  b.textContent = u ? u : 'Anmelden';
}

function askUser(force) {
  if (getUser() && !force) return;
  formDialog({
    title: 'Wer arbeitet an diesem Gerät?',
    intro: h('p', { class: 'hint' }, 'Der Name wird bei jeder Buchung protokolliert (Rückverfolgbarkeit). Er gilt nur für dieses Gerät.'),
    fields: [{ name: 'user', label: 'Name / Kürzel', value: getUser(), required: true, autofocus: true }],
    submitLabel: 'Übernehmen',
    onSubmit: async (d) => {
      setUser(d.user.slice(0, 60));
      updateUserBtn();
      toast(`Angemeldet als ${d.user}`, 'ok');
    },
  });
}

document.getElementById('userbtn').addEventListener('click', () => askUser(true));

// ------------------------------------------------------------------ Start
(async () => {
  updateUserBtn();
  try {
    await loadMeta();
  } catch (err) {
    appEl.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'empty err' }, err.message)));
    return;
  }
  window.addEventListener('hashchange', route);
  if (state.meta.demo) { showDemoBanner(); startPolling(); } else connectLive();
  await route();
  askUser(false);
})();
