'use strict';
// End-to-End-Tests der API (node --test)

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

let server; let base; let ctx; let dataDir;

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { 'X-User': encodeURIComponent('Test Prüfer'), ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}
const ok = async (method, url, body) => {
  const r = await call(method, url, body);
  assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const fails = async (method, url, body, status, pattern) => {
  const r = await call(method, url, body);
  assert.equal(r.status, status, `${method} ${url} erwartet ${status}, erhalten ${r.status} ${JSON.stringify(r.data)}`);
  if (pattern) assert.match(r.data.error, pattern);
  return r.data;
};

// Minimales gültiges JPEG (1×1 Pixel)
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
  ctx = createApp({ dataDir, auth: false }); // Fachlogik ohne Anmeldung, siehe auth.test.js
  server = http.createServer(ctx.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  ctx.close();
  await new Promise((r) => server.close(r));
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const S = {}; // gemeinsamer Zustand der Szenario-Tests

test('Projekt anlegen, Dublette abweisen', async () => {
  const p = await ok('POST', '/projects', { number: 'P-4711', name: 'TBM S-1234', customer: 'Kunde AG', destination: 'Baustelle Nord, Hamburg' });
  assert.equal(p.number, 'P-4711');
  S.pid = p.id;
  await fails('POST', '/projects', { number: 'P-4711' }, 409, /existiert bereits/);
  await fails('POST', '/projects', { number: '  ' }, 400, /Pflichtfeld/);
});

test('Materialstamm-Import mit vorhandenen SAP-Barcodes', async () => {
  const rows = [
    { row_no: 2, material: '000000000000100001', description: 'Schneidrad-Segment', unit: 'ST', weight_kg: '125,5', barcode: '100001' },
    { row_no: 3, material: '100002', description: 'Hydraulikschlauch DN20', unit: 'M', weight_kg: '0,8', barcode: 'HK-100002' },
    { row_no: 4, material: '100003', description: 'Dichtungssatz', unit: 'ST', weight_kg: '2', barcode: '4006381333931', symbology: 'EAN13' },
    { row_no: 5, material: '100004', description: 'Schraube M24', unit: 'ST', weight_kg: '0,4' },
  ];
  const dry = await ok('POST', '/materials/import', { rows, dry_run: true });
  assert.equal(dry.summary.new, 4);
  assert.equal(dry.summary.errors, 0);
  await ok('POST', '/materials/import', { rows });
  const m = await ok('GET', '/materials/100001');
  assert.equal(m.material_number, '100001', 'führende Nullen werden wie in SAP entfernt');
  assert.equal(m.weight_kg, 125.5);
  assert.equal(m.barcodes[0].barcode, '100001');
  // Barcode-Konflikt: gleicher Barcode für anderes Material
  const bad = await call('POST', '/materials/import', { rows: [{ material: '100004', barcode: 'HK-100002' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.rows[0].message, /gehört bereits zu Material 100002/);
  // Falsche EAN-Prüfziffer
  await fails('POST', '/materials/100004/barcodes', { barcode: '4006381333932', symbology: 'EAN13' }, 400, /Prüfziffer/);
});

test('Scan-Auflösung: Barcode, Materialnummer mit führenden Nullen, unbekannt', async () => {
  let r = await ok('GET', '/resolve?code=HK-100002');
  assert.equal(r.kind, 'material');
  assert.equal(r.material_number, '100002');
  r = await ok('GET', '/resolve?code=0000100004');
  assert.equal(r.kind, 'material');
  assert.equal(r.material_number, '100004');
  r = await ok('GET', '/resolve?code=XYZ-unbekannt');
  assert.equal(r.kind, 'unknown');
});

test('Packvorrat aus PSP-Export: Vorschau, Import, erneuter Import (Abgleich), Fehler', async () => {
  const rows = [
    { row_no: 2, psp: 'P-4711.01', psp_description: 'Schneidrad', material: '100001', qty: '4', unit: 'ST' },
    { row_no: 3, psp: 'P-4711.02', psp_description: 'Hydraulik', material: '100002', qty: '12,5', unit: 'M' },
    { row_no: 4, psp: 'P-4711.02', material: '100003', qty: '3' },
    { row_no: 5, psp: 'P-4711.02', material: '100003', qty: '2' },
    { row_no: 6, psp: 'P-4711.01', material: '100004', qty: '1.000' },
    { row_no: 7, psp: 'P-4711.01', material: '999999', qty: '1' },
    { row_no: 8, psp: 'P-4711.01', material: '100004', qty: '1,5' },
  ];
  const dry = await ok('POST', `/projects/${S.pid}/import`, { source: 'PSP', list_name: 'SAP CN52N', rows, dry_run: true, number_format: 'DE' });
  assert.equal(dry.summary.new, 4);
  assert.equal(dry.summary.errors, 2);
  const byRow = Object.fromEntries(dry.rows.map((r) => [r.row_no, r]));
  assert.match(byRow[7].message, /unbekannt/);
  assert.match(byRow[8].message, /ganzzahlig/);
  assert.match(byRow[4].message, /zusammengefasst/);
  // Ohne skip_errors wird nichts importiert
  await fails('POST', `/projects/${S.pid}/import`, { source: 'PSP', list_name: 'SAP CN52N', rows }, 400, /fehlerhafte Zeilen/);
  assert.equal((await ok('GET', `/projects/${S.pid}/items`)).length, 0);
  const res = await ok('POST', `/projects/${S.pid}/import`, { source: 'PSP', list_name: 'SAP CN52N', rows, skip_errors: true });
  assert.equal(res.summary.new, 4);
  const items = await ok('GET', `/projects/${S.pid}/items`);
  assert.equal(items.length, 4);
  const dicht = items.find((i) => i.material_number === '100003');
  assert.equal(dicht.qty_required, 5, 'Zeilen 4+5 zusammengefasst');
  assert.equal(items.find((i) => i.material_number === '100004').qty_required, 1000, 'DE-Format: 1.000 = 1000');
  assert.equal(items.find((i) => i.material_number === '100002').qty_required, 12.5);
  assert.ok(items.every((i) => i.status === 'ANGELEGT'));
  // Erneuter Import: unverändert; geänderte Menge wird aktualisiert, fehlende Position gemeldet
  const again = await ok('POST', `/projects/${S.pid}/import`, {
    source: 'PSP', list_name: 'SAP CN52N', dry_run: true,
    rows: [
      { psp: 'P-4711.01', material: '100001', qty: 4 },
      { psp: 'P-4711.02', material: '100002', qty: 12.5, unit: 'M' },
      { psp: 'P-4711.02', material: '100003', qty: 6 },
    ],
  });
  assert.equal(again.summary.unchanged, 2);
  assert.equal(again.summary.updated, 1);
  assert.equal(again.summary.not_in_file.length, 1);
  assert.equal(again.summary.not_in_file[0].material_number, '100004');
  const psp = await ok('GET', `/projects/${S.pid}/psp`);
  assert.deepEqual(psp.map((p) => p.code), ['P-4711.01', 'P-4711.02']);
  S.psp1 = psp[0].id; S.psp2 = psp[1].id;
});

test('Manuelle Position und Lieferantenmaterial', async () => {
  await fails('POST', `/projects/${S.pid}/items`, { source: 'LIEFERANT', material_number: 'LIEF-77', description: 'Förderband-Motor', qty_required: 1 }, 400, /Lieferant/);
  const sup = await ok('POST', `/projects/${S.pid}/items`, {
    source: 'LIEFERANT', material_number: 'LIEF-77', description: 'Förderband-Motor', qty_required: 1, supplier: 'Motoren GmbH',
    purchase_order: '4500012345', barcode: 'SUP-77-X', psp_id: S.psp1,
  });
  assert.equal(sup.source, 'LIEFERANT');
  assert.equal(sup.psp_code, 'P-4711.01');
  S.supItem = sup.id;
  const man = await ok('POST', `/projects/${S.pid}/items`, { material_number: '100003', qty_required: 2, psp_id: S.psp1, note: 'Reserve' });
  assert.equal(man.source, 'MANUELL');
  assert.equal(man.description, 'Dichtungssatz');
  S.manItem = man.id;
  await fails('POST', `/projects/${S.pid}/items`, { material_number: 'NEU-1', qty_required: 1 }, 400, /Bezeichnung/);
  await fails('POST', `/projects/${S.pid}/items`, { material_number: '100001', qty_required: 1.5 }, 400, /ganzzahlig/);
  await fails('POST', `/projects/${S.pid}/items`, { material_number: '100001', qty_required: 0 }, 400, /größer als 0/);
});

test('Status manuell (Material angefordert / Kommissioniert)', async () => {
  const items = await ok('GET', `/projects/${S.pid}/items`);
  await ok('POST', '/items/status', { ids: items.map((i) => i.id), status: 'ANGEFORDERT' });
  await ok('POST', '/items/status', { ids: [items[0].id], status: 'KOMMISSIONIERT' });
  await fails('POST', '/items/status', { ids: [items[0].id], status: 'VERLADEN' }, 400, /Ungültiger Status/);
  const after = await ok('GET', `/projects/${S.pid}/items`);
  assert.equal(after.find((i) => i.id === items[0].id).status_label, 'Kommissioniert');
  assert.equal(after.find((i) => i.id === items[1].id).status_label, 'Material angefordert');
});

test('Handling Unit anlegen, Material scannen und verpacken', async () => {
  const kiste = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'KISTE', description: 'Kiste Schneidrad 1', psp_id: S.psp1, location: 'Sammelplatz A3' });
  assert.match(kiste.hu_number, /^HU\d{8}$/);
  assert.equal(kiste.package_number, 'P-4711-001');
  assert.equal(kiste.status, 'ANGELEGT');
  assert.equal(kiste.destination, 'Baustelle Nord, Hamburg', 'Zielort aus Projekt');
  S.kiste = kiste;
  await fails('POST', `/projects/${S.pid}/hus`, { packaging_type: 'FASS' }, 400, /Verpackungsart/);

  // Scan per SAP-Barcode
  let r = await ok('POST', `/hus/${kiste.id}/pack`, { code: '100001', qty: 2 });
  assert.equal(r.hu.status, 'VERPACKUNG_BEGONNEN');
  assert.equal(r.item.qty_packed, 2);
  assert.equal(r.item.status, 'VERPACKUNG_BEGONNEN');
  // Überverpackung verhindert
  await fails('POST', `/hus/${kiste.id}/pack`, { code: '100001', qty: 3 }, 400, /übersteigt die offene Menge/);
  // Ganzzahligkeit
  await fails('POST', `/hus/${kiste.id}/pack`, { code: '100001', qty: 0.5 }, 400, /ganzzahlig/);
  // Unbekannter Code
  await fails('POST', `/hus/${kiste.id}/pack`, { code: 'NIX' }, 404, /keinem Material zugeordnet/);
  // Material, das nicht im Packvorrat ist
  await ok('POST', '/materials', { material_number: '555', description: 'Fremdteil', unit: 'ST' });
  await fails('POST', `/hus/${kiste.id}/pack`, { code: '555' }, 400, /nicht im Packvorrat/);
  // Mehrdeutig: 100003 kommt in PSP .02 (Import) und .01 (manuell) vor → HU hat PSP .01 → eindeutig
  r = await ok('POST', `/hus/${kiste.id}/pack`, { code: '4006381333931', qty: 2 });
  assert.equal(r.item.id, S.manItem, 'Position mit passendem PSP-Element der HU gewählt');
  // Nun ist .01 voll verpackt → nur noch .02 offen → eindeutig
  r = await ok('POST', `/hus/${kiste.id}/pack`, { code: '4006381333931', qty: 1 });
  assert.equal(r.item.psp_code, 'P-4711.02');
  // Lieferantenbarcode
  r = await ok('POST', `/hus/${kiste.id}/pack`, { code: 'SUP-77-X' });
  assert.equal(r.item.id, S.supItem);
  await fails('POST', `/hus/${kiste.id}/pack`, { code: 'SUP-77-X' }, 400, /vollständig verpackt/);
  // HU-Code beim Materialscan
  await fails('POST', `/hus/${kiste.id}/pack`, { code: kiste.hu_number }, 400, /Packstück hinzufügen/);
});

test('Mehrdeutige Position → Auswahl nötig (409 mit Kandidaten)', async () => {
  const box = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'KARTON', description: 'Karton ohne PSP' });
  // zweite offene Position für 100002 in anderem PSP anlegen
  const extra = await ok('POST', `/projects/${S.pid}/items`, { material_number: '100002', qty_required: 5, unit: 'M', psp_id: S.psp1 });
  const r = await fails('POST', `/hus/${box.id}/pack`, { code: 'HK-100002', qty: 1 }, 409, /mehrfach/);
  assert.equal(r.candidates.length, 2);
  const packed = await ok('POST', `/hus/${box.id}/pack`, { pack_item_id: extra.id, qty: 2.5 });
  assert.equal(packed.item.qty_packed, 2.5);
  // Entnehmen bis leer → Status zurück auf Angelegt
  const un = await ok('POST', `/hus/${box.id}/unpack`, { pack_item_id: extra.id });
  assert.equal(un.hu.status, 'ANGELEGT');
  assert.equal(un.item.qty_packed, 0);
  await ok('DELETE', `/hus/${box.id}`);
  await ok('DELETE', `/items/${extra.id}`);
});

test('Fehlteil melden, Status und automatische Auflösung', async () => {
  const items = await ok('GET', `/projects/${S.pid}/items`);
  const it = items.find((i) => i.material_number === '100001');
  assert.equal(it.qty_open, 2);
  await fails('POST', `/items/${it.id}/missing`, { qty_missing: 3 }, 400, /größer als die offene Menge/);
  const m = await ok('POST', `/items/${it.id}/missing`, { qty_missing: 2, reason: 'Noch in Fertigung', expected: '2026-10-15' });
  assert.equal(m.status, 'FEHLTEIL');
  assert.equal(m.qty_missing_eff, 2);
  const sh = await ok('GET', `/projects/${S.pid}/shortages`);
  assert.equal(sh.open.length, 1);
  S.missingItem = it.id;
});

test('Mehrstufige Verpackung: Kiste → Container, Regeln', async () => {
  const cont = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'CONTAINER', description: '40ft Container' });
  const pal = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'PALETTE', description: 'Palette Kleinteile' });
  S.cont = cont; S.pal = pal;
  await ok('POST', `/hus/${pal.id}/pack`, { code: '100004', qty: 400 });
  // Container darf nicht in etwas anderes
  await fails('POST', `/hus/${cont.id}/parent`, { parent_id: pal.id }, 400, /Container/);
  // Palette in Kiste, Kiste in Container
  await ok('POST', `/hus/${S.kiste.id}/children`, { code: pal.package_number });
  await ok('POST', `/hus/${cont.id}/children`, { code: S.kiste.hu_number });
  // Kreis verhindern
  await fails('POST', `/hus/${S.kiste.id}/parent`, { parent_id: pal.id }, 400, /Kreis/);
  await fails('POST', `/hus/${pal.id}/children`, { child_id: pal.id }, 400, /sich selbst/);
  const det = await ok('GET', `/hus/${pal.id}`);
  assert.deepEqual(det.path.map((p) => p.packaging_type), ['CONTAINER', 'KISTE']);
  // Abschließen von außen nach innen verboten
  await fails('POST', `/hus/${cont.id}/action`, { action: 'close' }, 400, /noch nicht abgeschlossen/);
  await fails('POST', `/hus/${S.kiste.id}/action`, { action: 'close' }, 400, /noch nicht abgeschlossen/);
  await ok('POST', `/hus/${pal.id}/action`, { action: 'close' });
  await fails('POST', `/hus/${pal.id}/pack`, { code: '100004', qty: 1 }, 400, /abgeschlossen/);
  await ok('POST', `/hus/${S.kiste.id}/action`, { action: 'close' });
  await ok('POST', `/hus/${cont.id}/action`, { action: 'close' });
  // Inneres nicht mehr öffnen, solange äußeres geschlossen
  await fails('POST', `/hus/${S.kiste.id}/action`, { action: 'reopen' }, 400, /abgeschlossenen Packstück/);
  // Versandbereit nur äußerstes
  await fails('POST', `/hus/${S.kiste.id}/action`, { action: 'ready' }, 400, /äußerste/);
  // Ohne Maße/Gewicht nicht versandbereit
  await fails('POST', `/hus/${cont.id}/action`, { action: 'ready' }, 400, /Abmessungen/);
  // Gewicht berechnet unvollständig (Tara fehlt) → Hinweis
  await ok('PUT', `/hus/${cont.id}`, { length_cm: 1203, width_cm: 235, height_cm: 239 });
  await fails('POST', `/hus/${cont.id}/action`, { action: 'ready' }, 400, /vollständiges Bruttogewicht/);
  await ok('PUT', `/hus/${cont.id}`, { gross_kg: 6500 });
  const ready = await ok('POST', `/hus/${cont.id}/action`, { action: 'ready' });
  assert.equal(ready.status, 'VERSANDBEREIT');
  const inner = await ok('GET', `/hus/${pal.id}`);
  assert.equal(inner.hu.ship_status, 'VERSANDBEREIT', 'Versandstatus an enthaltene HUs weitergegeben');
  // Gewicht darf bei versandbereit nicht entfernt werden
  await fails('PUT', `/hus/${cont.id}`, { gross_kg: null }, 400, /versandbereit/);
  const items = await ok('GET', `/projects/${S.pid}/items`);
  assert.equal(items.find((i) => i.material_number === '100004').status, 'VERPACKUNG_BEGONNEN', '400 von 1000 verpackt');
  assert.equal(items.find((i) => i.id === S.supItem).status, 'VERSANDBEREIT', 'vollständig verpackt, Container versandbereit');
});

