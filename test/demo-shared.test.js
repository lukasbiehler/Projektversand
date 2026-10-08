'use strict';
// Demo mit gemeinsamem Speicher: mehrere Instanzen (wie auf Vercel) sehen denselben Datenstand

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDemoHost } = require('../server/demo');
const { createRedisStore } = require('../server/demo-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-shared-'));
const servers = [];
const hosts = [];
let redis; let A; let B;

/** Kleine Nachbildung der Upstash-REST-Schnittstelle (nur die verwendeten Befehle) */
function fakeRedis() {
  const data = new Map();
  const stats = { commands: 0 };
  function run([name, ...a]) {
    stats.commands++;
    switch (String(name).toUpperCase()) {
      case 'GET': return data.has(a[0]) ? data.get(a[0]) : null;
      case 'MGET': return a.map((k) => (data.has(k) ? data.get(k) : null));
      case 'SET': {
        if (a.slice(2).some((o) => String(o).toUpperCase() === 'NX') && data.has(a[0])) return null;
        data.set(a[0], String(a[1]));
        return 'OK';
      }
      case 'EVAL': {
        const [, , key, arg] = a;
        if (data.get(key) !== arg) return 0;
        data.delete(key);
        return 1;
      }
      default: throw new Error(`Befehl ${name} nicht nachgebildet`);
    }
  }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try {
        const json = JSON.parse(body);
        out = req.url === '/multi-exec' ? json.map((c) => ({ result: run(c) })) : { result: run(json) };
      } catch (err) { out = { error: err.message }; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  return { server, data, stats };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => {
  servers.push(server);
  r(`http://127.0.0.1:${server.address().port}`);
}));

async function instance(name, redisUrl) {
  const host = createDemoHost(path.join(dir, name), { store: createRedisStore(redisUrl, 'geheim') });
  hosts.push(host);
  return listen(http.createServer(host.handler));
}

async function call(base, method, url, body, headers = {}) {
  const opts = { method, headers: { 'X-User': 'Demo-Test', ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), ct };
}

test.before(async () => {
  redis = fakeRedis();
  const url = await listen(redis.server);
  A = await instance('a', url);
  B = await instance('b', url);
});
test.after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  for (const h of hosts) { const c = h.current(); if (c) { c.close(); c.db.close(); } }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Kaltstart zweier Instanzen ergibt genau einen gemeinsamen Datenstand', async () => {
  const [a, b] = await Promise.all([call(A, 'GET', '/api/changes'), call(B, 'GET', '/api/changes')]);
  assert.equal(a.status, 200);
  assert.equal(a.data.instance, b.data.instance, 'gleiche Kennung → Oberflächen laden beim Instanzwechsel nicht neu');
  assert.equal(a.data.last, b.data.last);
  assert.deepEqual((await call(B, 'GET', '/api/projects')).data.map((p) => p.number), ['P-25001']);
});

test('Buchung auf einer Instanz ist sofort auf der anderen sichtbar', async () => {
  const hus = (await call(A, 'GET', '/api/projects/1/hus')).data;
  const box = hus.find((x) => x.description === 'Kiste Schaltschrank');
  let r = await call(A, 'POST', `/api/hus/${box.id}/pack`, { code: '300001', qty: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(B, 'POST', `/api/hus/${box.id}/pack`, { code: '300001', qty: 1 });
  assert.equal(r.status, 400, 'zweite Instanz kennt die Buchung der ersten');
  r = await call(B, 'POST', `/api/hus/${box.id}/action`, { action: 'close' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call(A, 'POST', `/api/hus/${box.id}/action`, { action: 'ready' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call(B, 'GET', `/api/hus/${box.id}`)).data.hu.status, 'VERSANDBEREIT');
});

test('Gleichzeitige Buchungen auf beiden Instanzen gehen nicht verloren', async () => {
  const before = (await call(A, 'GET', '/api/projects')).data.length;
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i % 2 ? A : B, 'POST', '/api/projects', { number: `P-PAR-${i}` })));
  assert.deepEqual(rs.map((r) => r.status), Array(8).fill(200));
  for (const base of [A, B]) assert.equal((await call(base, 'GET', '/api/projects')).data.length, before + 8);
});

test('Bilder sind auf allen Instanzen abrufbar', async () => {
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  const up = await call(A, 'POST', '/api/photos?hu_id=1&phase=VERPACKUNG&category=INNENAUFNAHME', jpeg, { 'Content-Type': 'image/jpeg' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const file = await call(B, 'GET', `/api/photos/${up.data.id}/file`);
  assert.equal(file.status, 200);
  assert.ok(file.data.equals(jpeg));
});

test('Lesende Anfragen kosten ohne Änderung nur eine Abfrage am Speicher', async () => {
  await call(A, 'GET', '/api/projects');
  const n = redis.stats.commands;
  await call(A, 'GET', '/api/projects');
  assert.equal(redis.stats.commands - n, 1);
  await call(A, 'GET', '/js/app.js');
  assert.equal(redis.stats.commands - n, 1, 'statische Dateien brauchen den Speicher nicht');
});

test('Zurücksetzen gilt für alle Instanzen', async () => {
  const before = (await call(B, 'GET', '/api/changes')).data;
  let r = await call(A, 'POST', '/api/demo/reset', { mode: 'empty' });
  assert.equal(r.status, 200);
  assert.equal((await call(B, 'GET', '/api/projects')).data.length, 0);
  const after = (await call(B, 'GET', '/api/changes')).data;
  assert.notEqual(after.instance, before.instance, 'neue Kennung → Oberflächen laden neu');
  r = await call(B, 'POST', '/api/demo/reset', { mode: 'sample' });
  assert.equal(r.status, 200);
  assert.deepEqual((await call(A, 'GET', '/api/projects')).data.map((p) => p.number), ['P-25001']);
});

test('Abgelaufener Stand: die Demo startet wieder mit dem Beispielprojekt', async () => {
  await call(A, 'POST', '/api/projects', { number: 'P-ALT' });
  redis.data.clear();
  assert.deepEqual((await call(B, 'GET', '/api/projects')).data.map((p) => p.number), ['P-25001']);
  assert.deepEqual((await call(A, 'GET', '/api/projects')).data.map((p) => p.number), ['P-25001']);
});

test('Speicher nicht erreichbar: verständliche Fehlermeldung statt Absturz', async () => {
  const host = createDemoHost(path.join(dir, 'c'), { store: createRedisStore('http://127.0.0.1:9', 'x') });
  hosts.push(host);
  const base = await listen(http.createServer(host.handler));
  const r = await call(base, 'GET', '/api/projects');
  assert.equal(r.status, 503);
  assert.match(r.data.error, /Demo-Speicher/);
});
