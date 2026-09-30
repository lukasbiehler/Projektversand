// Grundbausteine der Oberfläche: DOM-Aufbau (XSS-sicher über Textknoten), API, Dialoge, Formatierung

export const state = {
  meta: null,
  dirty: false,
  modalOpen: 0,
  scanHandler: null,
  cleanups: [],
};

/** Aufräumarbeit beim Verlassen/Neuzeichnen einer Ansicht registrieren (z. B. 3D-Ansicht freigeben) */
export function onCleanup(fn) { state.cleanups.push(fn); }
export function runCleanups() {
  const list = state.cleanups.splice(0);
  for (const fn of list) { try { fn(); } catch { /* ignorieren */ } }
}

// ------------------------------------------------------------------ DOM
/** Element erzeugen. Kinder-Strings werden immer als Text eingefügt (kein innerHTML). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'multiple' || k === 'required') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  if (value !== undefined) el.value = value;
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svgIcon(name, size = 18) {
  const paths = {
    camera: 'M4 7h3l2-3h6l2 3h3v12H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    scan: 'M3 7V3h4 M17 3h4v4 M21 17v4h-4 M7 21H3v-4 M6 8v8 M9 8v8 M12 8v8 M15 8v8 M18 8v8',
    print: 'M6 9V3h12v6 M6 18H4v-8h16v8h-2 M6 14h12v7H6z',
    plus: 'M12 5v14 M5 12h14',
    box: 'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
    truck: 'M2 6h11v10H2z M13 10h5l3 3v3h-8 M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',
    upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    edit: 'M4 20h4L20 8l-4-4L4 16z',
    check: 'M5 12l5 5 9-10',
    warn: 'M12 3l10 18H2z M12 10v5 M12 18v.5',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || '');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

export function btn(label, onClick, opts = {}) {
  return h('button', {
    type: opts.type || 'button', class: `btn ${opts.cls || ''}`.trim(), onclick: onClick, disabled: opts.disabled, title: opts.title,
  }, opts.icon ? svgIcon(opts.icon) : null, label);
}

// ------------------------------------------------------------------ Benutzer
const USER_KEY = 'projektversand.user';
export function getUser() {
  try { return localStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}
export function setUser(name) {
  try { localStorage.setItem(USER_KEY, name); } catch { /* Speicher nicht verfügbar */ }
}

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(method, url, body) {
  const headers = { 'X-User': encodeURIComponent(getUser() || 'unbekannt') };
  let payload;
  if (body instanceof Blob) { payload = body; headers['Content-Type'] = body.type; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try {
    res = await fetch('/api' + url, { method, headers, body: payload });
  } catch {
    throw new ApiError('Server nicht erreichbar. Bitte Netzwerkverbindung prüfen.', 0, null);
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError((data && data.error) || `Fehler ${res.status}`, res.status, data);
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});
export const put = (url, body) => api('PUT', url, body ?? {});
export const del = (url) => api('DELETE', url);

export async function loadMeta() {
  if (!state.meta) state.meta = await get('/meta');
  return state.meta;
}

// ------------------------------------------------------------------ Formatierung
const nf = (max) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: max });
const NF3 = nf(3);
const NF1 = nf(1);
export const fmt = {
  num: (n, max = 3) => (n === null || n === undefined || n === '' ? '–' : (max === 3 ? NF3 : max === 1 ? NF1 : nf(max)).format(n)),
  qty: (n, unit) => `${fmt.num(n)} ${unit || ''}`.trim(),
  kg: (n) => (n === null || n === undefined ? '–' : `${NF1.format(n)} kg`),
  dims: (h) => (h.length_cm && h.width_cm && h.height_cm ? `${NF1.format(h.length_cm)} × ${NF1.format(h.width_cm)} × ${NF1.format(h.height_cm)} cm` : '–'),
  date: (iso) => (iso ? new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('de-DE') : '–'),
  dt: (iso) => (iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'),
};

export function chip(key, label) {
  return h('span', { class: `chip s-${key}` }, label || key);
}

// ------------------------------------------------------------------ Meldungen & Rückmeldung
export function toast(msg, type = 'info', ms = 3800) {
  const t = h('div', { class: `toast ${type}`, role: type === 'bad' ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), type === 'bad' ? Math.max(ms, 6000) : ms);
}

let audioCtx = null;
/** Akustische / haptische Rückmeldung beim Scannen */
export function feedback(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 1320 : 220;
    o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + (ok ? 0.09 : 0.35));
  } catch { /* kein Audio */ }
  try { navigator.vibrate?.(ok ? 40 : [80, 60, 80]); } catch { /* keine Vibration */ }
}

export function showError(err) {
  toast(err && err.message ? err.message : String(err), 'bad');
}

// ------------------------------------------------------------------ Dialoge
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const bodyEl = h('div', { class: 'body' }, body);
  const footer = h('footer');
  const dlg = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, h('h2', null, title), btn('Schließen', () => close(), { cls: 'ghost small' })),
    bodyEl, footer);
  const back = h('div', { class: 'backdrop' }, dlg);
  let closed = false;
  const prevFocus = document.activeElement;
  function close(result) {
    if (closed) return;
    closed = true;
    back.remove();
    state.modalOpen -= 1;
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch { /* ignorieren */ }
    onClose?.(result);
    window.dispatchEvent(new Event('pv-modal-closed'));
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  for (const a of actions) {
    const b = btn(a.label, async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { await a.onClick(close, b); } catch (err) { showError(err); } finally { b.disabled = false; }
    }, { cls: a.cls || '', icon: a.icon });
    footer.append(b);
  }
  if (!actions.length) footer.hidden = true;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  state.modalOpen += 1;
  setTimeout(() => {
    const f = dlg.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]), select, textarea');
    (f || dlg.querySelector('footer .btn') || dlg).focus?.();
  }, 30);
  return { close, el: dlg, body: bodyEl, footer };
}