test('Gewichtsberechnung (Tara + Material + Unterpackstücke)', async () => {
  const hus = await ok('GET', `/projects/${S.pid}/hus`);
  const pal = hus.find((h) => h.id === S.pal.id);
  assert.equal(pal.net_calc, 160, '400 × 0,4 kg');
  assert.equal(pal.gross_source, 'BERECHNET');
  assert.equal(pal.gross_complete, false, 'Tara fehlt');
  const cont = hus.find((h) => h.id === S.cont.id);
  assert.equal(cont.gross_eff, 6500);
  assert.equal(cont.gross_source, 'GEWOGEN');
});

test('Verladung, Warenausgang, Zustellung, Nachlieferung', async () => {
  await fails('POST', `/projects/${S.pid}/deliveries`, { planned_date: '15.10.2026' }, 400, /Datum/);
  const d = await ok('POST', `/projects/${S.pid}/deliveries`, { carrier: 'Spedition Muster', planned_date: '2026-10-01' });
  assert.equal(d.kind, 'HAUPT');
  assert.match(d.number, /^L\d{4}\d{5}$/);
  S.del = d;
  // Inneres Packstück verladen → Hinweis auf äußeres
  await fails('POST', `/deliveries/${d.id}/load`, { code: S.pal.hu_number }, 400, /Bitte P-4711-00\d verladen/);
  const r = await ok('POST', `/deliveries/${d.id}/load`, { code: S.cont.hu_number });
  assert.equal(r.delivery.status, 'IN_VERLADUNG');
  assert.equal(r.hu.status, 'VERLADEN');
  await fails('POST', `/deliveries/${d.id}/load`, { code: S.cont.hu_number }, 400, /bereits auf dieser Lieferung/);
  // Nicht versandbereites Packstück
  const k2 = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'GROSSCOLLI', description: 'Vortriebszylinder' });
  await fails('POST', `/deliveries/${d.id}/load`, { hu_id: k2.id }, 400, /nicht versandbereit/);
  await ok('DELETE', `/hus/${k2.id}`);
  // Verladene HU ist eingefroren
  await fails('PUT', `/hus/${S.cont.id}`, { gross_kg: 7000 }, 400, /bereits verladen/);
  await fails('POST', `/hus/${S.cont.id}/action`, { action: 'reopen' }, 400, /verladen/);
  // Abschluss ohne Kennzeichen verhindert
  await fails('POST', `/deliveries/${d.id}/action`, { action: 'complete' }, 400, /Kennzeichen/);
  await ok('PUT', `/deliveries/${d.id}`, { truck_plate: 'OG-HK 123', driver: 'M. Fahrer' });
  const done = await ok('POST', `/deliveries/${d.id}/action`, { action: 'complete' });
  assert.equal(done.status, 'VERLADEN');
  let items = await ok('GET', `/projects/${S.pid}/items`);
  const schraube = items.find((i) => i.material_number === '100004');
  assert.equal(schraube.qty_packed, 400);
  assert.equal(schraube.status, 'VERPACKUNG_BEGONNEN', 'nur 400 von 1000 verpackt');
  const motor = items.find((i) => i.id === S.supItem);
  assert.equal(motor.status, 'VERLADEN');
  assert.equal(motor.placements[0].delivery_number, d.number);
  await fails('PUT', `/deliveries/${d.id}`, { number: 'X-1' }, 400, /Warenausgang/);
  const deliv = await ok('POST', `/deliveries/${d.id}/action`, { action: 'delivered' });
  assert.equal(deliv.status, 'AUSGELIEFERT');
  items = await ok('GET', `/projects/${S.pid}/items`);
  assert.equal(items.find((i) => i.id === S.supItem).status, 'AUSGELIEFERT');
  const nested = await ok('GET', `/hus/${S.pal.id}`);
  assert.equal(nested.hu.ship_status, 'AUSGELIEFERT');
  // Folgelieferung wird automatisch als Nachlieferung angelegt
  const d2 = await ok('POST', `/projects/${S.pid}/deliveries`, {});
  assert.equal(d2.kind, 'NACHLIEFERUNG');
  S.del2 = d2;
});

