// Projekt-Cockpit: Übersicht, Packvorrat, Packstücke (HUs), Lieferungen, Fehlteile/Nachlieferungen, Verlauf, Stammdaten
import {
  h, get, post, put, del, state, btn, chip, fmt, toast, formDialog, confirmDialog, go, openCode, setScanHandler, optionList, showError, notifyChanged,
} from '../core.js';
import { openLabelDialog } from '../labels.js';
import { openImportWizard } from '../importer.js';
import { scanField } from '../scanner.js';

const TABS = [
  ['overview', 'Übersicht'],
  ['items', 'Packvorrat'],
  ['hus', 'Packstücke'],
  ['deliveries', 'Lieferungen'],
  ['loadplans', 'Ladeplanung'],
  ['shortages', 'Fehlteile & Nachlieferungen'],
  ['history', 'Verlauf'],
  ['master', 'Stammdaten'],
];

const filters = new Map(); // je Projekt: Filter + Auswahl bleiben bei Aktualisierung erhalten
function F(pid) {
  if (!filters.has(pid)) filters.set(pid, { q: '', status: '', psp: '', source: '', openOnly: false, sel: new Set(), huStatus: '', huQ: '' });
  return filters.get(pid);
}

export async function render(ctx) {
  const pid = Number(ctx.params[0]);
  const tab = TABS.some(([k]) => k === ctx.params[1]) ? ctx.params[1] : 'overview';
  ctx.projectId = pid;
  const p = await get(`/projects/${pid}`);
  const s = p.summary;
  const counts = { items: s.positions, hus: s.hu_total, deliveries: s.deliveries, shortages: s.positions_missing };

  const field = scanField({
    big: false, id: 'proj-scan', autofocus: false,
    placeholder: 'Scannen: Packstück, Lieferung, Material …',
    onScan: (code) => openCode(code, pid),
  });
  setScanHandler((code) => { field.run(code); });

  const head = h('div', { class: 'page-head' },
    h('div', { class: 'titles' },
      h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projekte'), '›', h('span', null, 'Projekt')),
      h('h1', null, h('span', { class: 'mono' }, p.number), p.name ? ` · ${p.name}` : ''),
      h('p', { class: 'muted' }, [p.customer, p.destination].filter(Boolean).join(' · ') || 'Kein Kunde / Zielort hinterlegt')),
    h('div', { style: { flex: '1 1 320px', maxWidth: '520px' } }, field));

  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Projektbereiche' },
    TABS.map(([k, label]) => h('a', { href: `#/p/${pid}/${k}`, class: k === tab ? 'active' : '' }, label,
      counts[k] !== undefined ? h('span', { class: 'count muted' }, `(${counts[k]})`) : null)));

  const body = await TAB_RENDER[tab](p, ctx);
  ctx.show(h('div', { class: 'stack', style: { gap: '16px' } }, head, tabs, body));
}

// ================================================================== Übersicht
function distribution(counts, labels) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return h('div', { class: 'stack' },
    h('div', { class: 'dist', role: 'img', 'aria-label': 'Statusverteilung' },
      Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => h('span', { class: `c-${k}`, style: { width: `${(n / total) * 100}%` }, title: `${labels[k]}: ${n}` }))),
    h('div', { class: 'legend' }, Object.entries(counts).map(([k, n]) => h('div', { class: n ? '' : 'muted' }, h('i', { class: `c-${k}` }), labels[k], h('b', null, n)))));
}

async function renderOverview(p) {
  const s = p.summary;
  const meta = state.meta;
  const events = await get(`/events?project_id=${p.id}&limit=12`);
  return h('div', { class: 'stack', style: { gap: '18px' } },
    h('div', { class: 'kpis' },
      kpi('Verpackungsfortschritt', `${fmt.num(s.progress_pct, 1)} %`, h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, s.progress_pct)}%` } }))),
      kpi('Positionen vollständig verpackt', h('span', null, s.positions_complete, h('small', null, ` / ${s.positions}`))),
      kpi('Offene Fehlteile', s.positions_missing, null, s.positions_missing > 0),
      kpi('Packstücke (äußere)', s.hu_top, h('span', { class: 'small muted' }, `${s.hu_total} inkl. verschachtelter`)),
      kpi('Lieferungen', s.deliveries, h('span', { class: 'small muted' }, `davon ${s.supplementary_deliveries} Nachlieferung(en)`)),
      kpi('Bilder', s.photos)),
    h('div', { class: 'grid-2' },
      panel('Materialstatus (Positionen)', distribution(s.item_status, meta.item_status)),
      panel('Packstückstatus (äußere Packstücke)', distribution(s.hu_status, meta.hu_status))),
    h('div', { class: 'grid-2' },
      panel('Schnellzugriff', h('div', { class: 'row' },
        btn('Packvorrat importieren', () => openImportWizard({ mode: 'items', projectId: p.id, onDone: () => go(`#/p/${p.id}/items`) }), { icon: 'upload' }),
        btn('Neues Packstück', () => newHuDialog(p), { icon: 'box', cls: 'primary' }),
        btn('Neue Lieferung', () => newDeliveryDialog(p), { icon: 'truck' }))),
      panel('Letzte Aktivitäten', eventsTable(events, { compact: true }), h('a', { href: `#/p/${p.id}/history`, class: 'small' }, 'Gesamter Verlauf'))));
}

