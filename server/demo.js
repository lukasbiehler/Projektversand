'use strict';
// Demo-Modus (z. B. auf Vercel): Daten im temporären Speicher, Beispielprojekt beim Start, Zurücksetzen per Knopfdruck.
// Die Daten sind nicht dauerhaft – sie gehen beim Neustart der Instanz verloren und werden dann neu angelegt.

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');

const USER = 'Demo';

/** Beispielprojekt wie in docs/TESTANLEITUNG.md, mit offenen Aufgaben für die Live-Vorführung */
function seedSample({ domain: d, loadplans: lp }) {
  d.importMaterials(USER, {
    file_name: '1_materialstamm.csv',
    rows: [
      { material: '000000000000200001', description: 'Schneidrolle 17" Einring', unit: 'ST', weight_kg: 165, barcode: '200001' },
      { material: '200002', description: 'Schälmesser 250 mm', unit: 'ST', weight_kg: 18.5, barcode: '200002' },
      { material: '200003', description: 'Dichtungssatz Hauptlager', unit: 'ST', weight_kg: 4.2, barcode: '4006381333931', symbology: 'EAN13' },
      { material: '200004', description: 'Hydraulikschlauch DN25 4SH', unit: 'M', weight_kg: 1.1, barcode: 'HK-200004' },
      { material: '200005', description: 'Sechskantschraube M30x160 10.9', unit: 'ST', weight_kg: 1.05 },
      { material: '200006', description: 'Förderschnecken-Verschleißblech', unit: 'ST', weight_kg: 38, barcode: '200006' },
      { material: '200007', description: 'Schmierfett EP2 18-kg-Eimer', unit: 'ST', weight_kg: 19, barcode: '4012345678901', symbology: 'EAN13' },
      { material: '200008', description: 'Kabel NYY-J 5x25', unit: 'M', weight_kg: 1.6, barcode: 'HK-200008' },
    ],
  });
  const p = d.createProject(USER, {
    number: 'P-25001', name: 'TBM S-1400 EPB-Schild', customer: 'ARGE Nordtunnel',
    destination: 'Baustelle Startschacht Nord, Hafenstraße 12, 20457 Hamburg',
  });
  d.importItems(USER, p.id, {
    source: 'PSP', list_name: '2_sap_projektbedarf', file_name: '2_sap_projektbedarf.xlsx', number_format: 'EN', rows: [
      { row_no: 4, psp: 'P-25001.01.01', psp_description: 'Schneidrad', material: '200001', qty: 8, unit: 'ST', ref: '0001' },
      { row_no: 5, psp: 'P-25001.01.01', psp_description: 'Schneidrad', material: '200002', qty: 24, unit: 'ST', ref: '0002' },
      { row_no: 6, psp: 'P-25001.02.01', psp_description: 'Hauptantrieb', material: '200003', qty: 4, unit: 'ST', ref: '0003' },
      { row_no: 7, psp: 'P-25001.02.01', psp_description: 'Hauptantrieb', material: '200004', qty: 60, unit: 'M', ref: '0004' },
      { row_no: 8, psp: 'P-25001.03.01', psp_description: 'Förderschnecke', material: '200006', qty: 6, unit: 'ST', ref: '0005' },
      { row_no: 9, psp: 'P-25001.03.01', psp_description: 'Förderschnecke', material: '200005', qty: 120, unit: 'ST', ref: '0006' },
      { row_no: 10, psp: 'P-25001.03.01', psp_description: 'Förderschnecke', material: '200003', qty: 2, unit: 'ST', ref: '0007' },
    ],
  });
  d.importItems(USER, p.id, {
    source: 'EXCEL', list_name: '3_packliste_elektrik', file_name: '3_packliste_elektrik.csv', number_format: 'EN', rows: [
      { row_no: 2, material: '200008', description: 'Kabel NYY-J 5x25', qty: 150, unit: 'M', weight_kg: 1.6 },
      { row_no: 3, material: '300001', description: 'Schaltschrank Steuerung', qty: 1, unit: 'ST', weight_kg: 420 },
      { row_no: 4, material: '300002', description: 'Bedienpult Fahrerkabine', qty: 1, unit: 'ST', weight_kg: 85 },
      { row_no: 5, material: '300003', description: 'Kabelbinder 300 mm (Beutel à 100)', qty: 12, unit: 'ST', weight_kg: 0.4 },
    ],
  });
  const psp = Object.fromEntries(d.listPsp(p.id).map((x) => [x.code, x.id]));
  d.createItem(USER, p.id, {
    source: 'LIEFERANT', material_number: 'LIEF-9001', description: 'Hydraulikaggregat 55 kW', qty_required: 1, psp_id: psp['P-25001.02.01'],
    supplier: 'Hydraulik Süd GmbH', purchase_order: '4500123456', barcode: 'HS-55KW-0042',
  });
  const items = d.listItems(p.id);
  d.setItemsBaseStatus(USER, { ids: items.filter((i) => i.source === 'PSP').map((i) => i.id), status: 'KOMMISSIONIERT' });
  const itemOf = (nr, pspCode) => items.find((i) => i.material_number === nr && (pspCode === undefined || i.psp_code === pspCode)).id;

  const hu = (body) => d.createHu(USER, p.id, body);
  const pack = (h, itemId, qty) => d.pack(USER, h.id, { pack_item_id: itemId, qty });
  const ready = (h) => { d.huAction(USER, h.id, { action: 'close' }); d.huAction(USER, h.id, { action: 'ready' }); };

  const k1 = hu({ packaging_type: 'KISTE', description: 'Kiste Schneidrad-Werkzeuge', psp_id: psp['P-25001.01.01'], location: 'Sammelplatz A1', length_cm: 240, width_cm: 120, height_cm: 110, tare_kg: 60 });
  pack(k1, itemOf('200001'), 6);
  pack(k1, itemOf('200002'), 24);
  const k2 = hu({ packaging_type: 'KARTON', description: 'Karton Dichtungen', location: 'Sammelplatz A1', length_cm: 60, width_cm: 40, height_cm: 40, tare_kg: 1 });
  pack(k2, itemOf('200003', 'P-25001.02.01'), 4);
  d.huAction(USER, k2.id, { action: 'close' });
  d.addChild(USER, k1.id, { child_id: k2.id });
  ready(k1);
  const k3 = hu({ packaging_type: 'PALETTE', description: 'Palette Hydraulik & Kabel', psp_id: psp['P-25001.02.01'], location: 'Halle 4 / Tor 2', length_cm: 120, width_cm: 80, height_cm: 120, tare_kg: 25 });
  pack(k3, itemOf('200004'), 60);
  pack(k3, itemOf('200008'), 150);
  ready(k3);
  const k4 = hu({ packaging_type: 'KISTE', description: 'Kiste Förderschnecke', psp_id: psp['P-25001.03.01'], location: 'Sammelplatz B2', length_cm: 200, width_cm: 120, height_cm: 100, tare_kg: 80 });
  pack(k4, itemOf('200006'), 6);
  pack(k4, itemOf('200005'), 120);
  pack(k4, itemOf('200003', 'P-25001.03.01'), 2);
  ready(k4);
  const k5 = hu({ packaging_type: 'GROSSCOLLI', description: 'Hydraulikaggregat 55 kW', psp_id: psp['P-25001.02.01'], location: 'Freilager 3', length_cm: 180, width_cm: 120, height_cm: 150, gross_kg: 480, stackable: false });
  pack(k5, itemOf('LIEF-9001'), 1);
  ready(k5);
  // Für die Vorführung: leere Kiste für den Schaltschrank (Material 300001 scannen)
  hu({ packaging_type: 'KISTE', description: 'Kiste Schaltschrank', location: 'Sammelplatz C1', length_cm: 140, width_cm: 100, height_cm: 220, tare_kg: 70, stackable: false });

  d.reportMissing(USER, itemOf('200001'), { qty_missing: 2, reason: 'Noch in Fertigung (Schleiferei)', expected: '2026-10-20' });

  // Ladeplan mit zusätzlichem Ladegut, berechnet und einer geplanten Lieferung zugeordnet (Verladung live vorführen)
  const types = lp.listTypes();
  const trailer = types.find((t) => t.name === 'Sattelauflieger Plane 13,60 m') || types[0];
  const plan = lp.createPlan(USER, p.id, { name: 'Hauptlieferung Schneidrad & Antrieb', vehicle_type_id: trailer.id, auto_add: true, add_hus: 'ready' });
  lp.addItems(USER, plan.id, { name: 'Europalette Ersatzteile', length_cm: 120, width_cm: 80, height_cm: 110, weight_kg: 450, qty: 6, stackable: true, rotatable: true, stop: 1 });
  lp.addItems(USER, plan.id, { name: 'Stahlgestell Nachläufer', length_cm: 600, width_cm: 220, height_cm: 180, weight_kg: 3200, qty: 1, stackable: false, rotatable: false, stop: 1 });
  const calc = lp.calculate(USER, plan.id);
  lp.assign(USER, plan.id, { space_key: calc.result.spaces[0].key, create: true });
}

/**
 * Hält die App-Instanz und erlaubt das Zurücksetzen der Demo-Daten zur Laufzeit.
 * mode: 'sample' (Beispielprojekt) oder 'empty' (leer, passend zur Testanleitung)
 */
function createDemoHost(dataDir) {
  let ctx = null;
  function start(mode = 'sample') {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    ctx = createApp({ dataDir, demo: { reset } });
    if (mode === 'sample') seedSample(ctx);
  }
  function reset(mode) {
    // Erst die alte Datenbank schließen (unter Windows sonst gesperrt), dann neu anlegen
    if (ctx) { try { ctx.close(); ctx.db.close(); } catch { /* bereits geschlossen */ } }
    ctx = null;
    start(mode === 'empty' ? 'empty' : 'sample');
  }
  function handler(req, res) {
    if (!ctx) start('sample');
    return ctx.app(req, res);
  }
  return { handler, reset, current: () => ctx };
}

module.exports = { createDemoHost, seedSample, DEMO_DIR: process.env.PV_DEMO_DIR || path.join(require('node:os').tmpdir(), 'projektversand-demo') };
