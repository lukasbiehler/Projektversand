'use strict';
// Anmeldung, Sitzungen, Rollen und Rechte
//
// - Benutzerkonten mit Passwort (scrypt), Sitzung als zufälliges Token im HttpOnly-Cookie; in der Datenbank liegt
//   nur der SHA-256-Wert des Tokens.
// - Jede Schnittstelle verlangt eine Berechtigung (siehe permissionFor); unbekannte ändernde Aufrufe sind
//   Administratoren vorbehalten.
// - Fremdsysteme (z. B. SAP) melden sich mit einem Zugriffsschlüssel an (Authorization: Bearer …), der nur die
//   Eingangsschnittstellen freigibt.
// - Sicherheitsrelevante Vorgänge (Anmeldungen, Fehlversuche, Änderungen an Konten) stehen im Sicherheitsprotokoll.

const crypto = require('node:crypto');
const express = require('express');
const { AppError, bad, notFound, now, str } = require('./util');

const ROLES = {
  ADMIN: 'Administrator',
  DISPONENT: 'Disposition',
  VERPACKER: 'Verpackung',
  VERLADER: 'Verladung',
  LESER: 'Nur lesen',
};

const PERMISSIONS = {
  read: 'Alle Daten ansehen, suchen, Etiketten erzeugen',
  plan: 'Projekte, PSP-Elemente und Packvorrat pflegen und importieren',
  report: 'Fehlteile melden und Positionsstatus setzen',
  materials: 'Materialstamm und Barcodes pflegen',
  pack: 'Packstücke anlegen, verpacken, abschließen, Verpackungsfotos',
  load: 'Lieferungen anlegen, verladen, Warenausgang, Verladefotos',
  loadplan: 'Ladeplanung und Fahrzeugtypen',
  print: 'Etiketten an Netzwerkdrucker senden',
  integration: 'Eingangsschnittstellen für Fremdsysteme',
  admin: 'Einstellungen, Drucker, SAP-Schnittstelle, Benutzer und Zugriffsschlüssel',
};

const ROLE_PERMISSIONS = {
  ADMIN: Object.keys(PERMISSIONS),
  DISPONENT: ['read', 'plan', 'report', 'materials', 'pack', 'load', 'loadplan', 'print'],
  VERPACKER: ['read', 'report', 'pack', 'print'],
  VERLADER: ['read', 'load', 'print'],
  LESER: ['read'],
};