function kpi(label, value, extra, alert) {
  return h('div', { class: `kpi${alert ? ' alert' : ''}` }, h('span', { class: 'label-caps' }, label), h('span', { class: 'v' }, value), extra);
}

function panel(title, ...content) {
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, title)), h('div', { class: 'panel-body' }, content));
}

// ================================================================== Packvorrat
async function renderItems(p, ctx) {
  const meta = state.meta;
  const f = F(p.id);
  const items = await get(`/projects/${p.id}/items`);
  const ids = new Set(items.map((i) => i.id));
  for (const id of [...f.sel]) if (!ids.has(id)) f.sel.delete(id);

  const matches = (i) => {
    if (f.status && i.status !== f.status) return false;
    if (f.psp && String(i.psp_id || '') !== f.psp) return false;
    if (f.source && i.source !== f.source) return false;
    if (f.openOnly && i.qty_open <= 0) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      if (![i.material_number, i.description, i.psp_code, i.supplier, i.purchase_order, i.source_ref].some((v) => String(v || '').toLowerCase().includes(q))) return false;
    }
    return true;
  };
  const visible = items.filter(matches);

  const rerender = () => ctx.refresh();
  const filterInput = (el, key, isCheck) => {
    el.dataset.nodirty = '1';
    el.addEventListener(isCheck ? 'change' : 'input', () => { f[key] = isCheck ? el.checked : el.value; if (isCheck || el.tagName === 'SELECT') rerender(); else debouncedRerender(); });
    return el;
  };
  let t;
  const debouncedRerender = () => { clearTimeout(t); t = setTimeout(async () => { await rerender(); document.getElementById('it-q')?.focus(); }, 300); };

  const toolbar = h('div', { class: 'row' },
    filterInput(h('input', { type: 'search', id: 'it-q', placeholder: 'Suche Material, Text, PSP, Lieferant …', value: f.q, style: { maxWidth: '280px' } }), 'q'),
    filterInput(h('select', { id: 'it-status', value: f.status, style: { maxWidth: '220px' } }, optionList(meta.item_status, { empty: 'Alle Status' }).map((o) => h('option', { value: o.value }, o.label))), 'status'),
    filterInput(h('select', { id: 'it-psp', value: f.psp, style: { maxWidth: '220px' } }, h('option', { value: '' }, 'Alle PSP-Elemente'),
      p.psp.map((x) => h('option', { value: String(x.id) }, x.code))), 'psp'),
    filterInput(h('select', { id: 'it-src', value: f.source, style: { maxWidth: '200px' } }, optionList(meta.item_sources, { empty: 'Alle Quellen' }).map((o) => h('option', { value: o.value }, o.label))), 'source'),
    h('label', { class: 'field inline' }, filterInput(h('input', { type: 'checkbox', id: 'it-open', checked: f.openOnly }), 'openOnly', true), 'nur offene'));

  const selected = () => items.filter((i) => f.sel.has(i.id));
  const actions = h('div', { class: 'row' },
    btn('Position ergänzen', () => itemDialog(p, 'MANUELL'), { icon: 'plus' }),
    btn('Lieferantenmaterial', () => itemDialog(p, 'LIEFERANT'), { icon: 'plus' }),
    btn('Import (Excel / SAP)', () => openImportWizard({ mode: 'items', projectId: p.id, onDone: rerender }), { icon: 'upload', cls: 'primary' }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted small' }, `${f.sel.size} ausgewählt`),
    btn('Status setzen', () => statusDialog(selected()), { disabled: !f.sel.size }),
    btn('Artikeletiketten', () => openLabelDialog(selected().map((i) => ({ kind: 'item', item_id: i.id }))), { icon: 'print', disabled: !f.sel.size }));

  const allBox = h('input', { type: 'checkbox', 'aria-label': 'Alle sichtbaren auswählen', 'data-nodirty': '1', checked: visible.length > 0 && visible.every((i) => f.sel.has(i.id)) });
  allBox.addEventListener('change', () => { for (const i of visible) { if (allBox.checked) f.sel.add(i.id); else f.sel.delete(i.id); } rerender(); });

  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, allBox), h('th', null, 'Material'), h('th', null, 'PSP-Element'), h('th', null, 'Quelle'),
      h('th', { class: 'num' }, 'Soll'), h('th', { class: 'num' }, 'Verpackt'), h('th', { class: 'num' }, 'Offen'), h('th', { class: 'num' }, 'Fehlmenge'),
      h('th', null, 'Status'), h('th', null, 'Packstücke'), h('th', null, ''))),
    h('tbody', null, visible.map((i) => {
      const cb = h('input', { type: 'checkbox', 'data-nodirty': '1', checked: f.sel.has(i.id), 'aria-label': `Position ${i.material_number} auswählen` });
      cb.addEventListener('change', () => { if (cb.checked) f.sel.add(i.id); else f.sel.delete(i.id); rerender(); });
      return h('tr', { class: f.sel.has(i.id) ? 'sel' : '' },
        h('td', null, cb),
        h('td', null, h('div', { class: 'mono' }, i.material_number), h('div', { class: 'sub' }, i.description)),
        h('td', { class: 'mono nowrap' }, i.psp_code || '–'),
        h('td', null, h('div', { class: 'small' }, i.source_label), i.supplier ? h('div', { class: 'sub' }, i.supplier, i.purchase_order ? ` · Best. ${i.purchase_order}` : '') : null,
          i.source_ref ? h('div', { class: 'sub' }, i.source_ref) : null),
        h('td', { class: 'num' }, fmt.qty(i.qty_required, i.unit)),
        h('td', { class: 'num' }, fmt.num(i.qty_packed)),
        h('td', { class: 'num' }, i.qty_open > 0 ? h('b', null, fmt.num(i.qty_open)) : '0'),
        h('td', { class: 'num' }, i.qty_missing_eff > 0 ? h('b', { style: { color: 'var(--s-miss-fg)' } }, fmt.num(i.qty_missing_eff)) : '–'),
        h('td', null, chip(i.status, i.status_label)),
        h('td', { class: 'small' }, i.placements.length ? i.placements.map((pl) => h('div', null, h('a', { href: `#/hu/${pl.hu_id}`, class: 'mono' }, pl.package_number), ` (${fmt.num(pl.qty)})`)) : '–'),
        h('td', { class: 'nowrap' },
          btn('Bearbeiten', () => editItemDialog(p, i), { cls: 'small ghost' }),
          btn('Fehlteil', () => missingDialog(i), { cls: 'small ghost', disabled: i.qty_open <= 0 && i.qty_missing_eff <= 0 }),
          btn('Etikett', () => openLabelDialog([{ kind: 'item', item_id: i.id }]), { cls: 'small ghost' }),
          btn('Löschen', () => deleteItem(i), { cls: 'small ghost danger', disabled: i.qty_packed > 0 })));
    }))));

  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Packvorrat (${visible.length} von ${items.length} Positionen)`), actions),
    h('div', { class: 'panel-body' }, toolbar),
    h('div', { class: 'panel-body flush' }, items.length ? table : h('div', { class: 'empty' },
      'Der Packvorrat ist leer. Importieren Sie die Excel-Packliste bzw. den SAP-Export der PSP-Elemente oder ergänzen Sie Positionen manuell.')));
}

function pspOptions(p, empty = '— ohne PSP-Element —') {
  return [{ value: '', label: empty }, ...p.psp.map((x) => ({ value: String(x.id), label: `${x.code}${x.description ? ' – ' + x.description : ''}` }))];
}

function itemDialog(p, source) {
  const supplier = source === 'LIEFERANT';
  const d = formDialog({
    title: supplier ? 'Lieferantenmaterial ergänzen' : 'Position manuell ergänzen',
    intro: h('p', { class: 'hint' }, 'Materialnummer wie in SAP. Ist das Material nicht im Materialstamm, wird es mit der Bezeichnung lokal angelegt.'),
    fields: [
      { name: 'material_number', label: 'Materialnummer', required: true, autofocus: true },
      { name: 'description', label: 'Bezeichnung', hint: 'Leer = Bezeichnung aus dem Materialstamm' },
      { name: 'qty_required', label: 'Menge', type: 'number', step: 'any', min: 0, required: true, value: 1 },
      { name: 'unit', label: 'Mengeneinheit', placeholder: 'ST', hint: 'Leer = Einheit aus dem Materialstamm' },
      { name: 'psp_id', label: 'PSP-Element', type: 'select', options: pspOptions(p) },
      ...(supplier ? [
        { name: 'supplier', label: 'Lieferant', required: true },
        { name: 'purchase_order', label: 'Bestellnummer' },
        { name: 'barcode', label: 'Barcode des Lieferanten', hint: 'Wird dem Material zugeordnet, damit das Lieferantenetikett scannbar ist' },
      ] : []),
      { name: 'note', label: 'Bemerkung', type: 'textarea', wide: true },
    ],
    submitLabel: 'Hinzufügen',
    onSubmit: async (v) => {
      await post(`/projects/${p.id}/items`, { ...v, source, psp_id: v.psp_id ? Number(v.psp_id) : null });
      toast('Position hinzugefügt.', 'ok');
    },
  });
  const matInput = d.controls.material_number;
  const info = h('span', { class: 'hint' });
  matInput.parentElement.append(info);
  matInput.addEventListener('change', async () => {
    info.textContent = '';
    const nr = matInput.value.trim();
    if (!nr) return;
    try {
      const m = await get(`/materials/${encodeURIComponent(nr)}`);
      info.textContent = `Im Materialstamm: ${m.description} (${m.unit})${m.barcodes.length ? ' · Barcode ' + m.barcodes[0].barcode : ''}`;
    } catch {
      info.textContent = 'Nicht im Materialstamm – bitte Bezeichnung angeben.';
    }
  });
}

function editItemDialog(p, i) {
  formDialog({
    title: `Position ${i.material_number} bearbeiten`,
    intro: h('p', { class: 'hint' }, `${i.source_label}${i.source_ref ? ' · ' + i.source_ref : ''} · verpackt: ${fmt.qty(i.qty_packed, i.unit)}`),
    fields: [
      { name: 'description', label: 'Bezeichnung', value: i.description, wide: true },
      { name: 'qty_required', label: 'Sollmenge', type: 'number', step: 'any', min: 0, value: i.qty_required, required: true },
      { name: 'unit', label: 'Mengeneinheit', value: i.unit, hint: i.qty_packed > 0 ? 'Nach dem Verpacken nicht mehr änderbar' : '' },
      { name: 'psp_id', label: 'PSP-Element', type: 'select', options: pspOptions(p), value: i.psp_id ? String(i.psp_id) : '' },
      { name: 'supplier', label: 'Lieferant', value: i.supplier },
      { name: 'purchase_order', label: 'Bestellnummer', value: i.purchase_order },
      { name: 'note', label: 'Bemerkung', type: 'textarea', value: i.note, wide: true },
    ],
    onSubmit: async (v) => {
      await put(`/items/${i.id}`, { ...v, psp_id: v.psp_id ? Number(v.psp_id) : null });
      toast('Position gespeichert.', 'ok');
    },
  });
}

export function missingDialog(i) {
  formDialog({
    title: `Fehlteil melden: ${i.material_number}`,
    intro: h('p', { class: 'hint' }, `${i.description} · offen: ${fmt.qty(i.qty_open, i.unit)}. Fehlmenge 0 hebt die Meldung auf. Beim späteren Verpacken wird die Fehlmenge automatisch reduziert.`),
    fields: [
      { name: 'qty_missing', label: `Fehlmenge (${i.unit})`, type: 'number', step: 'any', min: 0, value: i.qty_missing_eff || i.qty_open, required: true, autofocus: true },
      { name: 'expected', label: 'Voraussichtlich verfügbar', type: 'date', value: i.missing_expected },
      { name: 'reason', label: 'Grund', value: i.missing_reason, wide: true, placeholder: 'z. B. noch in Montage / Fertigung, Lieferverzug' },
    ],
    onSubmit: async (v) => {
      await post(`/items/${i.id}/missing`, v);
      toast(v.qty_missing > 0 ? 'Fehlteil gemeldet.' : 'Fehlteil aufgehoben.', 'ok');
    },
  });
}

function statusDialog(items) {
  const meta = state.meta;
  formDialog({
    title: `Status für ${items.length} Position(en) setzen`,
    intro: h('p', { class: 'hint' }, 'Vorstufen vor dem Verpacken. „Fehlteil vorhanden“ entsteht über die Fehlteilmeldung; Verpackungs- und Versandstatus ergeben sich automatisch aus den Packstücken.'),
    fields: [{ name: 'status', label: 'Status', type: 'select', options: meta.base_status.map((k) => ({ value: k, label: meta.item_status[k] })) }],
    submitLabel: 'Setzen',
    onSubmit: async (v) => {
      await post('/items/status', { ids: items.map((i) => i.id), status: v.status });
      toast('Status gesetzt.', 'ok');
    },
  });
}

async function deleteItem(i) {
  if (!(await confirmDialog(`Position ${i.material_number} (${fmt.qty(i.qty_required, i.unit)}) aus dem Packvorrat löschen?`, { ok: 'Löschen', danger: true }))) return;
  try { await del(`/items/${i.id}`); toast('Position gelöscht.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
}

// ================================================================== Packstücke
async function renderHus(p, ctx) {
  const meta = state.meta;
  const f = F(p.id);
  const hus = await get(`/projects/${p.id}/hus`);
  const byParent = new Map();
  for (const x of hus) {
    const k = x.parent_id || 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(x);
  }
  const ordered = [];
  const walk = (pidKey, depth) => { for (const x of byParent.get(pidKey) || []) { ordered.push({ x, depth }); walk(x.id, depth + 1); } };
  walk(0, 0);
  const q = f.huQ.toLowerCase();
  const visible = ordered.filter(({ x }) => (!f.huStatus || x.status === f.huStatus)
    && (!q || [x.package_number, x.hu_number, x.description, x.location, x.delivery_number].some((v) => String(v || '').toLowerCase().includes(q))));

  const qIn = h('input', { type: 'search', id: 'hu-q', placeholder: 'Suche Nr., Bezeichnung, Lagerplatz …', value: f.huQ, 'data-nodirty': '1', style: { maxWidth: '280px' } });
  let t;
  qIn.addEventListener('input', () => { f.huQ = qIn.value; clearTimeout(t); t = setTimeout(async () => { await ctx.refresh(); document.getElementById('hu-q')?.focus(); }, 300); });
  const stSel = h('select', { id: 'hu-status', value: f.huStatus, 'data-nodirty': '1', style: { maxWidth: '240px' } },
    optionList(meta.hu_status, { empty: 'Alle Status' }).map((o) => h('option', { value: o.value }, o.label)));
  stSel.addEventListener('change', () => { f.huStatus = stSel.value; ctx.refresh(); });

  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Packstück'), h('th', null, 'Art / Bezeichnung'), h('th', null, 'Inhalt'), h('th', null, 'Lagerplatz'),
      h('th', { class: 'num' }, 'Brutto'), h('th', null, 'Maße'), h('th', null, 'Status'), h('th', null, 'Lieferung'), h('th', { class: 'num' }, 'Bilder'))),
    h('tbody', null, visible.map(({ x, depth }) => h('tr', { class: 'clickable', onclick: () => go(`#/hu/${x.id}`) },
      h('td', { class: 'nowrap' }, depth ? h('span', { class: 'tree-indent', style: { paddingLeft: `${(depth - 1) * 16}px` } }, '└ ') : null,
        h('a', { href: `#/hu/${x.id}`, class: 'mono', onclick: (e) => e.stopPropagation() }, x.package_number), h('div', { class: 'sub mono' }, x.hu_number)),
      h('td', null, h('b', null, x.packaging_label), h('div', { class: 'sub' }, x.description || '')),
      h('td', { class: 'small nowrap' }, `${x.contents_count} Pos.`, x.children_count ? ` · ${x.children_count} Packst.` : ''),
      h('td', { class: 'small' }, x.location || '–'),
      h('td', { class: 'num' }, x.gross_eff === null ? '–' : `${x.gross_complete ? '' : 'ca. '}${fmt.kg(x.gross_eff)}`),
      h('td', { class: 'small nowrap' }, fmt.dims(x)),
      h('td', null, chip(x.status, x.status_label)),
      h('td', { class: 'small' }, x.delivery_number ? h('span', null, h('span', { class: 'mono' }, x.delivery_number), x.delivery_kind === 'NACHLIEFERUNG' ? h('div', { class: 'sub' }, 'Nachlieferung') : null) : '–'),
      h('td', { class: 'num' }, x.photos_count || '–'))))));

  const top = hus.filter((x) => !x.parent_id);
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Packstücke / Handling Units (${hus.length})`),
      btn('Etiketten (sichtbare)', () => openLabelDialog(visible.map(({ x }) => ({ kind: 'hu', hu_id: x.id }))), { icon: 'print', disabled: !visible.length }),
      btn('Neues Packstück', () => newHuDialog(p), { icon: 'plus', cls: 'primary' })),
    h('div', { class: 'panel-body' }, h('div', { class: 'row' }, qIn, stSel,
      h('span', { class: 'muted small' }, `${top.length} äußere Packstücke · ${top.filter((x) => x.status === 'VERSANDBEREIT').length} versandbereit`))),
    h('div', { class: 'panel-body flush' }, hus.length ? table : h('div', { class: 'empty' }, 'Noch keine Packstücke. Legen Sie eine Kiste, Palette, einen Container oder ein Großcolli an und scannen Sie das Material hinein.')));
}

export async function newHuDialog(p, { parent } = {}) {
  const meta = state.meta;
  const hus = await get(`/projects/${p.id}/hus`);
  const parents = hus.filter((x) => x.pack_status !== 'ABGESCHLOSSEN' && x.ship_status === 'OFFEN');
  formDialog({
    title: 'Neues Packstück (Handling Unit)',
    intro: h('p', { class: 'hint' }, 'HU- und Packstücknummer werden automatisch vergeben. Maße und Gewicht können auch später nach dem Wiegen erfasst werden.'),
    fields: [
      { name: 'packaging_type', label: 'Verpackungsart', type: 'select', options: optionList(meta.packaging_types), value: 'KISTE', required: true },
      { name: 'description', label: 'Bezeichnung', autofocus: true, placeholder: 'z. B. Kiste Hydraulikaggregat' },
      { name: 'psp_id', label: 'PSP-Element', type: 'select', options: pspOptions(p) },
      { name: 'location', label: 'Lagerplatz / Sammelplatz' },
      { name: 'length_cm', label: 'Länge (cm)', type: 'number', step: 'any', min: 0 },
      { name: 'width_cm', label: 'Breite (cm)', type: 'number', step: 'any', min: 0 },
      { name: 'height_cm', label: 'Höhe (cm)', type: 'number', step: 'any', min: 0 },
      { name: 'tare_kg', label: 'Tara / Verpackungsgewicht (kg)', type: 'number', step: 'any', min: 0 },
      { name: 'parent_id', label: 'Liegt in (übergeordnetes Packstück)', type: 'select', value: parent ? String(parent) : '',
        options: [{ value: '', label: '— eigenständig —' }, ...parents.map((x) => ({ value: String(x.id), label: `${x.package_number} · ${x.packaging_label}${x.description ? ' · ' + x.description : ''}` }))] },
      { name: 'destination', label: 'Zielort (leer = aus Projekt)', type: 'textarea', wide: true },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => {
      const body = { ...v, psp_id: v.psp_id ? Number(v.psp_id) : null, parent_id: v.parent_id ? Number(v.parent_id) : null };
      if (!body.destination) delete body.destination;
      const hu = await post(`/projects/${p.id}/hus`, body);
      toast(`Packstück ${hu.package_number} angelegt.`, 'ok');
      go(`#/hu/${hu.id}`);
    },
  });
}

