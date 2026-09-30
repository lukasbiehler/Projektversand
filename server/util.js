'use strict';

class AppError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

const bad = (msg, extra) => new AppError(400, msg, extra);
const notFound = (msg) => new AppError(404, msg);
const conflict = (msg, extra) => new AppError(409, msg, extra);

const now = () => new Date().toISOString();

/** Mengen werden auf 3 Nachkommastellen geführt (wie SAP) */
const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const EPS = 1e-9;

/** Text normalisieren (trim, max. Länge) */
function str(v, max = 500) {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
}

/**
 * Zahl aus API-Eingaben (JSON-Zahl oder Zeichenkette mit Punkt oder Komma als Dezimaltrenner).
 * Liefert null für leer, NaN für ungültig.
 */
function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replace(/\s/g, '');
  if (s === '') return null;
  if (!s.includes('.') && (s.match(/,/g) || []).length === 1) s = s.replace(',', '.');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/**
 * Zahl aus Import-Dateien mit fest gewähltem Zahlenformat:
 *  DE: 1.234,5  (Punkt = Tausender, Komma = Dezimal)
 *  EN: 1,234.5  (Komma = Tausender, Punkt = Dezimal)
 * Numerische Excel-Zellen werden unverändert übernommen.
 */
function parseLocaleNumber(v, format = 'DE') {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).trim().replace(/[\s ']/g, '');
  if (s === '') return null;
  if (format === 'EN') {
    if (!/^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(s) || s === '' || s === '+' || s === '-') return NaN;
    s = s.replace(/,/g, '');
  } else {
    if (!/^[+-]?(\d{1,3}(\.\d{3})+|\d+)?(,\d+)?$/.test(s) || s === '' || s === '+' || s === '-') return NaN;
    s = s.replace(/\./g, '').replace(',', '.');
  }
  if (!/\d/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Positive Zahl prüfen (Menge, Maße …) */
function requirePositive(v, label, { integer = false, allowNull = false, allowZero = false } = {}) {
  const n = toNum(v);
  if (n === null) {
    if (allowNull) return null;
    throw bad(`${label} ist ein Pflichtfeld.`);
  }
  if (Number.isNaN(n)) throw bad(`${label} ist keine gültige Zahl.`);
  if (allowZero ? n < 0 : n <= 0) throw bad(`${label} muss ${allowZero ? 'größer oder gleich' : 'größer als'} 0 sein.`);
  if (integer && Math.abs(n - Math.round(n)) > EPS) throw bad(`${label} muss ganzzahlig sein.`);
  return round3(n);
}

/**
 * Materialnummern werden wie in der SAP-Anzeige geführt: rein numerische Nummern ohne führende Nullen
 * (SAP-Konvertierung ALPHA), alphanumerische unverändert (Großschreibung).
 */
function normMaterial(v) {
  let s = str(v, 40).toUpperCase();
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  return s;
}

function normUnit(v) {
  return str(v, 10).toUpperCase();
}

/** LIKE-Muster mit maskierten Platzhaltern */
function likePattern(q) {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/** Wahrheitswert aus API- oder Import-Eingaben (ja/nein, x, 1/0, true/false) */
function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  return ['1', 'true', 'ja', 'j', 'x', 'yes', 'y', 'on', 'wahr'].includes(s);
}

function parseJsonSafe(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = {
  AppError, bad, notFound, conflict, now, round3, EPS, str, toNum, parseLocaleNumber,
  requirePositive, normMaterial, normUnit, likePattern, parseJsonSafe, toBool,
};