// Lesende Aufrufe, die mehr als „read“ verlangen
const READ_RULES = [
  [/^\/(users|api-tokens|auth-log)(\/|$)/, 'admin'],
  [/^\/sap\//, 'admin'],
];
// Ändernde Aufrufe (erste passende Regel gilt). Mehrere Rechte = eines davon genügt.
const WRITE_RULES = [
  [/^\/labels\//, 'read'], // erzeugt nur Etikettendaten, ändert nichts
  [/^\/print$/, 'print'],
  [/^\/integration\//, 'integration'],
  [/^\/items\/status$/, 'report'],
  [/^\/items\/\d+\/missing$/, 'report'],
  [/^\/projects\/\d+\/(items|import|psp)$/, 'plan'],
  [/^\/(items|psp)\//, 'plan'],
  [/^\/projects(\/\d+)?$/, 'plan'],
  [/^\/(materials|barcodes)(\/|$)/, 'materials'],
  [/^\/projects\/\d+\/hus$/, 'pack'],
  [/^\/hus\//, 'pack'],
  [/^\/projects\/\d+\/deliveries$/, 'load'],
  [/^\/deliveries\//, 'load'],
  [/^\/projects\/\d+\/loadplans$/, 'loadplan'],
  [/^\/(vehicle-types|loadplans|loadplan-items)(\/|$)/, 'loadplan'],
  [/^\/photos(\/|$)/, ['pack', 'load']],
];

/** Erforderliche Berechtigung(en) für einen API-Aufruf (Pfad ohne /api) */
function permissionFor(method, path) {
  const read = method === 'GET' || method === 'HEAD';
  for (const [rx, perm] of read ? READ_RULES : WRITE_RULES) if (rx.test(path)) return perm;
  return read ? 'read' : 'admin';
}

const COOKIE = 'pv_session';
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // ohne Aktivität
const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000; // absolute Obergrenze
const TOUCH_MS = 60 * 1000;
const PASSWORD_MIN = 10;
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const WEAK = ['1234567890', '0123456789', 'passwort123', 'password123', 'qwertzuiop', 'qwertyuiop', 'projektversand'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const unauthorized = (msg = 'Bitte anmelden.') => new AppError(401, msg, { code: 'AUTH_REQUIRED' });
const forbidden = (msg = 'Dafür fehlt Ihrem Konto die Berechtigung.', code = 'FORBIDDEN') => new AppError(403, msg, { code });

function scrypt(password, salt, { N, r, p, maxmem }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function checkPassword(password, username) {
  const pw = String(password ?? '');
  if (pw.length < PASSWORD_MIN) throw bad(`Das Passwort muss mindestens ${PASSWORD_MIN} Zeichen lang sein.`);
  if (pw.length > 200) throw bad('Das Passwort ist zu lang (höchstens 200 Zeichen).');
  const low = pw.toLowerCase();
  if (username && low.includes(String(username).toLowerCase())) throw bad('Das Passwort darf den Benutzernamen nicht enthalten.');
  if (new Set(pw).size < 5 || WEAK.includes(low)) throw bad('Dieses Passwort ist zu leicht zu erraten.');
  return pw;
}

function normUsername(v) {
  const u = str(v, 60).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(u)) throw bad('Benutzername: 3–40 Zeichen aus Buchstaben (ohne Umlaute), Ziffern, Punkt, Bindestrich oder Unterstrich.');
  return u;
}

/** Fehlversuche begrenzen (je Benutzername und je Absender-Adresse, im Arbeitsspeicher) */
function createThrottle() {
  const map = new Map();
  const WINDOW = 15 * 60 * 1000;
  function entry(key) {
    const e = map.get(key);
    if (e && Date.now() - e.last > WINDOW) { map.delete(key); return null; }
    return e || null;
  }
  return {
    check(key) {
      const e = entry(key);
      if (e && e.lockedUntil > Date.now()) {
        const min = Math.ceil((e.lockedUntil - Date.now()) / 60000);
        throw new AppError(429, `Zu viele Fehlversuche. Bitte in ${min} Minute${min === 1 ? '' : 'n'} erneut versuchen.`, { code: 'LOCKED' });
      }
    },
    fail(key, limit) {
      if (map.size > 10000) for (const k of map.keys()) entry(k);
      const e = entry(key) || { count: 0, lockedUntil: 0 };
      e.count += 1;
      e.last = Date.now();
      if (e.count >= limit) e.lockedUntil = Date.now() + Math.min(WINDOW, 30000 * 2 ** (e.count - limit));
      map.set(key, e);
    },
    reset(key) { map.delete(key); },
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function createAuth(db, { forceSetup = false } = {}) {
  const throttle = createThrottle();
  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const newSetupCode = () => {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('').replace(/(.{4})(?=.)/g, '$1-');
  };
  // Einmal-Code für das Anlegen des ersten Administrators – steht nur in der Konsole des Servers
  let setupCode = forceSetup || userCount() === 0 ? newSetupCode() : null;
  let dummyHash = null;

  function audit(req, actor, action, target = '', details = '') {
    db.prepare('INSERT INTO auth_log (at, actor, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), str(actor, 80), action, str(target, 80), str(details, 300), str(req && req.ip, 60));
  }

  const publicUser = (u) => ({
    id: u.id, username: u.username, display_name: u.display_name, role: u.role, role_label: ROLES[u.role] || u.role,
    active: !!u.active, must_change_password: !!u.must_change_password, created_at: u.created_at, last_login_at: u.last_login_at,
  });

  // ---------------------------------------------------------------- Sitzungen
  function setCookie(req, res, token, maxAgeMs) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }
  function createSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(t).toISOString());
    db.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), user.id, new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + SESSION_MAX_MS).toISOString());
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date(t).toISOString(), user.id);
    setCookie(req, res, token, SESSION_MAX_MS);
  }
  const dropSessions = (userId, exceptId = '') => db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptId);

  /** Wer ruft auf? → Benutzer (Cookie), Fremdsystem (Zugriffsschlüssel) oder null */
  function identify(req) {
    const header = String(req.headers.authorization || '');
    if (/^Bearer\s+/i.test(header)) {
      const t = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(sha256(header.replace(/^Bearer\s+/i, '').trim()));
      if (!t) return null;
      if (!t.last_used_at || Date.now() - Date.parse(t.last_used_at) > TOUCH_MS) db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), t.id);
      return { type: 'token', id: t.id, name: `Schnittstelle ${t.name}`, permissions: new Set(['integration']) };
    }
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const sid = sha256(token);
    const s = db.prepare('SELECT s.*, u.username, u.display_name, u.role, u.active, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(sid);
    if (!s) return null;
    const t = Date.now();
    if (!s.active || Date.parse(s.expires_at) < t || Date.parse(s.last_seen_at) + SESSION_IDLE_MS < t) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      return null;
    }
    if (t - Date.parse(s.last_seen_at) > TOUCH_MS) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(t).toISOString(), sid);
    return {
      type: 'user', id: s.user_id, sessionId: sid, username: s.username, name: s.display_name || s.username, role: s.role,
      mustChange: !!s.must_change_password, permissions: new Set(ROLE_PERMISSIONS[s.role] || []),
    };
  }

  /** Ändernde Aufrufe mit Cookie nur von der eigenen Seite annehmen (Schutz vor fremden Webseiten) */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) {
      try { return new URL(origin).host === req.headers.host; } catch { return false; }
    }
    return req.headers['sec-fetch-site'] !== 'cross-site';
  }

  const can = (principal, perm) => (Array.isArray(perm) ? perm : [perm]).some((p) => principal.permissions.has(p));

  /** Schutz aller folgenden Schnittstellen: Anmeldung und Berechtigung prüfen */
  function guard(req, res, next) {
    try {
      const p = identify(req);
      if (!p) throw unauthorized();
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (p.type === 'user' && write && !sameOrigin(req)) throw forbidden('Anfrage von fremder Herkunft abgelehnt.', 'ORIGIN');
      if (p.mustChange) throw forbidden('Bitte zuerst ein eigenes Passwort vergeben.', 'PASSWORD_CHANGE_REQUIRED');
      const perm = permissionFor(req.method, req.path);
      if (!can(p, perm)) {
        audit(req, p.username || p.name, 'ZUGRIFF_VERWEIGERT', `${req.method} ${req.path}`.slice(0, 80));
        throw forbidden();
      }
      req.principal = p;
      req.user = p.name;
      next();
    } catch (err) { next(err); }
  }

  function sessionInfo(p) {
    return {
      auth: true,
      setup_required: userCount() === 0,
      setup_available: !!setupCode,
      user: p && p.type === 'user' ? {
        id: p.id, username: p.username, display_name: p.name, role: p.role, role_label: ROLES[p.role] || p.role,
        permissions: [...p.permissions], must_change_password: p.mustChange,
      } : null,
    };
  }

  // ---------------------------------------------------------------- Anmeldung (ohne vorherige Sitzung erreichbar)
  function router() {
    const r = express.Router();
    r.use(express.json({ limit: '10kb' }));
    r.use((req, res, next) => (req.method === 'GET' || sameOrigin(req) ? next() : next(forbidden('Anfrage von fremder Herkunft abgelehnt.', 'ORIGIN'))));
    const h =(fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).then((v) => res.json(v)).catch(next); };
    const requireUser = (req) => {
      const p = identify(req);
      if (!p || p.type !== 'user') throw unauthorized();
      return p;
    };

    r.get('/session', h((req) => sessionInfo(identify(req))));

    r.post('/login', h(async (req, res) => {
      const body = req.body || {};
      const username = str(body.username, 60).toLowerCase();
      const keys = [`u:${username}`, `ip:${req.ip}`];
      for (const k of keys) throttle.check(k);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
      // Auch bei unbekanntem Benutzer rechnen, damit die Antwortzeit nichts verrät
      const ok = await verifyPassword(String(body.password ?? ''), user ? user.password_hash : dummyHash);
      if (!ok || !user || !user.active) {
        throttle.fail(keys[0], 5);
        throttle.fail(keys[1], 20);
        audit(req, username, 'ANMELDUNG_FEHLGESCHLAGEN');
        throw new AppError(401, 'Benutzername oder Passwort ist falsch.', { code: 'LOGIN_FAILED' });
      }
      throttle.reset(keys[0]);
      createSession(req, res, user);
      audit(req, user.username, 'ANMELDUNG');
      return sessionInfo({ type: 'user', id: user.id, username: user.username, name: user.display_name || user.username, role: user.role,
        mustChange: !!user.must_change_password, permissions: new Set(ROLE_PERMISSIONS[user.role] || []) });
    }));

    r.post('/setup', h(async (req, res) => {
      const body = req.body || {};
      const key = `setup:${req.ip}`;
      throttle.check(key);
      const given = Buffer.from(str(body.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, ''));
      const expected = Buffer.from(String(setupCode || '').replace(/-/g, ''));
      if (!setupCode || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        throttle.fail(key, 5);
        audit(req, str(body.username, 60), 'EINRICHTUNG_ABGELEHNT');
        throw forbidden('Der Einrichtungscode ist nicht gültig. Er steht in der Konsole des Servers.', 'SETUP_CODE');
      }
      const username = normUsername(body.username);
      const hash = await hashPassword(checkPassword(body.password, username));
      const r2 = db.prepare('INSERT INTO users (username, display_name, role, password_hash, active, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)')
        .run(username, str(body.display_name, 60) || username, 'ADMIN', hash, now());
      setupCode = null;
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r2.lastInsertRowid));
      createSession(req, res, user);
      audit(req, username, 'EINRICHTUNG', username, 'Administrator angelegt');
      return sessionInfo({ type: 'user', id: user.id, username, name: user.display_name, role: 'ADMIN', mustChange: false, permissions: new Set(ROLE_PERMISSIONS.ADMIN) });
    }));

    r.post('/logout', h((req, res) => {
      const p = identify(req);
      if (p && p.type === 'user') {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(p.sessionId);
        audit(req, p.username, 'ABMELDUNG');
      }
      setCookie(req, res, '', 0);
      return { ok: true };
    }));

    r.post('/password', h(async (req) => {
      const p = requireUser(req);
      const body = req.body || {};
      const key = `pw:${p.id}`;
      throttle.check(key);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(p.id);
      if (!(await verifyPassword(String(body.current ?? ''), user.password_hash))) {
        throttle.fail(key, 5);
        throw bad('Das aktuelle Passwort ist nicht richtig.');
      }
      const pw = checkPassword(body.password, user.username);
      if (pw === String(body.current)) throw bad('Das neue Passwort muss sich vom bisherigen unterscheiden.');
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await hashPassword(pw), p.id);
      dropSessions(p.id, p.sessionId);
      throttle.reset(key);
      audit(req, p.username, 'PASSWORT_GEAENDERT');
      return sessionInfo({ ...p, mustChange: false });
    }));

    r.use((req, res, next) => next(notFound('Unbekannte Schnittstelle.')));
    return r;
  }

  // ---------------------------------------------------------------- Verwaltung (nur Administratoren, hinter guard)
  const getUser = (id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
    if (!u) throw notFound('Benutzer nicht gefunden.');
    return u;
  };
  const activeAdmins = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND active = 1").get().n;
  const role = (v) => {
    const r = str(v, 20).toUpperCase();
    if (!ROLES[r]) throw bad('Unbekannte Rolle.');
    return r;
  };

  function listUsers() {
    return {
      users: db.prepare('SELECT * FROM users ORDER BY active DESC, username').all().map(publicUser),
      roles: ROLES, permissions: PERMISSIONS, role_permissions: ROLE_PERMISSIONS, password_min: PASSWORD_MIN,
    };
  }

  async function createUser(req) {
    const body = req.body || {};
    const username = normUsername(body.username);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new AppError(409, `Der Benutzername „${username}“ ist bereits vergeben.`);
    const r = role(body.role);
    const hash = await hashPassword(checkPassword(body.password, username));
    const res = db.prepare('INSERT INTO users (username, display_name, role, password_hash, active, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)')
      .run(username, str(body.display_name, 60) || username, r, hash, now());
    audit(req, req.principal.username, 'BENUTZER_ANGELEGT', username, ROLES[r]);
    return publicUser(getUser(res.lastInsertRowid));
  }

  async function updateUser(req, id) {
    const u = getUser(id);
    const body = req.body || {};
    const next = {
      display_name: body.display_name !== undefined ? str(body.display_name, 60) || u.username : u.display_name,
      role: body.role !== undefined ? role(body.role) : u.role,
      active: body.active !== undefined ? (body.active ? 1 : 0) : u.active,
    };
    if (u.id === req.principal.id && (!next.active || next.role !== 'ADMIN')) throw bad('Das eigene Konto kann nicht gesperrt oder herabgestuft werden.');
    if (u.role === 'ADMIN' && u.active && (next.role !== 'ADMIN' || !next.active) && activeAdmins() <= 1) throw bad('Es muss mindestens ein aktiver Administrator bleiben.');
    const changes = [];
    if (next.role !== u.role) changes.push(`Rolle: ${ROLES[u.role]} → ${ROLES[next.role]}`);
    if (next.active !== u.active) changes.push(next.active ? 'entsperrt' : 'gesperrt');
    if (next.display_name !== u.display_name) changes.push('Name geändert');
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE id = ?').run(next.display_name, next.role, next.active, u.id);
    if (body.password !== undefined && body.password !== '') {
      const hash = await hashPassword(checkPassword(body.password, u.username));
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, u.id);
      throttle.reset(`u:${u.username}`);
      changes.push('Passwort zurückgesetzt');
    }
    // Geänderte Rechte, Sperre oder neues Passwort gelten sofort: bestehende Sitzungen beenden
    if (next.role !== u.role || !next.active || (body.password !== undefined && body.password !== '')) dropSessions(u.id, u.id === req.principal.id ? req.principal.sessionId : '');
    if (changes.length) audit(req, req.principal.username, 'BENUTZER_GEAENDERT', u.username, changes.join(', '));
    return publicUser(getUser(u.id));
  }

  function listTokens() {
    return db.prepare('SELECT id, name, created_at, created_by, last_used_at FROM api_tokens ORDER BY id').all();
  }
  function createToken(req) {
    const name = str((req.body || {}).name, 60);
    if (!name) throw bad('Bitte eine Bezeichnung angeben (z. B. „SAP Produktiv“).');
    const token = `pvt_${crypto.randomBytes(32).toString('base64url')}`;
    const r = db.prepare('INSERT INTO api_tokens (name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?)').run(name, sha256(token), now(), req.principal.username);
    audit(req, req.principal.username, 'SCHLUESSEL_ANGELEGT', name);
    // Der Schlüssel wird nur dieses eine Mal ausgegeben
    return { id: Number(r.lastInsertRowid), name, token };
  }
  function deleteToken(req, id) {
    const t = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(Number(id));
    if (!t) throw notFound('Zugriffsschlüssel nicht gefunden.');
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(t.id);
    audit(req, req.principal.username, 'SCHLUESSEL_WIDERRUFEN', t.name);
    return { ok: true };
  }
  const listLog = (limit) => db.prepare('SELECT * FROM auth_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(Number(limit) || 100, 1), 500));

  return {
    router, guard, can, listUsers, createUser, updateUser, listTokens, createToken, deleteToken, listLog,
    get setupCode() { return setupCode; },
  };
}

module.exports = { createAuth, permissionFor, hashPassword, verifyPassword, ROLES, PERMISSIONS, ROLE_PERMISSIONS };