// ================================================================== Lieferungen
async function renderDeliveries(p) {
  const list = await get(`/projects/${p.id}/deliveries`);
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Lieferung'), h('th', null, 'Art'), h('th', null, 'Status'), h('th', null, 'Kennzeichen / Spedition'),
      h('th', null, 'Geplant'), h('th', null, 'Verladen'), h('th', null, 'Zugestellt'), h('th', { class: 'num' }, 'Packstücke'), h('th', { class: 'num' }, 'Brutto'), h('th', { class: 'num' }, 'Bilder'))),
    h('tbody', null, list.map((d) => h('tr', { class: 'clickable', onclick: () => go(`#/d/${d.id}`) },
      h('td', null, h('a', { href: `#/d/${d.id}`, class: 'mono', onclick: (e) => e.stopPropagation() }, d.number)),
      h('td', null, d.kind === 'NACHLIEFERUNG' ? h('span', { class: 'tag warn' }, d.kind_label) : h('span', { class: 'tag' }, d.kind_label)),
      h('td', null, chip(d.status, d.status_label)),
      h('td', null, h('span', { class: 'mono' }, d.truck_plate || '–'), d.carrier ? h('div', { class: 'sub' }, d.carrier) : null),
      h('td', { class: 'nowrap' }, fmt.date(d.planned_date)),
      h('td', { class: 'nowrap' }, fmt.dt(d.loaded_at)),
      h('td', { class: 'nowrap' }, fmt.dt(d.delivered_at)),
      h('td', { class: 'num' }, d.hu_count),
      h('td', { class: 'num' }, fmt.kg(d.gross_total)),
      h('td', { class: 'num' }, d.photos_count || '–'))))));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Lieferungen (${list.length})`), btn('Neue Lieferung', () => newDeliveryDialog(p), { icon: 'plus', cls: 'primary' })),
    h('div', { class: 'panel-body flush' }, list.length ? table : h('div', { class: 'empty' }, 'Noch keine Lieferungen. Legen Sie eine Lieferung an und scannen Sie die versandbereiten Packstücke bei der Verladung.')));
}

export function newDeliveryDialog(p) {
  const meta = state.meta;
  formDialog({
    title: 'Neue Lieferung',
    fields: [
      { name: 'number', label: 'Lieferungsnummer (SAP)', hint: 'Leer = automatisch vergeben', autofocus: true },
      { name: 'kind', label: 'Art', type: 'select', options: [{ value: '', label: 'Automatisch (erste = Hauptlieferung, danach Nachlieferung)' }, ...optionList(meta.delivery_kinds)] },
      { name: 'planned_date', label: 'Geplante Verladung', type: 'date' },
      { name: 'carrier', label: 'Spedition' },
      { name: 'truck_plate', label: 'LKW-Kennzeichen / Container-Nr.' },
      { name: 'trailer_plate', label: 'Auflieger-Kennzeichen' },
      { name: 'driver', label: 'Fahrer' },
      { name: 'destination', label: 'Zielort (leer = aus Projekt)', type: 'textarea', wide: true },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => {
      const body = { ...v };
      if (!body.kind) delete body.kind;
      if (!body.destination) delete body.destination;
      const d = await post(`/projects/${p.id}/deliveries`, body);
      toast(`Lieferung ${d.number} angelegt (${d.kind_label}).`, 'ok');
      go(`#/d/${d.id}`);
    },
  });
}