test('Fehlteil wird durch Nachlieferung aufgelöst', async () => {
  const box = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'KISTE', description: 'Nachlieferung Segmente', tare_kg: 40, length_cm: 120, width_cm: 80, height_cm: 90 });
  const r = await ok('POST', `/hus/${box.id}/pack`, { code: '100001', qty: 2 });
  assert.equal(r.item.qty_missing_eff, 0);
  assert.equal(r.item.status, 'VERPACKUNG_BEGONNEN');
  await ok('POST', `/hus/${box.id}/action`, { action: 'close' });
  const hu = await ok('POST', `/hus/${box.id}/action`, { action: 'ready' });
  assert.equal(hu.gross_eff, 40 + 2 * 125.5, 'Brutto = Tara + Materialgewichte');
  assert.equal(hu.gross_complete, true);
  await ok('POST', `/deliveries/${S.del2.id}/load`, { code: box.package_number });
  const sh = await ok('GET', `/projects/${S.pid}/shortages`);
  assert.equal(sh.open.length, 0);
  assert.equal(sh.resolved.length, 1);
  assert.equal(sh.resolved[0].placements.at(-1).delivery_kind, 'NACHLIEFERUNG');
  S.box = box;
});

test('Bilddokumentation am Packstück und an der Lieferung', async () => {
  const qs = (o) => new URLSearchParams(o).toString();
  const upload = (params, body = JPEG, type = 'image/jpeg') => call('POST', `/photos?${qs(params)}`, body, { 'Content-Type': type });
  let r = await upload({ hu_id: S.box.id, phase: 'VERPACKUNG', category: 'INNENAUFNAHME', note: 'Innen' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.category_label, 'Innenaufnahme Kiste');
  r = await upload({ hu_id: S.box.id, phase: 'VERPACKUNG', category: 'LADUNGSSICHERUNG' });
  assert.equal(r.status, 400);
  r = await upload({ hu_id: S.box.id, phase: 'VERPACKUNG', category: 'INNENAUFNAHME' }, Buffer.from('keinbild'));
  assert.equal(r.status, 400);
  // Verladebild am Packstück → automatisch auch der Lieferung zugeordnet
  r = await upload({ hu_id: S.box.id, phase: 'VERLADUNG', category: 'LADUNGSSICHERUNG' });
  assert.equal(r.status, 200);
  assert.equal(r.data.delivery_id, S.del2.id);
  // Lieferungsbild (Kennzeichen)
  r = await upload({ delivery_id: S.del2.id, phase: 'VERLADUNG', category: 'KENNZEICHEN' });
  assert.equal(r.status, 200);
  const photoId = r.data.id;
  const file = await fetch(`${base}/photos/${photoId}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  const det = await ok('GET', `/hus/${S.box.id}`);
  assert.equal(det.photos.length, 3, 'eigene Bilder + Lieferungsbild');
  // Nach Warenausgang nicht löschbar
  await ok('PUT', `/deliveries/${S.del2.id}`, { truck_plate: 'OG-HK 456' });
  await ok('POST', `/deliveries/${S.del2.id}/action`, { action: 'complete' });
  await fails('DELETE', `/photos/${photoId}`, undefined, 400, /Warenausgang/);
  // Bilder zu ausgelieferter Lieferung eines alten Packstücks: nicht lösbar – neue Bilder vor Warenausgang löschbar
  const tmp = await ok('POST', `/projects/${S.pid}/hus`, { packaging_type: 'KARTON' });
  r = await upload({ hu_id: tmp.id, phase: 'VERPACKUNG', category: 'SONSTIGES' });
  await ok('DELETE', `/photos/${r.data.id}`);
});

test('Rückwärtssuche nach Material, PSP, Packstück, Lieferung, Kennzeichen', async () => {
  let s = await ok('GET', `/search?q=100001&project_id=${S.pid}`);
  assert.equal(s.exact.kind, 'material');
  const it = s.items.find((i) => i.material_number === '100001');
  assert.equal(it.placements.length, 2);
  assert.ok(it.placements.some((p) => p.delivery_kind === 'NACHLIEFERUNG'));
  assert.ok(s.photos.length >= 1);
  assert.ok(s.photos.some((p) => p.category === 'KENNZEICHEN' && p.hu_id === null), 'Verladebild der Lieferung wird beim Material angezeigt');
  s = await ok('GET', '/search?q=P-4711.02');
  assert.ok(s.items.length >= 2);
  s = await ok('GET', `/search?q=${encodeURIComponent('OG-HK 123')}`);
  assert.equal(s.deliveries.length, 1);
  assert.equal(s.deliveries[0].status, 'AUSGELIEFERT');
  s = await ok('GET', `/search?q=${S.kiste.hu_number}`);
  assert.equal(s.exact.kind, 'hu');
  assert.equal(s.hus[0].delivery_number, S.del.number);
  s = await ok('GET', `/search?q=${S.del.number}`);
  assert.equal(s.exact.kind, 'delivery');
  await fails('GET', '/search?q=x', undefined, 400, /mindestens 2/);
  // LIKE-Platzhalter werden maskiert
  s = await ok('GET', '/search?q=%25%25');
  assert.equal(s.items.length, 0);
});

test('Etiketten: Daten, ZPL, Netzwerkdruck', async () => {
  const items = await ok('GET', `/projects/${S.pid}/items`);
  const it = items.find((i) => i.material_number === '100003' && i.psp_code === 'P-4711.02');
  const labels = await ok('POST', '/labels/data', { labels: [{ kind: 'hu', hu_id: S.cont.id }, { kind: 'item', item_id: it.id, hu_id: S.kiste.id, copies: 2 }] });
  assert.equal(labels.length, 3);
  const hu = labels[0];
  for (const k of ['hu_number', 'project_number', 'package_number', 'psp', 'weight_kg', 'length_cm', 'ship_status', 'destination', 'qr']) assert.ok(k in hu, k);
  assert.equal(hu.barcode.value, S.cont.hu_number);
  assert.equal(labels[1].qty, 1, 'Menge im Packstück');
  assert.equal(labels[1].barcode.value, '4006381333931', 'vorhandener SAP-Barcode, keine neue Barcodewelt');
  assert.equal(labels[1].barcode.symbology, 'EAN13');
  const zplRes = await fetch(`${base}/labels/zpl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ labels: [{ kind: 'hu', hu_id: S.cont.id }, { kind: 'item', item_id: it.id }] }) });
  const zpl = await zplRes.text();
  assert.equal((zpl.match(/\^XA/g) || []).length, 2);
  assert.ok(zpl.includes(S.cont.hu_number));
  assert.ok(zpl.includes('^BEN'), 'EAN-13 im ZPL');
  assert.ok(zpl.includes('^BQN'), 'QR-Code im ZPL');
  // Netzwerkdrucker simulieren
  let received = '';
  const printerSrv = net.createServer((s) => { s.on('data', (d) => { received += d.toString('utf8'); }); });
  await new Promise((r) => printerSrv.listen(0, '127.0.0.1', r));
  const pr = await ok('POST', '/printers', { name: 'Zebra Versand', host: '127.0.0.1', port: printerSrv.address().port, dpi: 300 });
  const res = await ok('POST', '/print', { printer_id: pr.id, labels: [{ kind: 'hu', hu_id: S.box.id }] });
  assert.equal(res.count, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(received.includes('^XA') && received.includes(S.box.hu_number));
  assert.ok(received.includes('^PW1181'), '300 dpi → 100 mm = 1181 Punkte');
  printerSrv.close();
  await fails('POST', '/printers', { name: 'x', host: 'bad host!' }, 400, /IP-Adresse/);
});

