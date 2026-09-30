// Import von Excel-Packlisten, Projektübersichten, SAP-Exporten (PSP-Material) und Materialstamm (XLSX, XLS, CSV)
import { h, append, post, modal, toast, loadScript, fmt } from './core.js';

const FIELDS = {
  items: [
    { key: 'material', label: 'Materialnummer', required: true, syn: ['material', 'materialnummer', 'materialnr', 'matnr', 'artikel', 'artikelnummer', 'artikelnr', 'sachnummer', 'teilenummer', 'materialnumber', 'component', 'komponente'] },
    { key: 'description', label: 'Bezeichnung', syn: ['materialkurztext', 'kurztext', 'bezeichnung', 'materialbezeichnung', 'beschreibung', 'description', 'objektkurztext', 'text', 'benennung'] },
    { key: 'qty', label: 'Menge', required: true, syn: ['menge', 'bedarfsmenge', 'anzahl', 'stueck', 'stuck', 'qty', 'quantity', 'sollmenge', 'requirementquantity', 'stk'] },
    { key: 'unit', label: 'Mengeneinheit', syn: ['me', 'einheit', 'mengeneinheit', 'basismengeneinheit', 'bme', 'unit', 'uom', 'erfassungsmengeneinheit'] },
    { key: 'psp', label: 'PSP-Element', syn: ['pspelement', 'psp', 'pspnr', 'pspnummer', 'wbselement', 'wbs', 'projektstrukturplanelement'] },
    { key: 'psp_description', label: 'PSP-Bezeichnung', syn: ['pspbezeichnung', 'pspbeschreibung', 'pspkurztext', 'wbsdescription'] },
    { key: 'ref', label: 'Position / Referenz', syn: ['position', 'pos', 'posnr', 'reservierung', 'reservierungsnummer', 'vorgang', 'netzplanvorgang', 'item', 'lfdnr'] },
    { key: 'barcode', label: 'Barcode (EAN)', syn: ['barcode', 'ean', 'eannummer', 'gtin', 'eanupc'] },
    { key: 'supplier', label: 'Lieferant', syn: ['lieferant', 'kreditor', 'lieferantenname', 'supplier', 'vendor', 'name1'] },
    { key: 'purchase_order', label: 'Bestellung', syn: ['bestellung', 'bestellnummer', 'einkaufsbeleg', 'bestellnr', 'po', 'purchaseorder'] },
    { key: 'weight_kg', label: 'Gewicht je Einheit (kg)', syn: ['gewicht', 'nettogewicht', 'gewichtkg', 'weight', 'einzelgewicht'] },
    { key: 'note', label: 'Bemerkung', syn: ['bemerkung', 'hinweis', 'notiz', 'note', 'kommentar'] },
  ],
  cargo: [
    { key: 'name', label: 'Bezeichnung', required: true, syn: ['bezeichnung', 'name', 'artikel', 'beschreibung', 'packstueck', 'colli', 'description', 'item', 'ladegut'] },
    { key: 'length_cm', label: 'Länge (cm)', required: true, syn: ['laenge', 'laengecm', 'length', 'l', 'lcm'] },
    { key: 'width_cm', label: 'Breite (cm)', required: true, syn: ['breite', 'breitecm', 'width', 'b', 'w', 'bcm'] },
    { key: 'height_cm', label: 'Höhe (cm)', required: true, syn: ['hoehe', 'hoehecm', 'height', 'h', 'hcm'] },
    { key: 'weight_kg', label: 'Gewicht je Teil (kg)', syn: ['gewicht', 'gewichtkg', 'weight', 'bruttogewicht', 'kg'] },
    { key: 'qty', label: 'Anzahl', syn: ['anzahl', 'menge', 'stueck', 'stk', 'qty', 'quantity', 'count'] },
    { key: 'stackable', label: 'Stapelbar (ja/nein)', syn: ['stapelbar', 'stackable'] },
    { key: 'rotatable', label: 'Drehbar (ja/nein)', syn: ['drehbar', 'rotatable'] },
    { key: 'tiltable', label: 'Kippbar (ja/nein)', syn: ['kippbar', 'tiltable'] },
    { key: 'max_top_load_kg', label: 'Max. Auflast (kg)', syn: ['maxauflast', 'auflast', 'maxauflastkg', 'maxtopload'] },
    { key: 'stop', label: 'Entladestelle', syn: ['entladestelle', 'abladestelle', 'stop', 'gruppe', 'lieferadresse'] },
  ],
  materials: [
    { key: 'material', label: 'Materialnummer', required: true, syn: ['material', 'materialnummer', 'materialnr', 'matnr', 'artikel', 'artikelnummer', 'sachnummer'] },
    { key: 'description', label: 'Bezeichnung', syn: ['materialkurztext', 'kurztext', 'bezeichnung', 'materialbezeichnung', 'beschreibung', 'description', 'text'] },
    { key: 'unit', label: 'Basismengeneinheit', syn: ['me', 'einheit', 'mengeneinheit', 'basismengeneinheit', 'bme', 'unit', 'uom'] },
    { key: 'weight_kg', label: 'Gewicht je Einheit (kg)', syn: ['gewicht', 'nettogewicht', 'gewichtkg', 'weight'] },
    { key: 'barcode', label: 'Barcode', syn: ['barcode', 'ean', 'eannummer', 'gtin', 'eanupc', 'code'] },
    { key: 'symbology', label: 'Barcode-Art', syn: ['barcodeart', 'symbologie', 'symbology', 'eantyp', 'eancategory', 'eankategorie'] },
  ],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');

/** CSV-Zeichensatz erkennen: UTF-8, sonst Windows-1252 (deutsches Excel) */
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

async function readWorkbook(file) {
  await loadScript('/vendor/xlsx.full.min.js');
  const XLSX = window.XLSX;
  const buf = await file.arrayBuffer();
  const isText = /\.(csv|txt|tsv)$/i.test(file.name);
  const wb = isText
    ? XLSX.read(decodeText(buf).replace(/^﻿/, ''), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'array', cellDates: false });
  return { XLSX, wb };
}