// ================================================================== Fehlteile & Nachlieferungen
async function renderShortages(p) {
  const s = await get(`/projects/${p.id}/shortages`);
  const openTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'PSP-Element'), h('th', { class: 'num' }, 'Fehlmenge'), h('th', { class: 'num' }, 'Offen'),
      h('th', null, 'Grund'), h('th', null, 'Erwartet'), h('th', null, 'Bereits verpackt in'), h('th', null, ''))),
    h('tbody', null, s.open.map((i) => h('tr', null,
      h('td', null, h('div', { class: 'mono' }, i.material_number), h('div', { class: 'sub' }, i.description)),
      h('td', { class: 'mono' }, i.psp_code || '–'),
      h('td', { class: 'num' }, h('b', null, fmt.qty(i.qty_missing_eff, i.unit))),
      h('td', { class: 'num' }, fmt.num(i.qty_open)),
      h('td', null, i.missing_reason || '–'),
      h('td', { class: 'nowrap' }, i.missing_expected ? fmt.date(i.missing_expected) : '–'),
      h('td', { class: 'small' }, i.placements.length ? i.placements.map((pl) => h('div', null, h('a', { href: `#/hu/${pl.hu_id}`, class: 'mono' }, pl.package_number), ` ${fmt.num(pl.qty)} · ${pl.status_label}`)) : '–'),
      h('td', null, btn('Bearbeiten', () => missingDialog(i), { cls: 'small' })))))));
  const resolvedTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'PSP-Element'), h('th', null, 'Status'), h('th', null, 'Verpackt / geliefert'))),
    h('tbody', null, s.resolved.map((i) => h('tr', null,
      h('td', null, h('div', { class: 'mono' }, i.material_number), h('div', { class: 'sub' }, i.description)),
      h('td', { class: 'mono' }, i.psp_code || '–'),
      h('td', null, chip(i.status, i.status_label)),
      h('td', { class: 'small' }, i.placements.map((pl) => h('div', null,
        h('a', { href: `#/hu/${pl.hu_id}`, class: 'mono' }, pl.package_number), ` ${fmt.qty(pl.qty, i.unit)} · `,
        pl.delivery_number ? h('span', null, h('a', { href: `#/d/${pl.delivery_id}`, class: 'mono' }, pl.delivery_number), pl.delivery_kind === 'NACHLIEFERUNG' ? ' (Nachlieferung)' : ' (Hauptlieferung)') : pl.status_label))))))));
  const suppTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Lieferung'), h('th', null, 'Status'), h('th', null, 'Kennzeichen'), h('th', null, 'Verladen'), h('th', { class: 'num' }, 'Packstücke'))),
    h('tbody', null, s.supplementary_deliveries.map((d) => h('tr', { class: 'clickable', onclick: () => go(`#/d/${d.id}`) },
      h('td', { class: 'mono' }, d.number), h('td', null, chip(d.status, d.status_label)), h('td', { class: 'mono' }, d.truck_plate || '–'),
      h('td', null, fmt.dt(d.loaded_at)), h('td', { class: 'num' }, d.hu_count))))));
  return h('div', { class: 'stack', style: { gap: '18px' } },
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Offene Fehlteile (${s.open.length})`)),
      h('div', { class: 'panel-body flush' }, s.open.length ? openTable : h('div', { class: 'empty' }, 'Keine offenen Fehlteile.'))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Nachlieferungen (${s.supplementary_deliveries.length})`),
      btn('Nachlieferung anlegen', () => newDeliveryDialog(p), { icon: 'plus' })),
    h('div', { class: 'panel-body flush' }, s.supplementary_deliveries.length ? suppTable : h('div', { class: 'empty' }, 'Keine Nachlieferungen.'))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Erledigte Fehlteile (${s.resolved.length})`)),
      h('div', { class: 'panel-body flush' }, s.resolved.length ? resolvedTable : h('div', { class: 'empty' }, 'Noch keine erledigten Fehlteile.'))));
}

// ================================================================== Verlauf
export function eventsTable(events, { compact = false } = {}) {
  if (!events.length) return h('p', { class: 'muted' }, 'Noch keine Einträge.');
  const link = (e) => {
    if (e.entity === 'hu' && e.entity_id) return h('a', { href: `#/hu/${e.entity_id}`, class: 'mono' }, e.ref);
    if (e.entity === 'delivery' && e.entity_id) return h('a', { href: `#/d/${e.entity_id}`, class: 'mono' }, e.ref);
    return h('span', { class: 'mono' }, e.ref);
  };
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Zeit'), h('th', null, 'Benutzer'), compact ? null : h('th', null, 'Objekt'), h('th', null, 'Vorgang'))),
    h('tbody', null, events.map((e) => h('tr', null,
      h('td', { class: 'nowrap small' }, fmt.dt(e.ts)),
      h('td', { class: 'small' }, e.user),
      compact ? null : h('td', null, link(e)),
      h('td', null, h('b', null, e.action), compact && e.ref ? h('span', null, ' · ', link(e)) : null, e.details ? h('div', { class: 'sub' }, e.details) : null))))));
}

