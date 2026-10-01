'use strict';
// Demo-Modus (Vercel): Beispieldaten, Sperren, Abfrage im Takt, Zurücksetzen, Vercel-Einstieg

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-demo-'));
process.env.PV_DEMO_DIR = path.join(dir, 'daten');
const vercelHandler = require('../api/index.js');

let server; let base;

/** Bildet Vercels verzögert gelesenes req.body nach (Getter liest den Datenstrom selbst) */
function withVercelBody(req, res) {
  let cache;
  Object.defineProperty(req, 'body', {
    configurable: true, enumerable: true,
    get() { if (cache === undefined) { cache = null; req.resume(); } return cache; },
    set(v) { Object.defineProperty(req, 'body', { value: v, writable: true, configurable: true, enumerable: true }); },
  });
  return vercelHandler(req, res);
}

async function call(method, url, body, headers = {}) {
  const opts = { method, headers: { 'X-User': 'Demo-Test', ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), ct };
}

test.before(async () => {
  server = http.createServer(withVercelBody);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  const c = vercelHandler.host.current();
  if (c) { c.close(); c.db.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Kaltstart legt das Beispielprojekt an', async () => {
  const meta = await call('GET', '/api/meta');
  assert.equal(meta.data.demo, true);
  const projects = (await call('GET', '/api/projects')).data;
  assert.equal(projects.length, 1);
  const p = projects[0];
  assert.equal(p.number, 'P-25001');
  assert.equal(p.summary.positions, 12);
  assert.equal(p.summary.positions_missing, 1);
  assert.equal(p.summary.hu_top, 5, '4 versandbereite + leere Kiste für den Schaltschrank');
  const plans = (await call('GET', `/api/projects/${p.id}/loadplans`)).data;
  assert.equal(plans.length, 1);
  assert.equal(plans[0].vehicles_used, 1);
  assert.equal(plans[0].unplaced, 0);
  assert.equal(plans[0].deliveries, 1);
  const deliveries = (await call('GET', `/api/projects/${p.id}/deliveries`)).data;
  assert.equal(deliveries[0].status, 'GEPLANT');
  const d = (await call('GET', `/api/deliveries/${deliveries[0].id}`)).data;
  assert.ok(d.loadplan && d.loadplan.space.placements.length === 11);
});

test('Oberfläche, Bibliotheken und Beispieldateien werden ausgeliefert', async () => {
  for (const [url, type] of [['/', 'text/html'], ['/js/app.js', 'javascript'], ['/vendor/three/three.module.js', 'javascript'],
    ['/vendor/three/three.core.js', 'javascript'], ['/vendor/three-addons/controls/OrbitControls.js', 'javascript'],
    ['/vendor/bwip-js.min.js', 'javascript'], ['/vendor/html5-qrcode.min.js', 'javascript'], ['/vendor/xlsx.full.min.js', 'javascript'],
    ['/beispieldaten/2_sap_projektbedarf.xlsx', 'spreadsheet'], ['/beispieldaten/1_materialstamm.csv', 'csv']]) {
    const r = await fetch(base + url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get('content-type') || '', new RegExp(type), url);
  }
});

test('JSON und Bild-Upload funktionieren über den Vercel-Einstieg', async () => {
  const projects = (await call('GET', '/api/projects')).data;
  const hus = (await call('GET', `/api/projects/${projects[0].id}/hus`)).data;
  const box = hus.find((x) => x.description === 'Kiste Schaltschrank');
  const r = await call('POST', `/api/hus/${box.id}/pack`, { code: '300001', qty: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.item.material_number, '300001');
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const up = await call('POST', `/api/photos?hu_id=${box.id}&phase=VERPACKUNG&category=INNENAUFNAHME`, jpeg, { 'Content-Type': 'image/jpeg' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
});

test('Sperren: keine Verbindungen zu Druckern oder SAP aus der Demo', async () => {
  let r = await call('POST', '/api/printers', { name: 'x', host: '10.0.0.1', port: 9100 });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/print', { printer_id: 1, labels: [] });
  assert.equal(r.status, 403);
  r = await call('PUT', '/api/settings', { sap_enabled: '1', sap_endpoint: 'https://example.com' });
  assert.equal(r.status, 403);
  r = await call('PUT', '/api/settings', { label_header: 'Demo-Etikett' });
  assert.equal(r.status, 200, 'übrige Einstellungen bleiben änderbar');
  r = await call('POST', '/api/sap/retry');
  assert.equal(r.status, 403);
});

test('Änderungen werden über /api/changes erkannt', async () => {
  const a = (await call('GET', '/api/changes')).data;
  assert.ok(a.last > 0 && a.instance);
  await call('POST', '/api/projects', { number: 'P-DEMO-2' });
  const b = (await call('GET', `/api/changes?since=${a.last}`)).data;
  assert.ok(b.last > a.last);
  assert.equal(b.instance, a.instance);
  assert.equal(b.projects.length, 1);
});

test('Zurücksetzen: leer und Beispielprojekt', async () => {
  const before = (await call('GET', '/api/changes')).data;
  let r = await call('POST', '/api/demo/reset', { mode: 'empty' });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/projects')).data.length, 0);
  const after = (await call('GET', '/api/changes')).data;
  assert.notEqual(after.instance, before.instance, 'neue Instanz → Oberflächen laden neu');
  const hu = await call('POST', '/api/projects', { number: 'P-X' });
  assert.equal(hu.status, 200);
  r = await call('POST', '/api/demo/reset', { mode: 'sample' });
  assert.equal(r.status, 200);
  const projects = (await call('GET', '/api/projects')).data;
  assert.deepEqual(projects.map((p) => p.number), ['P-25001']);
});
