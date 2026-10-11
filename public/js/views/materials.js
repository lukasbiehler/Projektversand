// Materialstamm: SAP-Materialnummern mit vorhandenen Barcodes (keine parallele Barcodewelt)
import { h, get, post, put, del, state, btn, fmt, toast, formDialog, confirmDialog, modal, setScanHandler, optionList, showError, notifyChanged, can } from '../core.js';
import { openImportWizard } from '../importer.js';

let lastQ = '';

export async function render(ctx) {
  const q = ctx.query.q !== undefined ? ctx.query.q : lastQ;
  lastQ = q;
  const data = await get(`/materials?q=${encodeURIComponent(q)}&limit=300`);
  const qInput = h('input', { type: 'search', id: 'mat-q', value: q, placeholder: 'Materialnummer, Bezeichnung oder Barcode …', 'data-nodirty': '1' });
  let t;
  qInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => { lastQ = qInput.value.trim(); await ctx.refresh(); const el = document.getElementById('mat-q'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 300);
  });
  setScanHandler(async (code) => { lastQ = code; await ctx.refresh(); return true; });

  const table = data.rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'Bezeichnung'), h('th', null, 'ME'), h('th', { class: 'num' }, 'Gewicht / ME'),
      h('th', null, 'Barcodes'), h('th', null, 'Herkunft'))),
    h('tbody', null, data.rows.map((m) => h('tr', { class: 'clickable', onclick: () => materialDialog(m.material_number) },
      h('td', { class: 'mono' }, m.material_number),
      h('td', null, m.description),
      h('td', null, m.unit),
      h('td', { class: 'num' }, m.weight_kg === null ? '–' : `${fmt.num(m.weight_kg, 3)} kg`),
      h('td', { class: 'small' }, m.barcodes.length ? m.barcodes.map((b) => h('div', null, h('span', { class: 'mono' }, b.barcode), ` · ${state.meta.symbologies[b.symbology] || b.symbology}${b.is_primary ? ' · Etikett' : ''}`)) : h('span', { class: 'muted' }, 'kein Barcode (Materialnr. wird gedruckt)')),
      h('td', null, h('span', { class: `tag${m.origin === 'SAP' ? ' ok' : ''}` }, m.origin === 'SAP' ? 'SAP' : 'lokal'))))))) : h('div', { class: 'empty' }, q ? `Kein Material zu „${q}“.` : 'Der Materialstamm ist leer. Importieren Sie den SAP-Export mit Materialnummern und Barcodes.');

  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } },
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' }, h('h1', null, 'Materialstamm'),
        h('p', { class: 'muted' }, 'SAP-Materialnummern und die bereits in Produktion, Lager und Logistik verwendeten Barcodes. Gescannte Artikeletiketten werden hierüber erkannt.')),
      h('div', { class: 'row' },
        can('materials') && btn('Material anlegen', () => createDialog(), { icon: 'plus' }),
        can('materials') && btn('Import (SAP / Excel)', () => openImportWizard({ mode: 'materials', onDone: () => ctx.refresh() }), { icon: 'upload', cls: 'primary' }))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `${data.rows.length} von ${data.total} Materialien`), h('div', { style: { flex: '1 1 300px' } }, qInput)),
      h('div', { class: 'panel-body flush' }, table))));
}