/** Zeilen des Blatts; Leerzeilen bleiben erhalten, damit Zeilennummern exakt den Excel-Zeilen entsprechen */
function sheetRows(XLSX, ws) {
  if (!ws || !ws['!ref']) return { rows: [], offset: 0 };
  const offset = XLSX.utils.decode_range(ws['!ref']).s.r;
  return { rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true }), offset };
}

function detectHeader(rows, fields) {
  const all = new Set(fields.flatMap((f) => f.syn));
  let best = 0; let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const score = (rows[i] || []).filter((c) => all.has(norm(c))).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return bestScore > 0 ? best : rows.findIndex((r) => r.some((c) => String(c).trim() !== ''));
}

function autoMap(header, fields) {
  const map = {};
  const used = new Set();
  for (const f of fields) {
    const idx = header.findIndex((c, i) => !used.has(i) && f.syn.includes(norm(c)));
    if (idx >= 0) { map[f.key] = idx; used.add(idx); }
  }
  return map;
}

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const cellText = (v) => (v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v).trim());

/**
 * Import-Assistent. mode: 'items' (Packvorrat eines Projekts) oder 'materials' (Materialstamm)
 */
export function openImportWizard({ mode, projectId, planId, onDone }) {
  const fields = FIELDS[mode];
  const st = { XLSX: null, wb: null, sheet: '', rows: [], offset: 0, headerIdx: 0, map: {}, fileName: '' };

  const fileInput = h('input', { type: 'file', id: 'imp-file', accept: '.xlsx,.xlsm,.xls,.csv,.txt' });
  const sourceSel = h('select', { id: 'imp-source' },
    h('option', { value: 'EXCEL' }, 'Excel-Packliste / Projektübersicht'),
    h('option', { value: 'PSP' }, 'SAP-Export Projektmaterial (PSP-Elemente, z. B. CN52N)'),
    h('option', { value: 'LIEFERANT' }, 'Lieferantenmaterial (Lieferavis / Lieferantenliste)'));
  const listName = h('input', { type: 'text', id: 'imp-list', maxlength: 80, placeholder: 'z. B. Packliste Mechanik' });
  const fmtSel = h('select', { id: 'imp-fmt' }, h('option', { value: 'DE' }, 'Deutsch (1.234,5)'), h('option', { value: 'EN' }, 'Englisch (1,234.5)'));
  const sheetSel = h('select', { id: 'imp-sheet' });
  const headerSel = h('select', { id: 'imp-header' });
  const mapBox = h('div', { class: 'form-grid' });
  const preview = h('div', { class: 'stack' });
  const result = h('div', { class: 'stack' });

  const setupBox = h('div', { class: 'form-grid' },
    h('label', { class: 'field wide' }, 'Datei (XLSX, XLS oder CSV)', fileInput),
    mode === 'items' ? h('label', { class: 'field' }, 'Art der Liste', sourceSel) : null,
    mode === 'items' ? h('label', { class: 'field' }, 'Listenbezeichnung *', listName,
      h('span', { class: 'hint' }, 'Bei erneutem Import derselben Liste werden Mengen abgeglichen statt doppelt angelegt.')) : null,
    h('label', { class: 'field' }, 'Zahlenformat in Textzellen', fmtSel),
    h('label', { class: 'field' }, 'Tabellenblatt', sheetSel),
    h('label', { class: 'field' }, 'Überschriftenzeile', headerSel));

  function buildHeaderOptions() {
    headerSel.replaceChildren();
    st.rows.slice(0, 25).forEach((r, i) => {
      if (!r.some((c) => String(c).trim() !== '')) return;
      headerSel.append(h('option', { value: String(i) }, `Zeile ${st.offset + i + 1}: ${r.filter((c) => String(c).trim()).slice(0, 5).join(' | ').slice(0, 80)}`));
    });
    headerSel.value = String(st.headerIdx);
  }

  function buildMapping() {
    const header = st.rows[st.headerIdx] || [];
    mapBox.replaceChildren();
    for (const f of fields) {
      const sel = h('select', { id: `imp-map-${f.key}` },
        h('option', { value: '' }, '— nicht vorhanden —'),
        header.map((c, i) => h('option', { value: String(i) }, `${colName(i)}: ${String(c).slice(0, 40) || '(leer)'}`)));
      sel.value = st.map[f.key] !== undefined ? String(st.map[f.key]) : '';
      sel.addEventListener('change', () => {
        if (sel.value === '') delete st.map[f.key]; else st.map[f.key] = Number(sel.value);
        showPreview();
      });
      mapBox.append(h('label', { class: 'field' }, f.label + (f.required ? ' *' : ''), sel));
    }
    showPreview();
  }

  function dataRows() {
    const out = [];
    for (let i = st.headerIdx + 1; i < st.rows.length; i++) {
      const r = st.rows[i] || [];
      const row = { row_no: st.offset + i + 1 };
      let any = false;
      for (const f of fields) {
        if (st.map[f.key] === undefined) continue;
        const v = cellText(r[st.map[f.key]]);
        row[f.key] = typeof v === 'number' && ['material', 'barcode', 'ref', 'psp', 'name'].includes(f.key) ? String(v) : v;
        if (row[f.key] !== '') any = true;
      }
      if (any) out.push(row);
    }
    return out;
  }

  function showPreview() {
    const rows = dataRows();
    const cols = fields.filter((f) => st.map[f.key] !== undefined);
    preview.replaceChildren();
    append(preview, [
      h('p', { class: 'muted small' }, `${rows.length} Datenzeilen erkannt. Vorschau der ersten 8:`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Zeile'), cols.map((c) => h('th', null, c.label)))),
        h('tbody', null, rows.slice(0, 8).map((r) => h('tr', null, h('td', { class: 'num' }, r.row_no), cols.map((c) => h('td', null, String(r[c.key] ?? '')))))))),
    ]);
  }

  async function loadFile() {
    const file = fileInput.files[0];
    if (!file) return;
    result.replaceChildren();
    try {
      const { XLSX, wb } = await readWorkbook(file);
      st.XLSX = XLSX; st.wb = wb; st.fileName = file.name;
      if (mode === 'items' && !listName.value.trim()) listName.value = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
      sheetSel.replaceChildren();
      for (const n of wb.SheetNames) sheetSel.append(h('option', { value: n }, n));
      selectSheet(wb.SheetNames[0]);
    } catch (err) {
      result.replaceChildren(h('p', { class: 'notice bad' }, `Datei konnte nicht gelesen werden: ${err.message}`));
    }
  }

  function selectSheet(name) {
    st.sheet = name;
    sheetSel.value = name;
    const sr = sheetRows(st.XLSX, st.wb.Sheets[name]);
    st.rows = sr.rows;
    st.offset = sr.offset;
    st.headerIdx = Math.max(0, detectHeader(st.rows, fields));
    st.map = autoMap(st.rows[st.headerIdx] || [], fields);
    buildHeaderOptions();
    buildMapping();
  }

  fileInput.addEventListener('change', loadFile);
  sheetSel.addEventListener('change', () => selectSheet(sheetSel.value));
  headerSel.addEventListener('change', () => {
    st.headerIdx = Number(headerSel.value);
    st.map = autoMap(st.rows[st.headerIdx] || [], fields);
    buildMapping();
  });

  function payload(extra) {
    const missing = fields.filter((f) => f.required && st.map[f.key] === undefined);
    if (!st.wb) throw new Error('Bitte zuerst eine Datei auswählen.');
    if (missing.length) throw new Error(`Bitte Spalte zuordnen: ${missing.map((f) => f.label).join(', ')}.`);
    const rows = dataRows();
    if (!rows.length) throw new Error('Keine Datenzeilen gefunden.');
    const body = { rows, number_format: fmtSel.value, file_name: st.fileName, ...extra };
    if (mode === 'items') {
      body.source = sourceSel.value;
      body.list_name = listName.value.trim();
      if (!body.list_name) throw new Error('Bitte eine Listenbezeichnung angeben.');
    }
    return body;
  }
  const url = mode === 'items' ? `/projects/${projectId}/import` : mode === 'cargo' ? `/loadplans/${planId}/items/import` : '/materials/import';

  function showResult(res, committed) {
    const s = res.summary;
    const statusLabel = { NEU: 'neu', AKTUALISIERT: 'aktualisiert', UNVERAENDERT: 'unverändert', FEHLER: 'Fehler' };
    const errRows = res.rows.filter((r) => r.status === 'FEHLER');
    result.replaceChildren();
    append(result, [
      h('div', { class: `notice ${s.errors ? 'warn' : 'ok'}` },
        committed ? 'Import durchgeführt: ' : 'Prüfung: ',
        `${s.new} neu, ${s.updated} aktualisiert${s.unchanged !== undefined ? `, ${s.unchanged} unverändert` : ''}, ${s.errors} fehlerhafte Zeile(n).`),
      s.not_in_file && s.not_in_file.length ? h('div', { class: 'notice warn' },
        `${s.not_in_file.length} bestehende Position(en) dieser Liste fehlen in der Datei (werden nicht gelöscht): `,
        s.not_in_file.slice(0, 10).map((x) => `${x.material_number}${x.psp_code ? ' / ' + x.psp_code : ''} (${fmt.qty(x.qty_required, x.unit)})`).join(', '),
        s.not_in_file.length > 10 ? ' …' : '') : null,
      h('div', { class: 'table-wrap', style: { maxHeight: '260px', overflow: 'auto' } }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Zeile'), h('th', null, 'Ergebnis'), h('th', null, 'Details'))),
        h('tbody', null, [...errRows, ...res.rows.filter((r) => r.status !== 'FEHLER')].slice(0, 400).map((r) => h('tr', null,
          h('td', { class: 'num' }, r.row_no),
          h('td', null, h('span', { class: `tag ${r.status === 'FEHLER' ? 'warn' : r.status === 'NEU' ? 'ok' : ''}` }, statusLabel[r.status] || r.status)),
          h('td', null, r.message)))))),
    ]);
  }

  let checked = false;
  const m = modal({
    title: mode === 'items' ? 'Packvorrat importieren' : mode === 'cargo' ? 'Ladegut importieren' : 'Materialstamm importieren',
    wide: true,
    body: [
      mode === 'items'
        ? h('p', { class: 'hint' }, 'Übernimmt Excel-Packlisten, Projektübersichten, SAP-Exporte der Projektmaterialien (PSP-Elemente) oder Lieferantenlisten in den Packvorrat. Spalten werden automatisch erkannt und können angepasst werden.')
        : mode === 'cargo'
          ? h('p', { class: 'hint' }, 'Übernimmt zusätzliches Ladegut für die Ladeplanung (Bezeichnung, Maße in cm, Gewicht, Anzahl; optional stapelbar/drehbar/kippbar als ja/nein, maximale Auflast, Entladestelle).')
          : h('p', { class: 'hint' }, 'Übernimmt SAP-Materialnummern mit den vorhandenen Barcodes (z. B. aus MM60/SE16-Export). Ein Barcode gehört immer genau zu einem Material.'),
      setupBox, h('h3', null, 'Spaltenzuordnung'), mapBox, preview, result,
    ],
    actions: [
      { label: 'Abbrechen' },
      { label: 'Prüfen', onClick: async () => {
        const res = await post(url, payload({ dry_run: true }));
        showResult(res, false);
        checked = true;
      } },
      { label: 'Importieren', cls: 'primary', onClick: async (close) => {
        const pre = await post(url, payload({ dry_run: true }));
        if (pre.summary.errors && !checked) { showResult(pre, false); checked = true; throw new Error(`${pre.summary.errors} Zeile(n) fehlerhaft – bitte prüfen. Erneut „Importieren“ überspringt diese Zeilen.`); }
        const res = await post(url, payload({ skip_errors: true }));
        showResult(res, true);
        toast(`Import abgeschlossen: ${res.summary.new} neu, ${res.summary.updated} aktualisiert.`, 'ok');
        onDone?.();
        if (!res.summary.errors) close();
      } },
    ],
  });
  return m;
}