async function renderHistory(p) {
  const events = await get(`/events?project_id=${p.id}&limit=1000`);
  return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Verlauf (Rückverfolgung aller Buchungen)')),
    h('div', { class: 'panel-body flush' }, eventsTable(events)));
}

// ================================================================== Stammdaten
async function renderMaster(p) {
  const form = h('form', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Projektnummer', h('input', { name: 'number', id: 'pm-number', value: p.number, required: true })),
    h('label', { class: 'field' }, 'Bezeichnung', h('input', { name: 'name', id: 'pm-name', value: p.name })),
    h('label', { class: 'field' }, 'Kunde', h('input', { name: 'customer', id: 'pm-customer', value: p.customer })),
    h('label', { class: 'field wide' }, 'Zielort / Lieferadresse', h('textarea', { name: 'destination', id: 'pm-destination', value: p.destination })),
    h('div', { class: 'row wide' }, h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    try { await put(`/projects/${p.id}`, d); state.dirty = false; toast('Projekt gespeichert.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
  });

  const pspTable = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'PSP-Element'), h('th', null, 'Bezeichnung'), h('th', { class: 'num' }, 'Positionen'), h('th', { class: 'num' }, 'Packstücke'), h('th', null, ''))),
    h('tbody', null, p.psp.map((x) => h('tr', null,
      h('td', { class: 'mono' }, x.code), h('td', null, x.description || '–'), h('td', { class: 'num' }, x.item_count), h('td', { class: 'num' }, x.hu_count),
      h('td', { class: 'nowrap' },
        btn('Bearbeiten', () => pspDialog(p, x), { cls: 'small ghost' }),
        btn('Löschen', async () => {
          if (!(await confirmDialog(`PSP-Element ${x.code} löschen?`, { ok: 'Löschen', danger: true }))) return;
          try { await del(`/psp/${x.id}`); toast('PSP-Element gelöscht.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
        }, { cls: 'small ghost danger', disabled: x.item_count > 0 || x.hu_count > 0 })))))));

  return h('div', { class: 'grid-2' },
    panel('Projektdaten', form),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `PSP-Elemente (${p.psp.length})`), btn('PSP-Element anlegen', () => pspDialog(p), { icon: 'plus' })),
      h('div', { class: 'panel-body flush' }, p.psp.length ? pspTable : h('div', { class: 'empty' }, 'PSP-Elemente werden beim Import automatisch angelegt.'))));
}

