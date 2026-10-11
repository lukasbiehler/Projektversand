'use strict';
// Anmeldung, Sitzungen, Rollen und Rechte

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const { permissionFor, ROLE_PERMISSIONS } = require('../server/auth');

let server; let base; let ctx; let dataDir;
const PW = 'Sicheres-Passwort-1';

/** Eigener „Browser“ mit Cookie-Speicher */
function client() {
  let cookie = '';
  const c = async (method, url, body, headers = {}) => {
    const opts = { method, headers: { ...headers } };
    if (cookie) opts.headers.Cookie = cookie;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    const res = await fetch(base + url, opts);
    const set = res.headers.getSetCookie();
    if (set.length) { c.setCookie = set[0]; cookie = set[0].split(';')[0]; }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  c.login = async (username, password = PW) => {
    const r = await c('POST', '/api/auth/login', { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  return c;
}

const admin = client();
const users = {}; // Rolle → angemeldeter Client

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-auth-'));
  ctx = createApp({ dataDir });
  server = http.createServer(ctx.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  ctx.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Ohne Anmeldung ist nur die Oberfläche erreichbar, keine Daten', async () => {
  const anon = client();
  for (const url of ['/api/projects', '/api/meta', '/api/settings', '/api/changes', '/api/stream', '/api/photos/1/file', '/api/users', '/api/sap/outbox']) {
    const r = await anon('GET', url);
    assert.equal(r.status, 401, url);
    assert.equal(r.data.code, 'AUTH_REQUIRED');
  }
  assert.equal((await anon('POST', '/api/projects', { number: 'P-1' })).status, 401);
  assert.equal((await anon('POST', '/api/integration/materials', { materials: [] })).status, 401);
  assert.equal((await anon('GET', '/api/health')).status, 200);
  assert.equal((await anon('GET', '/')).status, 200);
  assert.equal((await anon('GET', '/js/app.js')).status, 200);
  const s = (await anon('GET', '/api/auth/session')).data;
  assert.deepEqual(s, { auth: true, setup_required: true, setup_available: true, user: null });
});

test('Ersteinrichtung: nur mit dem Code aus der Server-Konsole, danach geschlossen', async () => {
  assert.match(ctx.auth.setupCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  let r = await admin('POST', '/api/auth/setup', { code: 'AAAA-BBBB-CCCC', username: 'chef', password: PW });
  assert.equal(r.status, 403);
  r = await admin('POST', '/api/auth/setup', { code: ctx.auth.setupCode, username: 'chef', password: 'kurz' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /mindestens 10 Zeichen/);
  r = await admin('POST', '/api/auth/setup', { code: ctx.auth.setupCode, username: 'chef', password: 'chef-chef-chef' });
  assert.match(r.data.error, /Benutzernamen nicht enthalten/);
  const code = ctx.auth.setupCode.toLowerCase().replace(/-/g, ' ');
  r = await admin('POST', '/api/auth/setup', { code, username: 'Chef', display_name: 'Carla Chef', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'ADMIN');
  assert.equal(r.data.user.username, 'chef');
  assert.match(admin.setCookie, /^pv_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.equal(ctx.auth.setupCode, null);
  r = await client()('POST', '/api/auth/setup', { code, username: 'zweiter', password: PW });
  assert.equal(r.status, 403, 'Einrichtung ist nach dem ersten Administrator geschlossen');
  assert.equal((await admin('GET', '/api/projects')).status, 200);
});

test('Passwörter liegen nur als scrypt-Hash vor, Sitzungen nur als Hash des Tokens', () => {
  const u = ctx.db.prepare('SELECT * FROM users').get();
  assert.match(u.password_hash, /^scrypt\$32768\$8\$3\$/);
  assert.ok(!u.password_hash.includes(PW));
  const s = ctx.db.prepare('SELECT * FROM sessions').get();
  assert.match(s.id, /^[0-9a-f]{64}$/);
  assert.ok(!admin.setCookie.includes(s.id));
});

test('Benutzer anlegen: neues Konto muss zuerst ein eigenes Passwort vergeben', async () => {
  for (const [role, username] of [['DISPONENT', 'dora'], ['VERPACKER', 'paul'], ['VERLADER', 'vera'], ['LESER', 'lena']]) {
    const r = await admin('POST', '/api/users', { username, display_name: `${username} Test`, role, password: 'Start-Passwort-9' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.must_change_password, true);
    const c = client();
    const s = await c.login(username, 'Start-Passwort-9');
    assert.equal(s.user.must_change_password, true);
    let x = await c('GET', '/api/projects');
    assert.equal(x.status, 403);
    assert.equal(x.data.code, 'PASSWORD_CHANGE_REQUIRED');
    x = await c('POST', '/api/auth/password', { current: 'falsch', password: PW });
    assert.equal(x.status, 400);
    x = await c('POST', '/api/auth/password', { current: 'Start-Passwort-9', password: 'Start-Passwort-9' });
    assert.match(x.data.error, /unterscheiden/);
    x = await c('POST', '/api/auth/password', { current: 'Start-Passwort-9', password: PW });
    assert.equal(x.status, 200, JSON.stringify(x.data));
    assert.equal((await c('GET', '/api/projects')).status, 200);
    users[role] = c;
  }
  let r = await admin('POST', '/api/users', { username: 'dora', role: 'LESER', password: PW });
  assert.equal(r.status, 409);
  r = await admin('POST', '/api/users', { username: 'x y', role: 'LESER', password: PW });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/users', { username: 'neu', role: 'CHEF', password: PW });
  assert.match(r.data.error, /Unbekannte Rolle/);
});

test('Rollen: jede Rolle darf genau ihre Aufgaben', async () => {
  const p = (await admin('POST', '/api/projects', { number: 'P-AUTH' })).data;
  const expect = async (role, method, url, body, allowed) => {
    const r = await users[role](method, url, body);
    if (allowed) assert.ok(r.status !== 401 && r.status !== 403, `${role} ${method} ${url} sollte erlaubt sein, ist ${r.status}`);
    else assert.equal(r.status, 403, `${role} ${method} ${url} sollte verboten sein`);
    return r;
  };
  const hu = { packaging_type: 'KISTE', description: 'Testkiste', length_cm: 100, width_cm: 80, height_cm: 60, tare_kg: 10 };
  const cases = [
    // Methode, Pfad, Inhalt, erlaubte Rollen
    ['POST', '/api/projects', { number: 'P-ROLLE' }, ['DISPONENT']],
    ['POST', `/api/projects/${p.id}/items`, { material_number: 'M1', description: 'Teil', qty_required: 1 }, ['DISPONENT']],
    ['POST', '/api/materials', { material_number: 'M-ROLLE', description: 'Teil' }, ['DISPONENT']],
    ['POST', `/api/projects/${p.id}/hus`, hu, ['DISPONENT', 'VERPACKER']],
    ['POST', '/api/items/status', { ids: [], status: 'KOMMISSIONIERT' }, ['DISPONENT', 'VERPACKER']],
    ['POST', `/api/projects/${p.id}/deliveries`, {}, ['DISPONENT', 'VERLADER']],
    ['POST', `/api/projects/${p.id}/loadplans`, { name: 'Plan' }, ['DISPONENT']],
    ['POST', '/api/photos?hu_id=1&phase=VERPACKUNG&category=INNENAUFNAHME', Buffer.from('x'), ['DISPONENT', 'VERPACKER', 'VERLADER']],
    ['POST', '/api/print', { printer_id: 1, labels: [] }, ['DISPONENT', 'VERPACKER', 'VERLADER']],
    ['POST', '/api/labels/data', { labels: [] }, ['DISPONENT', 'VERPACKER', 'VERLADER', 'LESER']],
    ['PUT', '/api/settings', { label_header: 'X' }, []],
    ['POST', '/api/printers', { name: 'D', host: '10.0.0.1' }, []],
    ['POST', '/api/users', { username: 'boese', role: 'ADMIN', password: PW }, []],
    ['PUT', '/api/users/1', { role: 'LESER' }, []],
    ['GET', '/api/users', undefined, []],
    ['GET', '/api/auth-log', undefined, []],
    ['GET', '/api/sap/outbox', undefined, []],
    ['POST', '/api/integration/materials', { materials: [] }, []],
    ['GET', '/api/projects', undefined, ['DISPONENT', 'VERPACKER', 'VERLADER', 'LESER']],
    ['GET', '/api/search?q=abc', undefined, ['DISPONENT', 'VERPACKER', 'VERLADER', 'LESER']],
  ];
  for (const [method, url, body, allowed] of cases) {
    for (const role of Object.keys(users)) await expect(role, method, url, body, allowed.includes(role));
    const r = await admin(method, url, body);
    assert.ok(r.status !== 401 && r.status !== 403, `ADMIN ${method} ${url} → ${r.status}`);
  }
});

test('Alle Schnittstellen sind abgesichert: Nur-Lesen-Konto kann nichts ändern', async () => {
  // Sämtliche registrierten Routen der API durchgehen – neue Routen sind damit automatisch mitgeprüft
  const routes = [];
  for (const top of ctx.app.router.stack) {
    if (!top.handle || !top.handle.stack) continue;
    for (const l of top.handle.stack) if (l.route) for (const m of Object.keys(l.route.methods)) routes.push([m.toUpperCase(), l.route.path]);
  }
  assert.ok(routes.length > 80, `Routen gefunden: ${routes.length}`);
  const leser = users.LESER;
  const anon = client();
  let writes = 0;
  for (const [method, pattern] of routes) {
    const url = '/api' + pattern.replace(/:\w+/g, '1');
    if (url === '/api/health' || url === '/api/stream') continue;
    assert.equal((await anon(method, url, method === 'GET' ? undefined : {})).status, 401, `ohne Anmeldung: ${method} ${url}`);
    if (method === 'GET') continue;
    const r = await leser(method, url, {});
    if (url.startsWith('/api/labels/')) continue; // erzeugt nur Etikettendaten
    assert.equal(r.status, 403, `Nur lesen: ${method} ${url} → ${r.status}`);
    writes++;
  }
  assert.ok(writes > 50);
  assert.equal(permissionFor('POST', '/irgendwas/neues'), 'admin', 'unbekannte ändernde Aufrufe sind Administratoren vorbehalten');
  assert.deepEqual(ROLE_PERMISSIONS.LESER, ['read']);
});

test('Protokoll nennt den angemeldeten Benutzer, nicht eine frei gewählte Angabe', async () => {
  const r = await users.VERPACKER('POST', '/api/projects/1/hus', { packaging_type: 'KARTON', description: 'Namensprobe' }, { 'X-User': 'Jemand Anderes' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ev = (await admin('GET', '/api/events?project_id=1&limit=1')).data;
  const row = (ev.rows || ev)[0];
  assert.equal(row.user, 'paul Test');
});

test('Angaben zur SAP-Anbindung sehen nur Administratoren', async () => {
  await admin('PUT', '/api/settings', { sap_endpoint: 'https://sap.intern.example/odata', sap_auth: 'Bearer geheim' });
  const a = (await admin('GET', '/api/settings')).data;
  assert.equal(a.sap_endpoint, 'https://sap.intern.example/odata');
  assert.ok(!JSON.stringify(a).includes('geheim'));
  const l = (await users.LESER('GET', '/api/settings')).data;
  assert.ok(l.label_dpi);
  assert.deepEqual(Object.keys(l).filter((k) => k.startsWith('sap_')), []);
});

test('Anfragen von fremden Webseiten werden abgelehnt', async () => {
  let r = await admin('POST', '/api/projects', { number: 'P-CSRF' }, { Origin: 'https://boese.example' });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'ORIGIN');
  r = await client()('POST', '/api/auth/login', { username: 'chef', password: PW }, { Origin: 'https://boese.example' });
  assert.equal(r.status, 403);
  r = await admin('POST', '/api/projects', { number: 'P-CSRF' }, { Origin: base });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await admin('GET', '/')).headers.get('x-frame-options'), 'DENY');
});

test('Zugriffsschlüssel für Fremdsysteme: nur Eingangsschnittstellen, widerrufbar', async () => {
  let r = await admin('POST', '/api/api-tokens', { name: 'SAP Test' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { token, id } = r.data;
  assert.match(token, /^pvt_[\w-]{40,}$/);
  assert.ok(!JSON.stringify((await admin('GET', '/api/api-tokens')).data).includes(token), 'Schlüssel wird nur einmal ausgegeben');
  assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM api_tokens').all()).includes(token));
  const sap = (method, url, body, t = token) => client()(method, url, body, { Authorization: `Bearer ${t}` });
  r = await sap('POST', '/api/integration/materials', { materials: [{ material_number: '4711', description: 'Aus SAP', unit: 'ST' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await sap('GET', '/api/projects')).status, 403);
  assert.equal((await sap('POST', '/api/projects', { number: 'P-SAP' })).status, 403);
  assert.equal((await sap('POST', '/api/users', { username: 'x', role: 'ADMIN', password: PW })).status, 403);
  assert.equal((await sap('POST', '/api/integration/materials', { materials: [] }, 'pvt_falsch')).status, 401);
  assert.equal((await admin('DELETE', `/api/api-tokens/${id}`)).status, 200);
  assert.equal((await sap('POST', '/api/integration/materials', { materials: [] })).status, 401);
});

test('Fehlversuche: gleiche Meldung für unbekannte Konten, Sperre nach fünf Versuchen', async () => {
  const c = client();
  const a = await c('POST', '/api/auth/login', { username: 'gibtsnicht', password: 'irgendwas-langes' });
  const b = await c('POST', '/api/auth/login', { username: 'lena', password: 'irgendwas-langes' });
  assert.equal(a.status, 401);
  assert.deepEqual(a.data, b.data);
  for (let i = 0; i < 4; i++) assert.equal((await c('POST', '/api/auth/login', { username: 'lena', password: `falsch-${i}-falsch` })).status, 401);
  const locked = await c('POST', '/api/auth/login', { username: 'lena', password: PW });
  assert.equal(locked.status, 429, 'auch das richtige Passwort wird während der Sperre abgelehnt');
  assert.match(locked.data.error, /Zu viele Fehlversuche/);
  // Administrator setzt das Passwort zurück → Sperre aufgehoben, altes Passwort ungültig, laufende Sitzung beendet
  const r = await admin('PUT', '/api/users/5', { password: 'Neues-Start-Passwort' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await users.LESER('GET', '/api/projects')).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'lena', password: PW })).status, 401);
  const s = await c.login('lena', 'Neues-Start-Passwort');
  assert.equal(s.user.must_change_password, true);
});

test('Konten sperren und Rollen ändern wirkt sofort; der letzte Administrator bleibt', async () => {
  const list = (await admin('GET', '/api/users')).data;
  const id = (name) => list.users.find((u) => u.username === name).id;
  assert.equal(list.roles.VERPACKER, 'Verpackung');
  let r = await admin('PUT', `/api/users/${id('vera')}`, { active: false });
  assert.equal(r.status, 200);
  assert.equal((await users.VERLADER('GET', '/api/projects')).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'vera', password: PW })).status, 401);
  r = await admin('PUT', `/api/users/${id('paul')}`, { role: 'LESER' });
  assert.equal(r.status, 200);
  assert.equal((await users.VERPACKER('GET', '/api/projects')).status, 401, 'nach Rollenwechsel neu anmelden');
  const paul = client();
  await paul.login('paul');
  assert.equal((await paul('POST', '/api/projects/1/hus', { packaging_type: 'KISTE' })).status, 403);
  r = await admin('PUT', `/api/users/${id('chef')}`, { role: 'LESER' });
  assert.match(r.data.error, /eigene Konto/);
  r = await admin('PUT', `/api/users/${id('chef')}`, { active: false });
  assert.equal(r.status, 400);
  // Zweiter Administrator darf den ersten herabstufen, aber nie den letzten
  await admin('PUT', `/api/users/${id('dora')}`, { role: 'ADMIN' });
  const dora = client();
  await dora.login('dora');
  assert.equal((await dora('PUT', `/api/users/${id('chef')}`, { role: 'LESER' })).status, 200);
  r = await dora('PUT', `/api/users/${id('dora')}`, { active: false });
  assert.equal(r.status, 400);
  assert.equal((await admin('GET', '/api/users')).status, 401, 'herabgestufter Administrator ist abgemeldet');
  users.ADMIN2 = dora;
});

test('Passwortwechsel beendet andere Sitzungen, Abmelden die eigene', async () => {
  const a = client(); const b = client();
  await a.login('dora');
  await b.login('dora');
  const r = await a('POST', '/api/auth/password', { current: PW, password: 'Noch-ein-Passwort-7' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await a('GET', '/api/projects')).status, 200);
  assert.equal((await b('GET', '/api/projects')).status, 401);
  assert.equal((await a('POST', '/api/auth/logout')).status, 200);
  assert.equal((await a('GET', '/api/projects')).status, 401);
  assert.equal((await a('GET', '/api/auth/session')).data.user, null);
  users.ADMIN2 = client();
  await users.ADMIN2.login('dora', 'Noch-ein-Passwort-7');
});

test('Abgelaufene Sitzungen gelten nicht mehr', async () => {
  const c = client();
  await c.login('dora', 'Noch-ein-Passwort-7');
  assert.equal((await c('GET', '/api/projects')).status, 200);
  ctx.db.prepare("UPDATE sessions SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)").run();
  assert.equal((await c('GET', '/api/projects')).status, 401, '12 Stunden ohne Aktivität');
});

test('Sicherheitsprotokoll hält Anmeldungen, Fehlversuche und Kontoänderungen fest', async () => {
  const log = (await users.ADMIN2('GET', '/api/auth-log?limit=500')).data;
  const actions = new Set(log.map((x) => x.action));
  for (const a of ['EINRICHTUNG', 'EINRICHTUNG_ABGELEHNT', 'ANMELDUNG', 'ANMELDUNG_FEHLGESCHLAGEN', 'ABMELDUNG', 'PASSWORT_GEAENDERT', 'BENUTZER_ANGELEGT',
    'BENUTZER_GEAENDERT', 'ZUGRIFF_VERWEIGERT', 'SCHLUESSEL_ANGELEGT', 'SCHLUESSEL_WIDERRUFEN']) assert.ok(actions.has(a), a);
  assert.ok(!JSON.stringify(log).includes(PW), 'keine Passwörter im Protokoll');
  const change = log.find((x) => x.action === 'BENUTZER_GEAENDERT' && x.target === 'paul');
  assert.match(change.details, /Rolle: Verpackung → Nur lesen/);
});

test('Erneute Einrichtung nur mit --setup (Zugang wiederherstellen)', async () => {
  const again = createApp({ db: ctx.db, dataDir });
  assert.equal(again.auth.setupCode, null);
  const forced = createApp({ db: ctx.db, dataDir, setup: true });
  assert.match(forced.auth.setupCode, /^[A-Z2-9-]{14}$/);
  again.close();
  forced.close();
});
