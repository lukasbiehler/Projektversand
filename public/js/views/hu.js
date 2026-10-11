// Packstück / Handling Unit: scannergestütztes Verpacken, mehrstufige Verpackung, Daten, Status, Bilder, Etikett, Verlauf
import {
  h, get, post, put, del, state, btn, chip, fmt, toast, modal, formDialog, confirmDialog, go, openCode, setScanHandler, optionList,
  showError, feedback, notifyChanged, ApiError, can,
} from '../core.js';
import { scanField } from '../scanner.js';
import { openLabelDialog } from '../labels.js';
import { photoPanel } from '../photos.js';
import { eventsTable } from './project.js';

let lastResult = null; // letzte Verpackungsbuchung (bleibt nach Aktualisierung sichtbar)

export async function render(ctx) {
  const id = Number(ctx.params[0]);
  const d = await get(`/hus/${id}`);
  const { hu, project } = d;
  ctx.projectId = hu.project_id;
  const meta = state.meta;
  const mayPack = can('pack');
  const open = hu.pack_status !== 'ABGESCHLOSSEN' && hu.ship_status === 'OFFEN';
  const packable = open && mayPack;
  if (lastResult && lastResult.huId !== hu.id) lastResult = null;

  const act = async (action, msg) => {
    try {
      await post(`/hus/${hu.id}/action`, { action });
      toast(msg, 'ok');
      notifyChanged();
    } catch (err) { feedback(false); showError(err); }
  };

  // ---------------------------------------------------------------- Kopf & Statusaktionen
  const actions = h('div', { class: 'row' });
  const add = (el) => actions.append(el);
  if (packable) add(btn('Verpackung abschließen', () => act('close', 'Verpackung abgeschlossen.'), { cls: hu.pack_status === 'BEGONNEN' ? 'primary' : '', icon: 'check', disabled: hu.pack_status !== 'BEGONNEN' }));
  if (mayPack && hu.pack_status === 'ABGESCHLOSSEN' && ['OFFEN', 'VERSANDBEREIT'].includes(hu.ship_status)) add(btn('Wieder öffnen', () => act('reopen', 'Packstück wieder geöffnet.')));
  if (mayPack && !hu.parent_id && hu.pack_status === 'ABGESCHLOSSEN' && hu.ship_status === 'OFFEN') add(btn('Versandbereit melden', () => act('ready', 'Packstück ist versandbereit.'), { cls: 'ok', icon: 'truck' }));
  if (mayPack && !hu.parent_id && hu.ship_status === 'VERSANDBEREIT') add(btn('Versandbereitschaft zurücknehmen', () => act('unready', 'Versandbereitschaft zurückgenommen.')));
  add(btn('Etikett drucken', () => openLabelDialog([{ kind: 'hu', hu_id: hu.id }], { title: `Etikett ${hu.package_number}` }), { icon: 'print' }));
  if (mayPack && ['OFFEN', 'VERSANDBEREIT'].includes(hu.ship_status)) {
    add(btn('Löschen', async () => {
      // Gelöscht wird nur ein leeres, offenes Packstück – sonst sagen, was vorher zu tun ist
      const todo = [
        hu.ship_status === 'VERSANDBEREIT' ? (hu.parent_id ? 'das äußere Packstück: Versandbereitschaft zurücknehmen' : 'Versandbereitschaft zurücknehmen') : null,
        hu.pack_status === 'ABGESCHLOSSEN' ? 'Verpackung mit „Wieder öffnen“ öffnen' : null,
        d.contents.length ? `${d.contents.length} Position(en) unter „Inhalt“ entnehmen` : null,
        d.children.length ? `${d.children.length} enthaltene(s) Packstück(e) herausnehmen` : null,
        d.photos.some((p) => p.hu_id === hu.id) ? 'Bilder des Packstücks löschen' : null,
      ].filter(Boolean);
      if (todo.length) {
        modal({
          title: `${hu.package_number} kann noch nicht gelöscht werden`,
          body: [h('p', null, 'Gelöscht werden nur leere, offene Packstücke. Vorher bitte:'), h('ul', null, todo.map((t) => h('li', null, t)))],
          actions: [{ label: 'Schließen', cls: 'primary' }],
        });
        return;
      }
      if (!(await confirmDialog(`Leeres Packstück ${hu.package_number} löschen?`, { ok: 'Löschen', danger: true }))) return;
      try { await del(`/hus/${hu.id}`); toast('Packstück gelöscht.', 'ok'); go(`#/p/${hu.project_id}/hus`); } catch (err) { showError(err); }
    }, { cls: 'danger', icon: 'trash' }));
  }

  const readiness = [];
  if (!hu.parent_id && hu.pack_status === 'ABGESCHLOSSEN' && hu.ship_status === 'OFFEN') {
    if (!hu.dims_complete) readiness.push('Abmessungen');
    if (hu.gross_eff === null) readiness.push('Bruttogewicht');
    else if (!hu.gross_complete) readiness.push('vollständiges Bruttogewicht (wiegen oder Tara + Materialgewichte)');
  }

  const head = h('div', { class: 'stack' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projekte'), '›', h('a', { href: `#/p/${project.id}` }, project.number), '›',
      h('a', { href: `#/p/${project.id}/hus` }, 'Packstücke'), '›', h('span', null, hu.package_number)),
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' },
        h('div', { class: 'row' }, h('span', { class: 'hu-id' }, hu.package_number), h('span', { class: 'tag' }, hu.packaging_label), chip(hu.status, hu.status_label)),
        h('div', { class: 'muted' }, h('span', { class: 'mono' }, hu.hu_number), hu.description ? ` · ${hu.description}` : '', hu.psp_code ? ` · PSP ${hu.psp_code}` : ''),
        d.path.length ? h('div', { class: 'path' }, 'liegt in: ', d.path.map((x, i) => [i ? ' › ' : '', h('a', { href: `#/hu/${x.id}` }, x.package_number), ` (${x.packaging_label})`])) : null,
        hu.delivery_number ? h('div', { class: 'path' }, 'Lieferung: ', h('a', { href: `#/d/${hu.delivery_id}`, class: 'mono' }, hu.delivery_number),
          ` · ${hu.delivery_kind_label}${hu.delivery_truck_plate ? ' · ' + hu.delivery_truck_plate : ''}`) : null),
      actions),
    readiness.length && mayPack ? h('p', { class: 'notice warn' }, `Für „Versandbereit“ fehlen noch: ${readiness.join(', ')}. Bitte unten unter „Packstückdaten“ erfassen.`) : null);

  // ---------------------------------------------------------------- Verpacken per Scan
  const qtyInput = h('input', { type: 'number', id: 'pack-qty', min: 0, step: 'any', value: '1', inputmode: 'decimal', 'data-nodirty': '1', style: { maxWidth: '110px' } });
  const resultBox = h('div', { id: 'pack-result' });
  const showResult = () => {
    resultBox.replaceChildren();
    if (!lastResult) return;
    resultBox.append(h('p', { class: `notice ${lastResult.ok ? 'ok' : 'bad'}` }, lastResult.text));
  };
  showResult();

  async function packItem(body) {
    try {
      const r = await post(`/hus/${hu.id}/pack`, body);
      const it = r.item;
      lastResult = { huId: hu.id, ok: true, text: `✓ ${fmt.qty(r.packed_qty, it.unit)} ${it.material_number} ${it.description} verpackt${it.psp_code ? ' (PSP ' + it.psp_code + ')' : ''} – offen im Projekt: ${fmt.qty(it.qty_open, it.unit)}` };
      qtyInput.value = '1';
      showResult();
      notifyChanged();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data && err.data.reason === 'CHOOSE_ITEM') {
        chooseItem(err.data.candidates, body.qty);
        return true;
      }
      lastResult = { huId: hu.id, ok: false, text: err.message };
      showResult();
      throw err;
    }
  }

  function chooseItem(cands, qty) {
    const m = modal({
      title: 'Position auswählen',
      body: [h('p', null, 'Das Material ist mehrfach im Packvorrat offen. Für welche Position wird verpackt?'),
        h('div', { class: 'stack' }, cands.map((c) => btn(`${c.psp_code || 'ohne PSP'} · ${c.source_label} · offen ${fmt.qty(c.qty_open, c.unit)}`, async () => {
          m.close();
          try { await packItem({ pack_item_id: c.id, qty }); feedback(true); } catch { feedback(false); }
        }, { cls: 'big' })))],
      actions: [{ label: 'Abbrechen' }],
    });
  }

  async function onScan(code) {
    const qty = Number(qtyInput.value);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Bitte eine gültige Menge > 0 eingeben.');
    // Gescanntes Packstück → in dieses Packstück aufnehmen (mehrstufige Verpackung)
    const r = await get(`/resolve?code=${encodeURIComponent(code)}&project_id=${hu.project_id}`);
    if (r.kind === 'hu') {
      if (r.id === hu.id) throw new Error('Das ist dieses Packstück selbst.');
      await post(`/hus/${hu.id}/children`, { child_id: r.id });
      lastResult = { huId: hu.id, ok: true, text: `✓ ${r.label} in ${hu.package_number} aufgenommen.` };
      showResult();
      notifyChanged();
      return true;
    }
    return packItem({ code, qty });
  }

  let packPanel;
  if (packable) {
    const field = scanField({ label: 'Material oder Packstück scannen', placeholder: 'Artikeletikett / SAP-Barcode / Packstück scannen …', onScan, id: 'pack-scan' });
    setScanHandler((code) => { field.run(code); });
    const itemSel = h('select', { id: 'pack-item', 'data-nodirty': '1' }, h('option', { value: '' }, `Position ohne Barcode wählen … (${d.packable.length} offen)`),
      d.packable.map((i) => h('option', { value: String(i.id) }, `${i.material_number} · ${i.description} · ${i.psp_code || 'ohne PSP'} · offen ${fmt.qty(i.qty_open, i.unit)}`)));
    const manualBtn = btn('Verpacken', async () => {
      if (!itemSel.value) { toast('Bitte eine Position wählen.', 'warn'); return; }
      const qty = Number(qtyInput.value);
      try { await packItem({ pack_item_id: Number(itemSel.value), qty }); feedback(true); } catch (err) { feedback(false); showError(err); }
    });
    packPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Verpacken')),
      h('div', { class: 'panel-body' },
        h('div', { class: 'row' }, h('label', { class: 'field inline' }, 'Menge je Scan', qtyInput), h('span', { class: 'hint' }, 'wird nach jeder Buchung auf 1 zurückgesetzt')),
        field,
        resultBox,
        h('div', { class: 'row' }, h('div', { style: { flex: '1 1 300px' } }, itemSel), manualBtn),
        h('p', { class: 'hint' }, 'Gescannte Artikel werden der passenden Packvorrats-Position zugeordnet und in Echtzeit zurückgemeldet. Wird ein Packstück-Etikett gescannt, wird dieses Packstück hier hineingepackt (z. B. Kiste → Container).')));
  } else {
    setScanHandler((code) => openCode(code, hu.project_id));
    packPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Verpacken')),
      h('div', { class: 'panel-body' }, h('p', { class: 'notice' },
        open ? 'Ihr Konto darf nicht verpacken – Sie sehen dieses Packstück nur zur Ansicht.'
          : hu.ship_status !== 'OFFEN' ? `Das Packstück ist ${hu.ship_status_label.toLowerCase()} – Inhalt ist gesperrt.` : 'Die Verpackung ist abgeschlossen. Zum Ändern „Wieder öffnen“.'),
      resultBox));
  }

  // ---------------------------------------------------------------- Inhalt
  const unpack = (c) => formDialog({
    title: `Entnehmen: ${c.material_number}`,
    fields: [{ name: 'qty', label: `Menge (${c.unit}), enthalten: ${fmt.num(c.qty)}`, type: 'number', step: 'any', min: 0, value: c.qty, required: true, autofocus: true }],
    submitLabel: 'Entnehmen',
    onSubmit: async (v) => { await post(`/hus/${hu.id}/unpack`, { pack_item_id: c.pack_item_id, qty: v.qty }); toast('Material entnommen.', 'ok'); },
  });
  const contentTable = d.contents.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'PSP-Element'), h('th', { class: 'num' }, 'Menge'), h('th', null, 'Status Position'),
      h('th', null, 'Verpackt'), h('th', null, ''))),
    h('tbody', null, d.contents.map((c) => h('tr', null,
      h('td', null, h('div', { class: 'mono' }, c.material_number), h('div', { class: 'sub' }, c.description)),
      h('td', { class: 'mono' }, c.psp_code || '–'),
      h('td', { class: 'num' }, h('b', null, fmt.qty(c.qty, c.unit)), c.qty_required !== null && c.qty_required !== c.qty ? h('div', { class: 'sub' }, `Soll gesamt ${fmt.num(c.qty_required)}`) : null),
      h('td', { class: 'small' }, c.item_status_label),
      h('td', { class: 'small nowrap' }, fmt.dt(c.packed_at), h('div', { class: 'sub' }, c.packed_by)),
      h('td', { class: 'nowrap' },
        btn('Etikett', () => openLabelDialog([{ kind: 'item', item_id: c.pack_item_id, hu_id: hu.id }]), { cls: 'small ghost', icon: 'print' }),
        packable ? btn('Entnehmen', () => unpack(c), { cls: 'small ghost danger' }) : null)))))) : h('div', { class: 'empty' }, 'Noch kein Material verpackt.');

  const childTable = d.children.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Packstück'), h('th', null, 'Art / Bezeichnung'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Brutto'), h('th', null, ''))),
    h('tbody', null, d.children.map((c) => h('tr', null,
      h('td', null, h('a', { href: `#/hu/${c.id}`, class: 'mono' }, c.package_number), h('div', { class: 'sub mono' }, c.hu_number)),
      h('td', null, h('b', null, c.packaging_label), h('div', { class: 'sub' }, c.description)),
      h('td', null, chip(c.status, c.status_label)),
      h('td', { class: 'num' }, c.gross_eff === null ? '–' : fmt.kg(c.gross_eff)),
      h('td', null, packable ? btn('Herausnehmen', async () => {
        try { await post(`/hus/${c.id}/parent`, { parent_id: null }); toast(`${c.package_number} herausgenommen.`, 'ok'); notifyChanged(); } catch (err) { showError(err); }
      }, { cls: 'small ghost danger' }) : null)))))) : null;

  // ---------------------------------------------------------------- Stammdaten der HU
  const frozen = ['VERLADEN', 'AUSGELIEFERT'].includes(hu.ship_status);
  const num = (name, label, value) => h('label', { class: 'field' }, label,
    h('input', { type: 'number', name, id: `hu-${name}`, step: 'any', min: 0, value: value === null ? '' : String(value), disabled: frozen, inputmode: 'decimal' }));
  const form = h('form', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Verpackungsart', h('select', { name: 'packaging_type', id: 'hu-type', value: hu.packaging_type, disabled: frozen },
      optionList(meta.packaging_types).map((o) => h('option', { value: o.value }, o.label)))),
    h('label', { class: 'field' }, 'Bezeichnung', h('input', { name: 'description', id: 'hu-description', value: hu.description })),
    h('label', { class: 'field' }, 'PSP-Element', h('select', { name: 'psp_id', id: 'hu-psp', value: hu.psp_id ? String(hu.psp_id) : '', disabled: frozen },
      h('option', { value: '' }, '— ohne —'), (d.project.psp || []).map((x) => h('option', { value: String(x.id) }, x.code)))),
    h('label', { class: 'field' }, 'Lagerplatz / Sammelplatz', h('input', { name: 'location', id: 'hu-location', value: hu.location })),
    num('length_cm', 'Länge (cm)', hu.length_cm), num('width_cm', 'Breite (cm)', hu.width_cm), num('height_cm', 'Höhe (cm)', hu.height_cm),
    num('tare_kg', 'Tara (kg)', hu.tare_kg), num('net_kg', 'Netto (kg) – leer = berechnet', hu.net_kg), num('gross_kg', 'Brutto gewogen (kg) – leer = berechnet', hu.gross_kg),
    h('div', { class: 'wide label-caps' }, 'Ladeplanung'),
    h('label', { class: 'field inline' }, h('input', { type: 'checkbox', name: 'stackable', id: 'hu-stackable', checked: !!hu.stackable }), 'stapelbar'),
    h('label', { class: 'field inline' }, h('input', { type: 'checkbox', name: 'rotatable', id: 'hu-rotatable', checked: !!hu.rotatable }), 'drehbar (90° auf der Grundfläche)'),
    h('label', { class: 'field inline' }, h('input', { type: 'checkbox', name: 'tiltable', id: 'hu-tiltable', checked: !!hu.tiltable }), 'kippbar (darf auf der Seite liegen)'),
    h('label', { class: 'field' }, 'Max. Auflast (kg) – leer = unbegrenzt',
      h('input', { type: 'number', name: 'max_top_load_kg', id: 'hu-max_top_load_kg', step: 'any', min: 0, value: hu.max_top_load_kg === null ? '' : String(hu.max_top_load_kg), inputmode: 'decimal' })),
    h('label', { class: 'field wide' }, 'Zielort', h('textarea', { name: 'destination', id: 'hu-destination', value: hu.destination, rows: 2, disabled: frozen })),
    h('label', { class: 'field wide' }, 'Bemerkung', h('textarea', { name: 'note', id: 'hu-note', value: hu.note, rows: 2 })),
    mayPack ? h('div', { class: 'row wide' }, h('button', { type: 'submit', class: 'btn primary' }, 'Packstückdaten speichern')) : null);
  if (!mayPack) for (const el of form.elements) el.disabled = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) body[k] = typeof v === 'string' ? v.trim() : v;
    for (const k of ['length_cm', 'width_cm', 'height_cm', 'tare_kg', 'net_kg', 'gross_kg', 'max_top_load_kg']) if (k in body) body[k] = body[k] === '' ? null : Number(body[k]);
    for (const k of ['stackable', 'rotatable', 'tiltable']) body[k] = form.elements[k].checked;
    if ('psp_id' in body) body.psp_id = body.psp_id ? Number(body.psp_id) : null;
    try {
      await put(`/hus/${hu.id}`, body);
      state.dirty = false;
      toast('Packstückdaten gespeichert.', 'ok');
      notifyChanged();
    } catch (err) { feedback(false); showError(err); }
  });

  const weights = h('dl', { class: 'kv' },
    h('dt', null, 'Netto berechnet'), h('dd', null, fmt.kg(hu.net_calc), hu.net_calc_complete ? '' : ' (Materialgewichte unvollständig)'),
    h('dt', null, 'Brutto'), h('dd', null, h('b', null, hu.gross_eff === null ? '–' : fmt.kg(hu.gross_eff)),
      hu.gross_source ? ` · ${hu.gross_source === 'GEWOGEN' ? 'gewogen' : 'berechnet aus Tara + Inhalt'}${hu.gross_complete ? '' : ' (unvollständig)'}` : ''),
    h('dt', null, 'Volumen'), h('dd', null, hu.volume_m3 === null ? '–' : `${fmt.num(hu.volume_m3, 3)} m³`),
    h('dt', null, 'Angelegt'), h('dd', null, `${fmt.dt(hu.created_at)} · ${hu.created_by || '–'}`),
    hu.closed_at ? [h('dt', null, 'Abgeschlossen'), h('dd', null, fmt.dt(hu.closed_at))] : null);

  const parentSel = h('select', { id: 'hu-parent', 'data-nodirty': '1' }, h('option', { value: '' }, '— eigenständig —'));
  const parentBox = h('div', { class: 'row' }, h('div', { style: { flex: '1 1 260px' } }, parentSel),
    btn('Übernehmen', async () => {
      try { await post(`/hus/${hu.id}/parent`, { parent_id: parentSel.value ? Number(parentSel.value) : null }); toast('Zuordnung gespeichert.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
    }));
  const canMove = ['OFFEN', 'VERSANDBEREIT'].includes(hu.ship_status) && !(d.path.length && d.path[d.path.length - 1].pack_status === 'ABGESCHLOSSEN');
  if (canMove && hu.packaging_type !== 'CONTAINER') {
    get(`/projects/${hu.project_id}/hus`).then((all) => {
      const blocked = new Set([hu.id]);
      let changed = true;
      while (changed) { changed = false; for (const x of all) if (x.parent_id && blocked.has(x.parent_id) && !blocked.has(x.id)) { blocked.add(x.id); changed = true; } }
      for (const x of all) {
        if (blocked.has(x.id) || x.pack_status === 'ABGESCHLOSSEN' || x.ship_status !== 'OFFEN') continue;
        parentSel.append(h('option', { value: String(x.id) }, `${x.package_number} · ${x.packaging_label}${x.description ? ' · ' + x.description : ''}`));
      }
      parentSel.value = hu.parent_id ? String(hu.parent_id) : '';
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- Seite zusammensetzen
  const onPhotoChange = () => notifyChanged();
  const page = h('div', { class: 'stack', style: { gap: '18px' } },
    head,
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack', style: { gap: '18px' } },
        packPanel,
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Inhalt (${d.contents.length} Positionen)`),
          d.contents.length ? btn('Alle Artikeletiketten', () => openLabelDialog(d.contents.map((c) => ({ kind: 'item', item_id: c.pack_item_id, hu_id: hu.id }))), { cls: 'small', icon: 'print' }) : null),
        h('div', { class: 'panel-body flush' }, contentTable)),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Enthaltene Packstücke (${d.children.length})`)),
          h('div', { class: 'panel-body' }, childTable || h('p', { class: 'muted small' }, packable ? 'Keine. Packstück-Etikett oben scannen, um z. B. eine Kiste in diesen Container zu packen.' : 'Keine.')))),
      h('div', { class: 'stack', style: { gap: '18px' } },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Packstückdaten')),
          h('div', { class: 'panel-body' }, weights, form)),
        mayPack && canMove && hu.packaging_type !== 'CONTAINER' ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Mehrstufige Verpackung')),
          h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'In welchem Packstück liegt dieses Packstück (z. B. Palette → Kiste → Container)?'), parentBox)) : null,
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Bilddokumentation (${d.photos.length})`)),
          h('div', { class: 'panel-body' }, photoPanel({ target: { hu_id: hu.id }, phases: ['VERPACKUNG', 'VERLADUNG'], photos: d.photos, onChange: onPhotoChange, readOnlyReason: mayPack || can('load') ? '' : 'Ihr Konto darf keine Bilder aufnehmen.' }))))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Verlauf dieses Packstücks')),
      h('div', { class: 'panel-body flush' }, eventsTable(d.events))));
  ctx.show(page);
  if (packable && !matchMedia('(pointer: coarse)').matches) document.getElementById('pack-scan')?.focus({ preventScroll: true });
}