test('SAP-Rückmeldung: Warteschlange und Übertragung an Endpunkt', async () => {
  let ob = await ok('GET', '/sap/outbox');
  assert.ok(ob.stats.PENDING > 10);
  const types = new Set(ob.rows.map((r) => r.type));
  for (const t of ['HU_CREATED', 'HU_ITEM_PACKED', 'HU_STATUS', 'HU_LOADED', 'DELIVERY_GOODS_ISSUE', 'DELIVERY_DELIVERED', 'MATERIAL_SHORTAGE']) assert.ok(types.has(t), t);
  // Test-Endpunkt: erst Fehler, dann ok
  const got = [];
  let fail = true;
  const sapSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (fail) { res.writeHead(500); res.end('down'); return; }
      got.push(JSON.parse(b));
      res.writeHead(201); res.end('{}');
    });
  });
  await new Promise((r) => sapSrv.listen(0, '127.0.0.1', r));
  await fails('PUT', '/settings', { sap_endpoint: 'ftp://x' }, 400, /http/);
  await ok('PUT', '/settings', { sap_enabled: '1', sap_endpoint: `http://127.0.0.1:${sapSrv.address().port}/soma`, sap_auth: 'Basic dGVzdDp0ZXN0' });
  await ctx.domain.sap.processQueue();
  ob = await ok('GET', '/sap/outbox');
  assert.equal(ob.stats.ERROR, 1, 'erste Nachricht fehlgeschlagen, Rest wartet (Reihenfolge)');
  assert.equal(ob.stats.SENT, 0);
  fail = false;
  await ctx.domain.sap.processQueue();
  ob = await ok('GET', '/sap/outbox');
  assert.equal(ob.stats.PENDING + ob.stats.ERROR, 0);
  const ids = got.map((g) => g.messageId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'Reihenfolge eingehalten');
  assert.equal(got[0].type, 'MATERIAL_STATUS');
  const s = await ok('GET', '/settings');
  assert.equal(s.sap_auth, '••••••', 'Zugangsdaten werden nicht ausgeliefert');
  await ok('PUT', '/settings', { sap_enabled: '0' });
  sapSrv.close();
});