export function confirmDialog(message, { ok = 'OK', danger = false, title = 'Bitte bestätigen' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('p', null, message),
      actions: [
        { label: 'Abbrechen' },
        { label: ok, cls: danger ? 'danger' : 'primary', onClick: (close) => { result = true; close(); } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Formular-Dialog: fields = [{name, label, type, value, options, required, hint, wide, step, min}] */
export function formDialog({ title, fields, submitLabel = 'Speichern', onSubmit, wide = false, intro }) {
  const form = h('form', { class: 'form-grid', novalidate: true });
  const controls = {};
  for (const f of fields) {
    let ctl;
    if (f.type === 'select') {
      ctl = h('select', { name: f.name, id: `f-${f.name}` },
        (f.options || []).map((o) => h('option', { value: o.value }, o.label)));
      ctl.value = f.value ?? (f.options?.[0]?.value ?? '');
    } else if (f.type === 'textarea') {
      ctl = h('textarea', { name: f.name, id: `f-${f.name}`, rows: 3 });
      ctl.value = f.value ?? '';
    } else if (f.type === 'checkbox') {
      ctl = h('input', { type: 'checkbox', name: f.name, id: `f-${f.name}`, checked: !!f.value });
    } else {
      ctl = h('input', {
        type: f.type || 'text', name: f.name, id: `f-${f.name}`, step: f.step, min: f.min, inputmode: f.inputmode,
        placeholder: f.placeholder, autocomplete: 'off', list: f.list,
      });
      ctl.value = f.value ?? '';
    }
    if (f.autofocus) ctl.setAttribute('autofocus', '');
    controls[f.name] = ctl;
    const lbl = f.type === 'checkbox'
      ? h('label', { class: `field inline${f.wide ? ' wide' : ''}` }, ctl, f.label, f.hint ? h('span', { class: 'hint' }, f.hint) : null)
      : h('label', { class: `field${f.wide ? ' wide' : ''}` }, f.label + (f.required ? ' *' : ''), ctl, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    form.append(lbl);
  }
  const errBox = h('p', { class: 'err', hidden: true });
  const submitBtn = h('button', { type: 'submit', hidden: true });
  form.append(submitBtn);
  let m;
  const read = () => {
    const out = {};
    for (const f of fields) {
      const c = controls[f.name];
      if (f.type === 'checkbox') out[f.name] = c.checked;
      else if (f.type === 'number') out[f.name] = c.value === '' ? null : Number(c.value);
      else out[f.name] = c.value.trim();
    }
    return out;
  };
  const submit = async (close, b) => {
    errBox.hidden = true;
    const data = read();
    for (const f of fields) {
      if (f.required && (data[f.name] === '' || data[f.name] === null)) {
        errBox.textContent = `Bitte „${f.label}“ ausfüllen.`;
        errBox.hidden = false;
        controls[f.name].focus();
        return;
      }
      if (f.type === 'number' && controls[f.name].value !== '' && !Number.isFinite(data[f.name])) {
        errBox.textContent = `„${f.label}“ ist keine gültige Zahl.`;
        errBox.hidden = false;
        return;
      }
    }
    try {
      await onSubmit(data, controls);
      close();
      notifyChanged();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      feedback(false);
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); m.footer.querySelector('.btn.primary')?.click(); });
  m = modal({
    title, wide,
    body: [intro || null, form, errBox],
    actions: [{ label: 'Abbrechen' }, { label: submitLabel, cls: 'primary', onClick: submit }],
  });
  return { ...m, controls };
}

// ------------------------------------------------------------------ Skripte nachladen (Barcode, Excel, Kamera)
const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete scripts[src]; reject(new Error(`Komponente konnte nicht geladen werden (${src}).`)); };
      document.head.append(s);
    });
  }
  return scripts[src];
}

// ------------------------------------------------------------------ Scannen
/** Aktiven Scan-Empfänger der Ansicht setzen (Hardware-Scanner / Kamera). null = globale Suche */
export function setScanHandler(fn) { state.scanHandler = fn; }

export function isEditable(el) {
  return !!(el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]'));
}

/** Download einer Datei aus einem Blob */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function optionList(obj, { empty } = {}) {
  const list = Object.entries(obj).map(([value, label]) => ({ value, label }));
  return empty !== undefined ? [{ value: '', label: empty }, ...list] : list;
}

/** Eigene Änderung melden → aktuelle Ansicht wird aktualisiert (zusätzlich zur Echtzeit-Meldung des Servers) */
export function notifyChanged() {
  window.dispatchEvent(new Event('pv-changed'));
}

// ------------------------------------------------------------------ Navigation
export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** Beliebigen Code (Packstück, Lieferung, Material, PSP, Projekt) auflösen und passende Ansicht öffnen */
export async function openCode(code, projectId) {
  const r = await get(`/resolve?code=${encodeURIComponent(code)}${projectId ? `&project_id=${projectId}` : ''}`);
  switch (r.kind) {
    case 'hu': go(`#/hu/${r.id}`); return true;
    case 'delivery': go(`#/d/${r.id}`); return true;
    case 'material': go(`#/search?q=${encodeURIComponent(r.material_number)}`); return true;
    case 'psp': go(`#/search?q=${encodeURIComponent(r.code)}&p=${r.project_id}`); return true;
    case 'project': go(`#/p/${r.id}`); return true;
    default:
      toast(r.label, 'bad');
      return false;
  }
}