function createDialog() {
  formDialog({
    title: 'Material anlegen',
    fields: [
      { name: 'material_number', label: 'Materialnummer', required: true, autofocus: true },
      { name: 'description', label: 'Bezeichnung', required: true },
      { name: 'unit', label: 'Basismengeneinheit', value: 'ST' },
      { name: 'weight_kg', label: 'Gewicht je Einheit (kg)', type: 'number', step: 'any', min: 0 },
      { name: 'origin', label: 'Herkunft', type: 'select', options: [{ value: 'SAP', label: 'SAP-Material' }, { value: 'LOKAL', label: 'Lokal (z. B. Lieferantenteil)' }] },
      { name: 'barcode', label: 'Vorhandener Barcode', hint: 'Inhalt exakt wie auf dem bestehenden Etikett' },
      { name: 'symbology', label: 'Barcode-Art', type: 'select', options: optionList(state.meta.symbologies), value: 'CODE128' },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => { await post('/materials', v); toast('Material angelegt.', 'ok'); },
  });
}

async function materialDialog(nr) {
  let m;
  try { m = await get(`/materials/${encodeURIComponent(nr)}`); } catch (err) { showError(err); return; }
  const sym = state.meta.symbologies;
  const edit = can('materials');
  const desc = h('input', { id: 'md-desc', value: m.description, disabled: !edit });
  const unit = h('input', { id: 'md-unit', value: m.unit, disabled: !edit });
  const weight = h('input', { id: 'md-weight', type: 'number', step: 'any', min: 0, value: m.weight_kg === null ? '' : String(m.weight_kg), disabled: !edit });
  const bcInput = h('input', { id: 'md-bc', placeholder: 'Barcode scannen oder eingeben', 'data-scan': '1' });
  const bcSym = h('select', { id: 'md-sym', value: 'CODE128' }, optionList(sym).map((o) => h('option', { value: o.value }, o.label)));
  const list = h('div', { class: 'stack' });
  const renderList = () => {
    list.replaceChildren();
    if (!m.barcodes.length) list.append(h('p', { class: 'muted small' }, 'Kein Barcode hinterlegt – auf Etiketten wird die Materialnummer als Code 128 gedruckt.'));
    for (const b of m.barcodes) {
      list.append(h('div', { class: 'row' }, h('span', { class: 'mono' }, b.barcode), h('span', { class: 'tag' }, sym[b.symbology] || b.symbology),
        b.is_primary ? h('span', { class: 'tag ok' }, 'wird auf Etikett gedruckt') : edit && btn('Für Etikett verwenden', async () => {
          try { m = await post(`/materials/${encodeURIComponent(m.material_number)}/barcodes`, { barcode: b.barcode, symbology: b.symbology, is_primary: true }); renderList(); notifyChanged(); } catch (err) { showError(err); }
        }, { cls: 'small ghost' }),
        h('span', { class: 'spacer' }),
        edit && btn('Entfernen', async () => {
          if (!(await confirmDialog(`Barcode ${b.barcode} von Material ${m.material_number} entfernen?`, { ok: 'Entfernen', danger: true }))) return;
          try { m = await del(`/barcodes/${encodeURIComponent(b.barcode)}`); renderList(); notifyChanged(); } catch (err) { showError(err); }
        }, { cls: 'small ghost danger' })));
    }
  };
  renderList();
  const addBc = async () => {
    const v = bcInput.value.trim();
    if (!v) return;
    try {
      m = await post(`/materials/${encodeURIComponent(m.material_number)}/barcodes`, { barcode: v, symbology: bcSym.value });
      bcInput.value = '';
      renderList();
      toast('Barcode zugeordnet.', 'ok');
      notifyChanged();
    } catch (err) { showError(err); }
  };
  bcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBc(); } });
  modal({
    title: `Material ${m.material_number}`,
    wide: true,
    body: [
      h('div', { class: 'form-grid' },
        h('label', { class: 'field wide' }, 'Bezeichnung', desc),
        h('label', { class: 'field' }, 'Basismengeneinheit', unit),
        h('label', { class: 'field' }, 'Gewicht je Einheit (kg)', weight)),
      h('h3', null, 'Barcodes'),
      list,
      edit && h('div', { class: 'row' }, h('div', { style: { flex: '1 1 220px' } }, bcInput), h('div', { style: { flex: '0 1 180px' } }, bcSym), btn('Zuordnen', addBc)),
    ],
    actions: [
      edit && { label: 'Löschen', cls: 'danger', icon: 'trash', onClick: async (close) => {
        if (!(await confirmDialog(`Material ${m.material_number} mit seinen Barcodes aus dem Materialstamm löschen?`, { ok: 'Löschen', danger: true }))) return;
        await del(`/materials/${encodeURIComponent(m.material_number)}`);
        toast('Material gelöscht.', 'ok');
        close();
        notifyChanged();
      } },
      { label: 'Schließen', cls: edit ? '' : 'primary' },
      edit && { label: 'Speichern', cls: 'primary', onClick: async (close) => {
        await put(`/materials/${encodeURIComponent(m.material_number)}`, { description: desc.value, unit: unit.value, weight_kg: weight.value === '' ? null : Number(weight.value) });
        toast('Material gespeichert.', 'ok');
        close();
        notifyChanged();
      } },
    ].filter(Boolean),
  });
}