test('SAP-Eingangsschnittstelle (PSP-Material-Push)', async () => {
  const r = await ok('POST', '/integration/psp-materials', {
    project_number: 'P-9000', project_name: 'Mixschild', items: [
      { psp: 'P-9000.10', material: '100001', qty: 2, unit: 'ST' },
      { psp: 'P-9000.10', material: '100002', qty: 3.25, unit: 'M' },
    ],
  });
  assert.equal(r.summary.new, 2);
  const projects = await ok('GET', '/projects');
  const p = projects.find((x) => x.number === 'P-9000');
  assert.equal(p.summary.positions, 2);
});

test('Projektübersicht, Protokoll (Rückverfolgbarkeit)', async () => {
  const p = await ok('GET', `/projects/${S.pid}`);
  assert.ok(p.summary.positions > 0);
  assert.ok(p.summary.hu_total >= 4);
  assert.equal(p.summary.supplementary_deliveries, 1);
  const ev = await ok('GET', `/events?entity=hu&entity_id=${S.kiste.id}`);
  const actions = ev.map((e) => e.action);
  for (const a of ['Packstück angelegt', 'Material verpackt', 'Packstück aufgenommen', 'In Packstück verpackt', 'Status']) assert.ok(actions.includes(a), a);
  assert.ok(ev.every((e) => e.user === 'Test Prüfer'));
});

