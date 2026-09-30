'use strict';
// SAP-Rückmeldung (Demand Kap. 2 „Echtzeit-Rückmeldung an SAP“)
//
// Jede fachliche Buchung (HU angelegt, Material verpackt, Status, Warenausgang …) wird in einer
// Ausgangs-Warteschlange (sap_outbox) in derselben Datenbank-Transaktion gespeichert. Ist ein
// SAP-Endpunkt konfiguriert (z. B. ein OData-/REST-Service, SAP Integration Suite oder ein
// SOMA-Eingangsservice), werden die Nachrichten sofort und in exakt ihrer Reihenfolge per HTTP-POST
// übertragen. Fehlgeschlagene Übertragungen werden automatisch wiederholt; nachfolgende Nachrichten
// warten, damit SAP die Buchungen nie in falscher Reihenfolge erhält.

const { now } = require('./util');

const RETRY_INTERVAL_MS = 15000;
const REQUEST_TIMEOUT_MS = 15000;

function createSap(db, getSetting) {
  let running = null; // Promise der laufenden Übertragung
  let again = false;
  let timer = null;

  const insert = db.prepare(
    'INSERT INTO sap_outbox (created_at, type, payload) VALUES (?, ?, ?)'
  );

  function enqueue(type, payload, user) {
    const body = { ...payload, user: user || '', timestamp: now() };
    insert.run(now(), type, JSON.stringify(body));
  }

  function isEnabled() {
    return getSetting('sap_enabled') === '1' && getSetting('sap_endpoint').trim() !== '';
  }

  async function sendOne(msg) {
    const endpoint = getSetting('sap_endpoint').trim();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const auth = getSetting('sap_auth').trim();
    if (auth) headers.Authorization = auth;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messageId: msg.id,
          type: msg.type,
          createdAt: msg.created_at,
          payload: JSON.parse(msg.payload),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
      }
    } finally {
      clearTimeout(t);
    }
  }

  /** Überträgt die Warteschlange. Läuft bereits eine Übertragung, wird deren Promise zurückgegeben. */
  function processQueue() {
    if (running) { again = true; return running; }
    if (!isEnabled()) return Promise.resolve();
    running = runQueue().finally(() => { running = null; });
    return running;
  }

  async function runQueue() {
    do {
      again = false;
      const pending = db.prepare(
        "SELECT * FROM sap_outbox WHERE status IN ('PENDING','ERROR') ORDER BY id LIMIT 200"
      ).all();
      for (const msg of pending) {
        if (!isEnabled()) return;
        try {
          await sendOne(msg);
          db.prepare("UPDATE sap_outbox SET status='SENT', sent_at=?, attempts=attempts+1, last_error='' WHERE id=?")
            .run(now(), msg.id);
        } catch (err) {
          const text = err.name === 'AbortError' ? 'Zeitüberschreitung' : String(err.message || err);
          db.prepare("UPDATE sap_outbox SET status='ERROR', attempts=attempts+1, last_error=? WHERE id=?")
            .run(text.slice(0, 500), msg.id);
          return; // Reihenfolge wahren: nachfolgende Nachrichten warten auf die nächste Wiederholung
        }
      }
      if (pending.length === 200) again = true;
    } while (again);
  }

  function kick() {
    setImmediate(() => { processQueue().catch(() => {}); });
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { processQueue().catch(() => {}); }, RETRY_INTERVAL_MS);
    timer.unref?.();
    kick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stats() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM sap_outbox GROUP BY status').all();
    const out = { PENDING: 0, ERROR: 0, SENT: 0, EXPORTED: 0 };
    for (const r of rows) out[r.status] = r.n;
    const lastError = db.prepare("SELECT last_error FROM sap_outbox WHERE status='ERROR' ORDER BY id LIMIT 1").get();
    return { ...out, enabled: isEnabled(), last_error: lastError ? lastError.last_error : '' };
  }

  return { enqueue, kick, start, stop, stats, processQueue };
}

module.exports = { createSap };
