'use strict';
// Demo-Modus (z. B. auf Vercel): Daten im temporären Speicher, Beispielprojekt beim Start, Zurücksetzen per Knopfdruck.
// Die Daten sind nicht dauerhaft – sie gehen beim Neustart der Instanz verloren und werden dann neu angelegt.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { createApp } = require('./app');
const { storeFromEnv } = require('./demo-store');

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
function createDemoHost(dataDir, { store = storeFromEnv() } = {}) {
  let ctx = null;
  let epoch = null; // Kennung des Datenstands seit dem letzten Zurücksetzen
  let ver = null; // Version des lokalen Abbilds (nur mit gemeinsamem Speicher)
  const photosKnown = new Set();
  const dbFile = path.join(dataDir, 'projektversand.db');
  const photosDir = path.join(dataDir, 'photos');
  function closeCtx() {
    // Erst die alte Datenbank schließen (unter Windows sonst gesperrt), dann neu anlegen
    if (ctx) { try { ctx.close(); ctx.db.close(); } catch { /* bereits geschlossen */ } }
    ctx = null;
  }
  function open() {
    ctx = createApp({ dataDir, demo: { reset, instanceId: store ? epoch : undefined } });
  }
  function start(mode = 'sample') {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    epoch = crypto.randomUUID();
    photosKnown.clear();
    open();
    if (mode === 'sample') seedSample(ctx);
  }
  function reset(mode) {
    closeCtx();
    start(mode === 'empty' ? 'empty' : 'sample');
  }
  if (!store) {
    const handler = (req, res) => {
      if (!ctx) start('sample');
      return ctx.app(req, res);
    };
    return { handler, reset, current: () => ctx };
  }

  // ---------------------------------------------------------------- Gemeinsamer Speicher (mehrere Instanzen, z. B. Vercel)
  function snapshot() {
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return zlib.gzipSync(fs.readFileSync(dbFile));
  }
  function restore(state) {
    closeCtx();
    if (state.epoch !== epoch) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      photosKnown.clear();
    }
    fs.mkdirSync(dataDir, { recursive: true });
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
    fs.writeFileSync(dbFile, zlib.gunzipSync(state.db));
    epoch = state.epoch;
    ver = state.ver;
    open();
  }
  function photoFiles(dir = photosDir, rel = '') {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? photoFiles(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]));
  }
  async function push() {
    ver = await store.save(epoch, snapshot());
    for (const rel of photoFiles()) {
      if (photosKnown.has(rel)) continue;
      photosKnown.add(rel);
      // Sehr große Bilder kann der Speicher ablehnen – sie bleiben dann nur auf dieser Instanz sichtbar
      await store.savePhoto(epoch, rel, fs.readFileSync(path.join(photosDir, rel))).catch((err) => console.error(err.message));
    }
  }
  /** Lokalen Stand auf den gemeinsamen bringen; gibt es noch keinen, das Beispielprojekt anlegen */
  async function pull(locked) {
    const remote = await store.version();
    if (remote && remote === ver && ctx) return;
    const state = remote ? await store.load() : null;
    if (state) { restore(state); return; }
    const id = locked ? null : await store.lock();
    try {
      const again = locked ? null : await store.load();
      if (again) { restore(again); return; }
      closeCtx();
      start('sample');
      await push();
    } finally {
      if (id) await store.unlock(id).catch(() => {});
    }
  }
  async function ensurePhoto(url) {
    const m = /^\/api\/photos\/(\d+)\/file/.exec(url);
    if (!m) return;
    const row = ctx.db.prepare('SELECT filename FROM photos WHERE id = ?').get(Number(m[1]));
    if (!row) return;
    const abs = path.resolve(photosDir, row.filename);
    if (!abs.startsWith(path.resolve(photosDir) + path.sep) || fs.existsSync(abs)) return;
    const buf = await store.loadPhoto(epoch, row.filename);
    if (!buf) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    photosKnown.add(row.filename);
  }
  const changes = (c) => c.db.prepare('SELECT total_changes() AS n').get().n;

  async function handle(req, res) {
    const isApi = req.url.startsWith('/api/');
    const write = isApi && !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    // Dauerhafte Verbindungen gibt es im Demo-Modus nicht (die Oberfläche fragt im Takt ab)
    if (req.url.startsWith('/api/stream')) { res.statusCode = 404; res.end(); return; }
    let lockId = null;
    if (isApi || !ctx) {
      if (write) lockId = await store.lock();
      try {
        await pull(!!lockId);
        await ensurePhoto(req.url);
      } catch (err) {
        if (lockId) await store.unlock(lockId).catch(() => {});
        throw err;
      }
    }
    const used = ctx;
    const before = changes(used);
    await new Promise((resolve) => {
      let finished = null;
      // Vor dem Ende der Antwort zurückschreiben: danach kann die Instanz angehalten werden
      const finish = () => {
        finished ||= (async () => {
          try {
            if (ctx !== used || changes(used) !== before) await push();
          } catch (err) {
            console.error(err);
            ver = null; // lokaler Stand ist unsicher → bei der nächsten Anfrage neu laden
          } finally {
            if (lockId) await store.unlock(lockId).catch(() => {});
          }
        })();
        return finished;
      };
      const end = res.end;
      res.end = function patchedEnd(...args) {
        res.end = end;
        finish().then(() => end.apply(res, args));
        return res;
      };
      res.once('close', () => finish().then(resolve));
      used.app(req, res);
    });
  }

  // Anfragen dieser Instanz nacheinander bearbeiten (der Abgleich tauscht die Datenbank aus)
  let queue = Promise.resolve();
  function handler(req, res) {
    queue = queue.then(() => handle(req, res)).catch((err) => {
      console.error(err);
      if (res.headersSent) { res.end(); return; }
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Der Demo-Speicher ist gerade nicht erreichbar. Bitte erneut versuchen.' }));
    });
    return queue;
  }
  return { handler, reset, current: () => ctx };
}

module.exports = { createDemoHost, seedSample, DEMO_DIR: process.env.PV_DEMO_DIR || path.join(require('node:os').tmpdir(), 'projektversand-demo') };