test('Löschschutz und Validierung', async () => {
  await fails('DELETE', `/items/${S.supItem}`, undefined, 400, /verpackt/);
  await fails('DELETE', `/psp/${S.psp1}`, undefined, 400, /verwendet/);
  await fails('DELETE', `/deliveries/${S.del.id}`, undefined, 400, /geplante/);
  await fails('PUT', `/projects/${S.pid}`, { number: 'P-NEU' }, 400, /Packstücke/);
  await fails('GET', '/hus/999999', undefined, 404);
  await fails('GET', '/hus/abc', undefined, 404);
  const it = (await ok('GET', `/projects/${S.pid}/items`)).find((i) => i.material_number === '100001');
  await fails('PUT', `/items/${it.id}`, { qty_required: 3 }, 400, /kleiner als die bereits verpackte/);
  await fails('PUT', '/settings', { barcode_regex: '([' }, 400, /regulärer Ausdruck/);
});

test('Barcode-Muster (regulärer Ausdruck) für zusammengesetzte Etiketten', async () => {
  await ok('PUT', '/settings', { barcode_regex: '^MAT:([^;]+);' });
  const r = await ok('GET', `/resolve?code=${encodeURIComponent('MAT:100002;QTY:5')}`);
  assert.equal(r.kind, 'material');
  assert.equal(r.material_number, '100002');
  await ok('PUT', '/settings', { barcode_regex: '' });
});
