'use strict';
// HTTP-API + Auslieferung der Oberfläche

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { openDatabase } = require('./db');
const { createDomain } = require('./domain');
const { createLoadplanDomain } = require('./loadplans');
const C = require('./constants');
const { toZpl, sendRaw } = require('./labels');
const { AppError, bad } = require('./util');

const ROOT = path.join(__dirname, '..');
const VENDOR = {
  'bwip-js.min.js': path.join(ROOT, 'node_modules', 'bwip-js', 'dist', 'bwip-js-min.js'),
  'html5-qrcode.min.js': path.join(ROOT, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js'),
  'xlsx.full.min.js': path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'),
};

/**
 * demo: false oder { reset(mode) } – im Demo-Modus werden Funktionen gesperrt, die aus einer öffentlichen Demo heraus
 * Verbindungen zu fremden Systemen aufbauen würden (SAP-Endpunkt, Netzwerkdrucker), und die Oberfläche fragt Änderungen
 * regelmäßig ab statt über eine dauerhafte Verbindung (serverlose Umgebungen wie Vercel).
 */
function createApp({ dataDir, db: existingDb, demo = false } = {}) {
  const instance = require('node:crypto').randomUUID();
  const db = existingDb || openDatabase(dataDir);
  const photosDir = dataDir === ':memory:' || !dataDir
    ? fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'projektversand-photos-'))
    : path.join(dataDir, 'photos');
  fs.mkdirSync(photosDir, { recursive: true });

  // Echtzeit: Server-Sent Events an alle verbundenen Geräte
  const clients = new Set();
  function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(msg); } catch { clients.delete(res); }
    }
  }

  const domain = createDomain(db, { photosDir, onChange: (e) => broadcast({ type: 'change', ...e }) });
  const loadplans = createLoadplanDomain(domain);
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use((req, res, next) => {
    let user = '';
    try { user = decodeURIComponent(req.get('x-user') || ''); } catch { user = ''; }
    req.user = user.trim().slice(0, 60) || 'unbekannt';
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  const json = express.json({ limit: '25mb' });
  const api = express.Router();
  api.use(json);

  const h = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.then((v) => { if (!res.headersSent) res.json(v); }).catch(next);
      else if (!res.headersSent) res.json(out);
    } catch (err) { next(err); }
  };
  const id = (req, name = 'id') => {
    const v = Number(req.params[name]);
    if (!Number.isInteger(v) || v <= 0) throw new AppError(404, 'Nicht gefunden.');
    return v;
  };
  const optId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

  // ---------------------------------------------------------------- Meta, Einstellungen, Echtzeit
  api.get('/health', h(() => ({ ok: true })));
  // Im Demo-Modus gesperrt: ausgehende Verbindungen zu frei eingebbaren Zielen
  if (demo) {
    api.use((req, res, next) => {
      const blocked = (req.method !== 'GET' && (/^\/printers/.test(req.path) || req.path === '/print' || req.path === '/sap/retry'))
        || (req.method === 'PUT' && req.path === '/settings' && req.body && ['sap_enabled', 'sap_endpoint', 'sap_auth'].some((k) => k in req.body));
      if (blocked) return next(new AppError(403, 'In der Demo-Version nicht verfügbar (keine Verbindungen zu Druckern oder SAP).'));
      next();
    });
    api.post('/demo/reset', h((req) => {
      const mode = (req.body || {}).mode === 'empty' ? 'empty' : 'sample';
      demo.reset(mode);
      return { ok: true, mode };
    }));
  }

  // Änderungen seit einem Protokollstand (Abfrage im Takt, falls keine dauerhafte Verbindung möglich ist)
  api.get('/changes', h((req) => {
    const since = Number(req.query.since) || 0;
    const last = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get().n;
    const projects = since && last > since
      ? db.prepare('SELECT DISTINCT project_id FROM events WHERE id > ?').all(since).map((r) => r.project_id)
      : [];
    return { instance, last, projects };
  }));

  api.get('/meta', h(() => ({
    demo: !!demo,
    item_status: C.ITEM_STATUS, base_status: C.BASE_STATUS, hu_status: C.HU_STATUS, pack_status: C.PACK_STATUS, ship_status: C.SHIP_STATUS,
    packaging_types: C.PACKAGING_TYPES, item_sources: C.ITEM_SOURCES, delivery_kinds: C.DELIVERY_KINDS, delivery_status: C.DELIVERY_STATUS,
    photo_phases: C.PHOTO_PHASES, photo_categories: C.PHOTO_CATEGORIES, symbologies: C.SYMBOLOGIES, integer_units: C.INTEGER_UNITS,
    vehicle_categories: C.VEHICLE_CATEGORIES,
  })));
  api.get('/settings', h(() => domain.publicSettings()));
  api.put('/settings', h((req) => domain.updateSettings(req.user, req.body || {})));

  api.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* geschlossen */ } }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  // ---------------------------------------------------------------- Projekte & PSP
  api.get('/projects', h(() => domain.listProjects()));
  api.post('/projects', h((req) => domain.createProject(req.user, req.body || {})));
  api.get('/projects/:id', h((req) => domain.getProjectDetail(id(req))));
  api.put('/projects/:id', h((req) => domain.updateProject(req.user, id(req), req.body || {})));
  api.get('/projects/:id/psp', h((req) => domain.listPsp(id(req))));
  api.post('/projects/:id/psp', h((req) => domain.createPsp(req.user, id(req), req.body || {})));
  api.put('/psp/:id', h((req) => domain.updatePsp(req.user, id(req), req.body || {})));
  api.delete('/psp/:id', h((req) => domain.deletePsp(req.user, id(req))));

  // ---------------------------------------------------------------- Packvorrat
  api.get('/projects/:id/items', h((req) => { domain.getProject(id(req)); return domain.listItems(id(req)); }));
  api.post('/projects/:id/items', h((req) => domain.createItem(req.user, id(req), req.body || {})));
  api.post('/projects/:id/import', h((req) => domain.importItems(req.user, id(req), req.body || {})));
  api.get('/projects/:id/shortages', h((req) => { domain.getProject(id(req)); return domain.shortages(id(req)); }));
  api.get('/items/:id', h((req) => domain.getItem(id(req))));
  api.put('/items/:id', h((req) => domain.updateItem(req.user, id(req), req.body || {})));
  api.delete('/items/:id', h((req) => domain.deleteItem(req.user, id(req))));
  api.post('/items/status', h((req) => domain.setItemsBaseStatus(req.user, req.body || {})));
  api.post('/items/:id/missing', h((req) => domain.reportMissing(req.user, id(req), req.body || {})));

  // ---------------------------------------------------------------- Materialstamm
  api.get('/materials', h((req) => domain.listMaterials(req.query.q, Math.min(Number(req.query.limit) || 200, 2000))));
  api.post('/materials', h((req) => domain.createMaterial(req.user, req.body || {})));
  api.post('/materials/import', h((req) => domain.importMaterials(req.user, req.body || {})));
  api.get('/materials/:nr', h((req) => domain.materialDetail(req.params.nr)));
  api.put('/materials/:nr', h((req) => domain.updateMaterial(req.user, req.params.nr, req.body || {})));
  api.post('/materials/:nr/barcodes', h((req) => domain.addBarcode(req.user, req.params.nr, req.body || {})));
  api.delete('/barcodes/:code', h((req) => domain.removeBarcode(req.user, req.params.code)));
  api.get('/resolve', h((req) => domain.resolveCode(req.query.code, optId(req.query.project_id))));

  // ---------------------------------------------------------------- Handling Units
  api.get('/projects/:id/hus', h((req) => domain.listHus(id(req))));
  api.post('/projects/:id/hus', h((req) => domain.createHu(req.user, id(req), req.body || {})));
  api.get('/hus/:id', h((req) => domain.getHuDetail(id(req))));
  api.put('/hus/:id', h((req) => domain.updateHu(req.user, id(req), req.body || {})));
  api.delete('/hus/:id', h((req) => domain.deleteHu(req.user, id(req))));
  api.post('/hus/:id/pack', h((req) => domain.pack(req.user, id(req), req.body || {})));
  api.post('/hus/:id/unpack', h((req) => domain.unpack(req.user, id(req), req.body || {})));
  api.post('/hus/:id/parent', h((req) => domain.setParent(req.user, id(req), req.body || {})));
  api.post('/hus/:id/children', h((req) => domain.addChild(req.user, id(req), req.body || {})));
  api.post('/hus/:id/action', h((req) => domain.huAction(req.user, id(req), req.body || {})));

  // ---------------------------------------------------------------- Lieferungen
  api.get('/projects/:id/deliveries', h((req) => domain.listDeliveries(id(req))));
  api.post('/projects/:id/deliveries', h((req) => domain.createDelivery(req.user, id(req), req.body || {})));
  api.get('/deliveries/:id', h((req) => ({ ...domain.getDeliveryDetail(id(req)), loadplan: loadplans.planForDelivery(id(req)) })));
  api.put('/deliveries/:id', h((req) => domain.updateDelivery(req.user, id(req), req.body || {})));
  api.delete('/deliveries/:id', h((req) => domain.deleteDelivery(req.user, id(req))));
  api.post('/deliveries/:id/load', h((req) => domain.loadHu(req.user, id(req), req.body || {})));
  api.post('/deliveries/:id/unload', h((req) => domain.unloadHu(req.user, id(req), req.body || {})));
  api.post('/deliveries/:id/action', h((req) => domain.deliveryAction(req.user, id(req), req.body || {})));

  // ---------------------------------------------------------------- Ladeplanung
  api.get('/vehicle-types', h(() => loadplans.listTypes()));
  api.post('/vehicle-types', h((req) => loadplans.saveType(req.user, null, req.body || {})));
  api.put('/vehicle-types/:id', h((req) => loadplans.saveType(req.user, id(req), req.body || {})));
  api.delete('/vehicle-types/:id', h((req) => loadplans.deleteType(req.user, id(req))));
  api.get('/projects/:id/loadplans', h((req) => loadplans.listPlans(id(req))));
  api.post('/projects/:id/loadplans', h((req) => loadplans.createPlan(req.user, id(req), req.body || {})));
  api.get('/loadplans/:id', h((req) => loadplans.getPlan(id(req))));
  api.put('/loadplans/:id', h((req) => loadplans.updatePlan(req.user, id(req), req.body || {})));
  api.delete('/loadplans/:id', h((req) => loadplans.deletePlan(req.user, id(req))));
  api.post('/loadplans/:id/items', h((req) => loadplans.addItems(req.user, id(req), req.body || {})));
  api.post('/loadplans/:id/items/import', h((req) => loadplans.importItems(req.user, id(req), req.body || {})));
  api.put('/loadplan-items/:id', h((req) => loadplans.updateItem(req.user, id(req), req.body || {})));
  api.delete('/loadplan-items/:id', h((req) => loadplans.deleteItem(req.user, id(req))));
  api.post('/loadplans/:id/calculate', h((req) => loadplans.calculate(req.user, id(req))));
  api.post('/loadplans/:id/edit', h((req) => loadplans.edit(req.user, id(req), req.body || {})));
  api.post('/loadplans/:id/assign', h((req) => loadplans.assign(req.user, id(req), req.body || {})));

  // ---------------------------------------------------------------- Bilder
  api.post('/photos', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '25mb' }), h((req) => {
    if (!Buffer.isBuffer(req.body)) throw bad('Bitte ein Bild (JPEG, PNG oder WebP) senden.');
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return domain.addPhoto(req.user, {
      hu_id: optId(req.query.hu_id), delivery_id: optId(req.query.delivery_id), phase: req.query.phase, category: req.query.category, note: req.query.note,
    }, req.body, mime);
  }));
  api.get('/photos/:id/file', (req, res, next) => {
    try {
      const f = domain.getPhoto(id(req));
      res.set('Content-Type', f.mime);
      res.set('Cache-Control', 'private, max-age=86400');
      res.sendFile(f.abs, (err) => { if (err && !res.headersSent) next(new AppError(404, 'Bilddatei fehlt.')); });
    } catch (err) { next(err); }
  });
  api.delete('/photos/:id', h((req) => domain.deletePhoto(req.user, id(req))));

  // ---------------------------------------------------------------- Suche & Protokoll
  api.get('/search', h((req) => domain.search(req.query.q, optId(req.query.project_id))));
  api.get('/events', h((req) => domain.listEvents(req.query)));

  // ---------------------------------------------------------------- Etiketten & Drucker
  api.post('/labels/data', h((req) => domain.labelData((req.body || {}).labels)));
  api.post('/labels/zpl', (req, res, next) => {
    try {
      const body = req.body || {};
      const dpi = [203, 300, 600].includes(Number(body.dpi)) ? Number(body.dpi) : Number(domain.getSetting('label_dpi')) || 203;
      const zpl = toZpl(domain.labelData(body.labels), dpi);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="etiketten.zpl"');
      res.send(zpl);
    } catch (err) { next(err); }
  });
  api.post('/print', h(async (req) => {
    const body = req.body || {};
    const printer = domain.getPrinter(body.printer_id);
    const labels = domain.labelData(body.labels);
    await sendRaw(printer.host, printer.port, toZpl(labels, printer.dpi));
    return { ok: true, count: labels.length, printer: printer.name };
  }));
  api.get('/printers', h(() => domain.listPrinters()));
  api.post('/printers', h((req) => domain.savePrinter(req.user, null, req.body || {})));
  api.put('/printers/:id', h((req) => domain.savePrinter(req.user, id(req), req.body || {})));
  api.delete('/printers/:id', h((req) => domain.deletePrinter(req.user, id(req))));
  api.post('/printers/:id/test', h(async (req) => {
    const p = domain.getPrinter(id(req));
    const zpl = `^XA^CI28^PW${Math.round(100 * p.dpi / 25.4)}^FO40,40^A0N,40,40^FDTestdruck ${p.name.replace(/[\^~]/g, '')}^FS^FO40,100^A0N,30,30^FDProjektversand^FS^XZ`;
    await sendRaw(p.host, p.port, zpl);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- SAP-Schnittstelle
  api.get('/sap/outbox', h((req) => domain.outbox(req.query.status)));
  api.post('/sap/retry', h(() => domain.retryOutbox()));
  api.get('/sap/export', (req, res, next) => {
    try {
      const data = domain.exportOutbox(req.user, req.query.mark === '1');
      res.set('Content-Disposition', `attachment; filename="sap-nachrichten-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(data);
    } catch (err) { next(err); }
  });

  // Eingangsschnittstellen für SAP (Push von PSP-Material und Materialstamm inkl. Barcodes)
  api.post('/integration/psp-materials', h((req) => {
    const body = req.body || {};
    const number = String(body.project_number || '').trim();
    if (!number) throw bad('project_number fehlt.');
    let project = domain.db.prepare('SELECT * FROM projects WHERE number = ?').get(number);
    if (!project) project = domain.createProject(req.user, { number, name: body.project_name, customer: body.customer, destination: body.destination });
    return domain.importItems(req.user, project.id, {
      source: 'PSP', list_name: body.list_name || 'SAP-Projektbedarf', rows: body.items, number_format: 'EN', file_name: 'SAP-Schnittstelle',
      dry_run: !!body.dry_run, skip_errors: !!body.skip_errors,
    });
  }));
  api.post('/integration/materials', h((req) => {
    const body = req.body || {};
    const rows = [];
    for (const m of Array.isArray(body.materials) ? body.materials : []) {
      const barcodes = Array.isArray(m.barcodes) && m.barcodes.length ? m.barcodes : [null];
      for (const b of barcodes) {
        rows.push({
          material: m.material_number, description: m.description, unit: m.unit, weight_kg: m.weight_kg,
          barcode: b ? (typeof b === 'string' ? b : b.barcode) : '', symbology: b && typeof b === 'object' ? b.symbology : '',
        });
      }
    }
    return domain.importMaterials(req.user, { rows, number_format: 'EN', file_name: 'SAP-Schnittstelle', dry_run: !!body.dry_run, skip_errors: !!body.skip_errors });
  }));

  api.use((req, res, next) => next(new AppError(404, 'Unbekannte Schnittstelle.')));

  app.use('/api', api);

  // ---------------------------------------------------------------- Oberfläche
  // Beispieldateien der Testanleitung zum Herunterladen
  app.use('/beispieldaten', express.static(path.join(ROOT, 'docs', 'beispieldaten'), { maxAge: 0 }));
  // three.js (3D-Ansicht der Ladeplanung) als ES-Module
  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three', 'build'), { maxAge: '7d' }));
  app.use('/vendor/three-addons', express.static(path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm'), { maxAge: '7d' }));
  app.get('/vendor/:file', (req, res, next) => {
    const f = VENDOR[req.params.file];
    if (!f) return next();
    res.set('Cache-Control', 'public, max-age=604800');
    res.type('application/javascript');
    res.sendFile(f);
  });
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

  // Fehlerbehandlung
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    }
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Die Datei ist zu groß.' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage (JSON).' });
    if (err && /UNIQUE constraint failed/.test(err.message)) return res.status(409).json({ error: 'Der Eintrag existiert bereits.' });
    if (err && /Drucker|Zeitüberschreitung/.test(err.message)) return res.status(502).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Interner Fehler: ' + (err && err.message ? err.message : String(err)) });
  });

  function close() {
    domain.sap.stop();
    for (const res of clients) { try { res.end(); } catch { /* ignorieren */ } }
    clients.clear();
  }

  return { app, domain, loadplans, db, close };
}

module.exports = { createApp };
