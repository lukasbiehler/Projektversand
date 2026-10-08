'use strict';
// Gemeinsamer Speicher für die Demo auf Vercel (Upstash Redis über die REST-Schnittstelle).
// Vercel verteilt Anfragen auf mehrere Instanzen mit jeweils eigenem temporären Speicher. Damit alle denselben
// Datenstand sehen, liegt die Datenbank der Demo als Abbild in Redis: vor jeder Anfrage wird der Stand abgeglichen,
// nach jeder Änderung zurückgeschrieben. Ändernde Anfragen laufen über eine Sperre nacheinander.

const crypto = require('node:crypto');

const PREFIX = 'pv:demo:';
const KEY = { ver: PREFIX + 'ver', db: PREFIX + 'db', lock: PREFIX + 'lock', photo: (epoch, rel) => `${PREFIX}photo:${epoch}:${rel}` };
/** Ohne Aufrufe verfällt der Stand – die Demo startet danach wieder mit dem Beispielprojekt */
const TTL_S = 12 * 60 * 60;
const LOCK_MS = 20000;
const LOCK_WAIT_MS = 15000;
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createRedisStore(url, token) {
  const base = String(url).replace(/\/+$/, '');
  async function request(path, body) {
    const res = await fetch(base + path, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) throw new Error(`Demo-Speicher: ${(data && data.error) || `HTTP ${res.status}`}`);
    return data;
  }
  const cmd = async (...args) => (await request('', args)).result;
  /** Mehrere Befehle als eine Transaktion */
  const multi = async (cmds) => (await request('/multi-exec', cmds)).map((r) => {
    if (r.error) throw new Error(`Demo-Speicher: ${r.error}`);
    return r.result;
  });

  async function lock() {
    const id = crypto.randomUUID();
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      if (await cmd('SET', KEY.lock, id, 'NX', 'PX', LOCK_MS) === 'OK') return id;
      if (Date.now() > until) throw new Error('Demo-Speicher: Sperre nicht erhalten.');
      await sleep(40);
    }
  }
  const unlock = (id) => cmd('EVAL', UNLOCK, 1, KEY.lock, id);

  return {
    lock, unlock,
    version: () => cmd('GET', KEY.ver),
    /** → { ver, epoch, db: Buffer } oder null, wenn noch kein Stand vorhanden ist */
    async load() {
      const [ver, raw] = await cmd('MGET', KEY.ver, KEY.db);
      if (!ver || !raw) return null;
      const { epoch, data } = JSON.parse(raw);
      return { ver, epoch, db: Buffer.from(data, 'base64') };
    },
    async save(epoch, db) {
      const ver = crypto.randomUUID();
      await multi([
        ['SET', KEY.db, JSON.stringify({ epoch, data: db.toString('base64') }), 'EX', TTL_S],
        ['SET', KEY.ver, ver, 'EX', TTL_S],
      ]);
      return ver;
    },
    savePhoto: (epoch, rel, buf) => cmd('SET', KEY.photo(epoch, rel), buf.toString('base64'), 'EX', TTL_S),
    async loadPhoto(epoch, rel) {
      const raw = await cmd('GET', KEY.photo(epoch, rel));
      return raw ? Buffer.from(raw, 'base64') : null;
    },
  };
}

/** Zugangsdaten, wie sie die Upstash-Anbindung von Vercel als Umgebungsvariablen setzt */
function storeFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? createRedisStore(url, token) : null;
}

module.exports = { createRedisStore, storeFromEnv };