function pspDialog(p, x) {
  formDialog({
    title: x ? `PSP-Element ${x.code}` : 'PSP-Element anlegen',
    fields: [
      { name: 'code', label: 'PSP-Element', value: x ? x.code : '', required: true, autofocus: true },
      { name: 'description', label: 'Bezeichnung', value: x ? x.description : '' },
    ],
    onSubmit: async (v) => {
      if (x) await put(`/psp/${x.id}`, v); else await post(`/projects/${p.id}/psp`, v);
      toast('PSP-Element gespeichert.', 'ok');
    },
  });
}

// ================================================================== Ladeplanung
async function renderLoadplans(p) {
  const plans = await get(`/projects/${p.id}/loadplans`);
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Ladeplan'), h('th', null, 'Laderäume'), h('th', { class: 'num' }, 'Teile'), h('th', null, 'Ergebnis'),
      h('th', { class: 'num' }, 'Gewicht'), h('th', null, 'Lieferungen'), h('th', null, 'Geändert'))),
    h('tbody', null, plans.map((x) => h('tr', { class: 'clickable', onclick: () => go(`#/lp/${x.id}`) },
      h('td', null, h('a', { href: `#/lp/${x.id}`, onclick: (e) => e.stopPropagation() }, x.name), h('div', { class: 'sub' }, x.created_by)),
      h('td', { class: 'small' }, x.spaces.join(', ') || '–'),
      h('td', { class: 'num' }, x.pieces),
      h('td', null, x.vehicles_used === null ? h('span', { class: 'chip' }, 'Nicht berechnet')
        : [h('span', { class: `chip ${x.stale ? 's-FEHLTEIL' : x.unplaced ? 's-FEHLTEIL' : 's-VERSANDBEREIT'}` },
          x.stale ? 'Veraltet' : `${x.vehicles_used} Fahrzeug(e)`), x.unplaced ? h('div', { class: 'sub' }, `${x.unplaced} nicht verladen`) : null,
        x.warnings ? h('div', { class: 'sub' }, `${x.warnings} Hinweis(e)`) : null]),
      h('td', { class: 'num' }, x.weight_kg === null ? '–' : fmt.kg(x.weight_kg)),
      h('td', { class: 'num' }, x.deliveries || '–'),
      h('td', { class: 'small nowrap' }, fmt.dt(x.updated_at)))))));
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Ladeplanung (${plans.length})`), btn('Neuer Ladeplan', () => newLoadplanDialog(p), { icon: 'plus', cls: 'primary' })),
    h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'LKW, Auflieger oder Container wählen und die Packstücke automatisch optimal beladen lassen – mit 3D-Ansicht, Achslast- und Schwerpunktprüfung, Beladereihenfolge und Bericht. Ein Laderaum kann einer Lieferung zugeordnet werden; die Verladung per Scan folgt dann dem Plan.')),
    h('div', { class: 'panel-body flush' }, plans.length ? table : h('div', { class: 'empty' }, 'Noch keine Ladepläne.')));
}

export async function newLoadplanDialog(p) {
  const types = await get('/vehicle-types');
  const cats = state.meta.vehicle_categories;
  formDialog({
    title: 'Neuer Ladeplan',
    fields: [
      { name: 'name', label: 'Bezeichnung', value: `Ladeplan ${new Date().toLocaleDateString('de-DE')}`, required: true, autofocus: true, wide: true },
      { name: 'vehicle_type_id', label: 'Fahrzeug / Container', type: 'select', wide: true,
        options: types.map((t) => ({ value: String(t.id), label: `${cats[t.category] || t.category}: ${t.name} (${fmt.num(t.length_cm, 1)} × ${fmt.num(t.width_cm, 1)} × ${fmt.num(t.height_cm, 1)} cm)` })) },
      { name: 'auto_add', label: 'Bei Bedarf weitere Fahrzeuge dieses Typs ergänzen', type: 'checkbox', value: true, wide: true },
      { name: 'add_hus', label: 'Packstücke übernehmen', type: 'select', wide: true, value: 'ready', options: [
        { value: 'ready', label: 'Alle versandbereiten, noch nicht verladenen Packstücke' },
        { value: 'open', label: 'Alle noch nicht verladenen Packstücke (auch in Verpackung)' },
        { value: '', label: 'Keine – Ladegut selbst auswählen' }] },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => {
      const plan = await post(`/projects/${p.id}/loadplans`, { name: v.name, vehicle_type_id: Number(v.vehicle_type_id), auto_add: v.auto_add, add_hus: v.add_hus });
      go(`#/lp/${plan.id}`);
    },
  });
}

const TAB_RENDER = {
  overview: renderOverview,
  items: renderItems,
  hus: renderHus,
  deliveries: renderDeliveries,
  loadplans: renderLoadplans,
  shortages: renderShortages,
  history: renderHistory,
  master: renderMaster,
};

