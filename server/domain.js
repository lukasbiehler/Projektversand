'use strict';
// Fachlogik Projektversand. Alle schreibenden Funktionen laufen in einer Transaktion (mutate) und
// schreiben ein Ereignis in das Protokoll (Rückverfolgbarkeit) sowie – wo relevant – eine Nachricht in die
// SAP-Ausgangswarteschlange.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('./constants');
const U = require('./util');
const { transaction } = require('./db');
const { createSap } = require('./sap');

const { bad, notFound, conflict, str, round3, EPS } = U;

const DEFAULT_SETTINGS = {
  hu_prefix: 'HU',
  hu_seq: '0',
  delivery_prefix: 'L',
  delivery_seq: '0',
  label_header: 'Projektversand',
  barcode_regex: '',
  sap_enabled: '0',
  sap_endpoint: '',
  sap_auth: '',
  label_dpi: '203',
};

/** Über die Oberfläche änderbare Einstellungen */
const EDITABLE_SETTINGS = ['hu_prefix', 'delivery_prefix', 'label_header', 'barcode_regex', 'sap_enabled', 'sap_endpoint', 'sap_auth', 'label_dpi'];

const RANK_TO_HU_STATUS = Object.fromEntries(Object.entries(C.HU_STATUS_RANK).map(([k, v]) => [v, k]));

function huStatusKey(h) {
  if (h.ship_status === 'AUSGELIEFERT') return 'AUSGELIEFERT';
  if (h.ship_status === 'VERLADEN') return 'VERLADEN';
  if (h.ship_status === 'VERSANDBEREIT') return 'VERSANDBEREIT';
  if (h.pack_status === 'ABGESCHLOSSEN') return 'VERPACKUNG_ABGESCHLOSSEN';
  if (h.pack_status === 'BEGONNEN') return 'VERPACKUNG_BEGONNEN';
  return 'ANGELEGT';
}

const isInt = (n) => Math.abs(n - Math.round(n)) < EPS;
const fmtQty = (n) => String(round3(n)).replace('.', ',');

function createDomain(db, { photosDir, onChange = () => {} } = {}) {
  // ------------------------------------------------------------------ Einstellungen
  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  function getSetting(key) {
    const r = getSettingStmt.get(key);
    return r ? r.value : (DEFAULT_SETTINGS[key] ?? '');
  }
  function setSetting(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  const sap = createSap(db, getSetting);

  // ------------------------------------------------------------------ Transaktion + Benachrichtigung
  let touched = null;
  function mutate(fn) {
    if (touched) return fn();
    touched = new Set();
    let result;
    let changed;
    try {
      result = transaction(db, fn);
    } finally {
      changed = touched;
      touched = null;
    }
    if (changed.size === 0) onChange({ project_id: null });
    for (const pid of changed) onChange({ project_id: pid });
    sap.kick();
    return result;
  }

  const insEvent = db.prepare(
    'INSERT INTO events (ts, user, project_id, entity, entity_id, ref, action, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  function log(user, projectId, entity, entityId, ref, action, details = '') {
    insEvent.run(U.now(), user || '', projectId ?? null, entity, entityId ?? null, ref || '', action, String(details || ''));
    if (touched && projectId) touched.add(projectId);
  }

  // ------------------------------------------------------------------ Projekte & PSP
  function getProject(id) {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
    if (!p) throw notFound('Projekt nicht gefunden.');
    return p;
  }

  function createProject(user, body) {
    const number = str(body.number, 40);
    if (!number) throw bad('Projektnummer ist ein Pflichtfeld.');
    return mutate(() => {
      if (db.prepare('SELECT 1 FROM projects WHERE number = ?').get(number)) throw conflict(`Projekt ${number} existiert bereits.`);
      const r = db.prepare('INSERT INTO projects (number, name, customer, destination, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(number, str(body.name, 200), str(body.customer, 200), str(body.destination, 300), U.now());
      const id = Number(r.lastInsertRowid);
      log(user, id, 'project', id, number, 'Projekt angelegt', str(body.name, 200));
      return getProject(id);
    });
  }

  function updateProject(user, id, body) {
    return mutate(() => {
      const p = getProject(id);
      const number = body.number !== undefined ? str(body.number, 40) : p.number;
      if (!number) throw bad('Projektnummer ist ein Pflichtfeld.');
      if (number !== p.number) {
        if (db.prepare('SELECT 1 FROM handling_units WHERE project_id = ?').get(p.id)) {
          throw bad('Die Projektnummer kann nicht mehr geändert werden, da bereits Packstücke angelegt sind.');
        }
        if (db.prepare('SELECT 1 FROM projects WHERE number = ? AND id <> ?').get(number, p.id)) throw conflict(`Projekt ${number} existiert bereits.`);
      }
      const name = body.name !== undefined ? str(body.name, 200) : p.name;
      const customer = body.customer !== undefined ? str(body.customer, 200) : p.customer;
      const destination = body.destination !== undefined ? str(body.destination, 300) : p.destination;
      db.prepare('UPDATE projects SET number = ?, name = ?, customer = ?, destination = ? WHERE id = ?')
        .run(number, name, customer, destination, p.id);
      log(user, p.id, 'project', p.id, number, 'Projektdaten geändert');
      return getProject(p.id);
    });
  }

  function listPsp(projectId) {
    return db.prepare(`
      SELECT ps.*,
        (SELECT COUNT(*) FROM pack_items pi WHERE pi.psp_id = ps.id) AS item_count,
        (SELECT COUNT(*) FROM handling_units h WHERE h.psp_id = ps.id) AS hu_count
      FROM psp_elements ps WHERE ps.project_id = ? ORDER BY ps.code`).all(Number(projectId));
  }

  function getPsp(id) {
    const r = db.prepare('SELECT * FROM psp_elements WHERE id = ?').get(Number(id));
    if (!r) throw notFound('PSP-Element nicht gefunden.');
    return r;
  }

  function checkPspOfProject(pspId, projectId) {
    if (pspId === null || pspId === undefined || pspId === '') return null;
    const ps = getPsp(pspId);
    if (ps.project_id !== projectId) throw bad('Das PSP-Element gehört nicht zu diesem Projekt.');
    return ps.id;
  }

  function ensurePsp(projectId, code, description) {
    code = str(code, 60);
    if (!code) return null;
    const r = db.prepare('SELECT * FROM psp_elements WHERE project_id = ? AND code = ?').get(projectId, code);
    if (r) {
      if (description && !r.description) db.prepare('UPDATE psp_elements SET description = ? WHERE id = ?').run(str(description, 200), r.id);
      return r.id;
    }
    const ins = db.prepare('INSERT INTO psp_elements (project_id, code, description) VALUES (?, ?, ?)')
      .run(projectId, code, str(description, 200));
    return Number(ins.lastInsertRowid);
  }

  function createPsp(user, projectId, body) {
    return mutate(() => {
      const p = getProject(projectId);
      const code = str(body.code, 60);
      if (!code) throw bad('PSP-Element ist ein Pflichtfeld.');
      if (db.prepare('SELECT 1 FROM psp_elements WHERE project_id = ? AND code = ?').get(p.id, code)) throw conflict(`PSP-Element ${code} existiert bereits.`);
      const id = ensurePsp(p.id, code, body.description);
      log(user, p.id, 'psp', id, code, 'PSP-Element angelegt', str(body.description, 200));
      return getPsp(id);
    });
  }

  function updatePsp(user, id, body) {
    return mutate(() => {
      const ps = getPsp(id);
      const code = body.code !== undefined ? str(body.code, 60) : ps.code;
      if (!code) throw bad('PSP-Element ist ein Pflichtfeld.');
      if (code !== ps.code && db.prepare('SELECT 1 FROM psp_elements WHERE project_id = ? AND code = ? AND id <> ?').get(ps.project_id, code, ps.id)) {
        throw conflict(`PSP-Element ${code} existiert bereits.`);
      }
      const description = body.description !== undefined ? str(body.description, 200) : ps.description;
      db.prepare('UPDATE psp_elements SET code = ?, description = ? WHERE id = ?').run(code, description, ps.id);
      log(user, ps.project_id, 'psp', ps.id, code, 'PSP-Element geändert', ps.code !== code ? `vorher ${ps.code}` : '');
      return getPsp(ps.id);
    });
  }

  function deletePsp(user, id) {
    return mutate(() => {
      const ps = getPsp(id);
      if (db.prepare('SELECT 1 FROM pack_items WHERE psp_id = ?').get(ps.id) || db.prepare('SELECT 1 FROM handling_units WHERE psp_id = ?').get(ps.id)) {
        throw bad(`PSP-Element ${ps.code} wird noch von Positionen oder Packstücken verwendet.`);
      }
      db.prepare('DELETE FROM psp_elements WHERE id = ?').run(ps.id);
      log(user, ps.project_id, 'psp', ps.id, ps.code, 'PSP-Element gelöscht');
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ Materialstamm & Barcodes
  function findMaterial(nr) {
    const n = U.normMaterial(nr);
    if (!n) return null;
    return db.prepare('SELECT * FROM materials WHERE material_number = ?').get(n) || null;
  }

  function getMaterial(nr) {
    const m = findMaterial(nr);
    if (!m) throw notFound(`Material ${str(nr, 40)} ist nicht im Materialstamm vorhanden.`);
    return m;
  }

  function barcodesOf(materialNumber) {
    return db.prepare('SELECT * FROM material_barcodes WHERE material_number = ? ORDER BY is_primary DESC, barcode').all(materialNumber);
  }

  function barcodeOwner(barcode) {
    const r = db.prepare('SELECT material_number FROM material_barcodes WHERE barcode = ?').get(barcode);
    return r ? r.material_number : null;
  }

  function validateBarcode(barcode, symbology) {
    if (!C.SYMBOLOGIES[symbology]) throw bad(`Unbekannte Barcode-Art ${symbology}.`);
    if (!barcode) throw bad('Barcode ist leer.');
    const checks = {
      EAN13: [/^\d{12,13}$/, 'EAN-13 benötigt 12 oder 13 Ziffern'],
      EAN8: [/^\d{7,8}$/, 'EAN-8 benötigt 7 oder 8 Ziffern'],
      ITF: [/^(\d\d)+$/, 'Interleaved 2 of 5 benötigt eine gerade Anzahl Ziffern'],
      CODE39: [/^[0-9A-Z \-.$/+%]+$/, 'Code 39 erlaubt nur Ziffern, Großbuchstaben und - . $ / + % Leerzeichen'],
      CODE128: [/^[\x20-\x7E]+$/, 'Code 128 erlaubt nur druckbare ASCII-Zeichen (keine Umlaute)'],
    };
    const c = checks[symbology];
    if (c && !c[0].test(barcode)) throw bad(`Barcode „${barcode}“: ${c[1]}.`);
    if (symbology === 'EAN13' && barcode.length === 13 && eanCheckDigit(barcode.slice(0, 12)) !== barcode[12]) {
      throw bad(`Barcode „${barcode}“: EAN-13-Prüfziffer ist falsch.`);
    }
    if (symbology === 'EAN8' && barcode.length === 8 && eanCheckDigit(barcode.slice(0, 7)) !== barcode[7]) {
      throw bad(`Barcode „${barcode}“: EAN-8-Prüfziffer ist falsch.`);
    }
  }

  function eanCheckDigit(digits) {
    let sum = 0;
    const arr = digits.split('').map(Number).reverse();
    arr.forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
    return String((10 - (sum % 10)) % 10);
  }

  /** Barcode an Material hängen (keine parallele Barcodewelt: ein Barcode gehört genau zu einem Material) */
  function attachBarcode(materialNumber, barcode, symbology = 'CODE128', makePrimary = false) {
    barcode = str(barcode, 200);
    symbology = str(symbology, 20).toUpperCase() || 'CODE128';
    validateBarcode(barcode, symbology);
    const owner = barcodeOwner(barcode);
    if (owner && owner !== materialNumber) throw conflict(`Barcode ${barcode} ist bereits Material ${owner} zugeordnet.`);
    const hasPrimary = db.prepare('SELECT 1 FROM material_barcodes WHERE material_number = ? AND is_primary = 1').get(materialNumber);
    if (owner) {
      db.prepare('UPDATE material_barcodes SET symbology = ? WHERE barcode = ?').run(symbology, barcode);
    } else {
      db.prepare('INSERT INTO material_barcodes (barcode, material_number, symbology, is_primary) VALUES (?, ?, ?, 0)')
        .run(barcode, materialNumber, symbology);
    }
    if (makePrimary || !hasPrimary) {
      db.prepare('UPDATE material_barcodes SET is_primary = CASE WHEN barcode = ? THEN 1 ELSE 0 END WHERE material_number = ?')
        .run(barcode, materialNumber);
    }
  }

  /** Barcode für das Artikeletikett: vorhandener SAP-Barcode (primär), sonst die Materialnummer selbst */
  function labelBarcodeOf(materialNumber) {
    const b = db.prepare('SELECT barcode, symbology FROM material_barcodes WHERE material_number = ? ORDER BY is_primary DESC, barcode LIMIT 1').get(materialNumber);
    if (b) return { value: b.barcode, symbology: b.symbology, from_master: true };
    return { value: materialNumber, symbology: /^[\x20-\x7E]+$/.test(materialNumber) ? 'CODE128' : 'QR', from_master: false };
  }

  function materialDetail(nr) {
    const m = getMaterial(nr);
    return { ...m, barcodes: barcodesOf(m.material_number) };
  }

  function listMaterials(q, limit = 200) {
    q = str(q, 100);
    let rows;
    if (q) {
      const like = U.likePattern(q);
      rows = db.prepare(`
        SELECT m.* FROM materials m
        WHERE m.material_number LIKE ? ESCAPE '\\' OR m.description LIKE ? ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM material_barcodes b WHERE b.material_number = m.material_number AND b.barcode LIKE ? ESCAPE '\\')
        ORDER BY m.material_number LIMIT ?`).all(like, like, like, limit);
    } else {
      rows = db.prepare('SELECT * FROM materials ORDER BY material_number LIMIT ?').all(limit);
    }
    const total = db.prepare('SELECT COUNT(*) AS n FROM materials').get().n;
    return { total, rows: rows.map((m) => ({ ...m, barcodes: barcodesOf(m.material_number) })) };
  }

  function readWeight(v) {
    const w = U.toNum(v);
    if (w === null) return null;
    if (Number.isNaN(w) || w < 0) throw bad('Gewicht ist keine gültige Zahl (≥ 0).');
    return round3(w);
  }

  function createMaterial(user, body) {
    return mutate(() => {
      const nr = U.normMaterial(body.material_number);
      if (!nr) throw bad('Materialnummer ist ein Pflichtfeld.');
      if (findMaterial(nr)) throw conflict(`Material ${nr} existiert bereits.`);
      const description = str(body.description, 200);
      if (!description) throw bad('Materialbezeichnung ist ein Pflichtfeld.');
      const unit = U.normUnit(body.unit) || 'ST';
      const origin = body.origin === 'SAP' ? 'SAP' : 'LOKAL';
      db.prepare('INSERT INTO materials (material_number, description, unit, weight_kg, origin) VALUES (?, ?, ?, ?, ?)')
        .run(nr, description, unit, readWeight(body.weight_kg), origin);
      if (str(body.barcode)) attachBarcode(nr, body.barcode, body.symbology || 'CODE128', true);
      log(user, null, 'material', null, nr, 'Material angelegt', description);
      return materialDetail(nr);
    });
  }

  function updateMaterial(user, nr, body) {
    return mutate(() => {
      const m = getMaterial(nr);
      const description = body.description !== undefined ? str(body.description, 200) : m.description;
      if (!description) throw bad('Materialbezeichnung ist ein Pflichtfeld.');
      const unit = body.unit !== undefined ? (U.normUnit(body.unit) || m.unit) : m.unit;
      const weight = body.weight_kg !== undefined ? readWeight(body.weight_kg) : m.weight_kg;
      db.prepare('UPDATE materials SET description = ?, unit = ?, weight_kg = ? WHERE material_number = ?')
        .run(description, unit, weight, m.material_number);
      log(user, null, 'material', null, m.material_number, 'Material geändert');
      return materialDetail(m.material_number);
    });
  }

  function addBarcode(user, nr, body) {
    return mutate(() => {
      const m = getMaterial(nr);
      attachBarcode(m.material_number, body.barcode, body.symbology || 'CODE128', !!body.is_primary);
      log(user, null, 'material', null, m.material_number, 'Barcode zugeordnet', str(body.barcode, 200));
      return materialDetail(m.material_number);
    });
  }

  function removeBarcode(user, barcode) {
    return mutate(() => {
      const b = db.prepare('SELECT * FROM material_barcodes WHERE barcode = ?').get(str(barcode, 200));
      if (!b) throw notFound('Barcode nicht gefunden.');
      db.prepare('DELETE FROM material_barcodes WHERE barcode = ?').run(b.barcode);
      if (b.is_primary) {
        const next = db.prepare('SELECT barcode FROM material_barcodes WHERE material_number = ? ORDER BY barcode LIMIT 1').get(b.material_number);
        if (next) db.prepare('UPDATE material_barcodes SET is_primary = 1 WHERE barcode = ?').run(next.barcode);
      }
      log(user, null, 'material', null, b.material_number, 'Barcode entfernt', b.barcode);
      return materialDetail(b.material_number);
    });
  }

  function importMaterials(user, body) {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw bad('Die Importdatei enthält keine Zeilen.');
    if (rows.length > 50000) throw bad('Maximal 50.000 Zeilen pro Import.');
    const fmt = body.number_format === 'EN' ? 'EN' : 'DE';
    const results = [];
    const prepared = [];
    const barcodeInFile = new Map();
    rows.forEach((r, idx) => {
      const rowNo = Number(r.row_no) || idx + 1;
      const errors = [];
      const nr = U.normMaterial(r.material);
      if (!nr) errors.push('Materialnummer fehlt');
      const description = str(r.description, 200);
      const unit = U.normUnit(r.unit);
      const w = U.parseLocaleNumber(r.weight_kg, fmt);
      if (w !== null && (Number.isNaN(w) || w < 0)) errors.push(`Gewicht „${r.weight_kg}“ ungültig`);
      const barcode = str(r.barcode, 200);
      const symbology = str(r.symbology, 20).toUpperCase() || 'CODE128';
      if (barcode) {
        try { validateBarcode(barcode, symbology); } catch (e) { errors.push(e.message); }
        const owner = barcodeOwner(barcode);
        if (owner && nr && owner !== nr) errors.push(`Barcode ${barcode} gehört bereits zu Material ${owner}`);
        const inFile = barcodeInFile.get(barcode);
        if (inFile && nr && inFile !== nr) errors.push(`Barcode ${barcode} ist in der Datei auch Material ${inFile} zugeordnet`);
        if (nr) barcodeInFile.set(barcode, nr);
      }
      const existing = nr ? findMaterial(nr) : null;
      if (nr && !existing && !description && !prepared.some((p) => p.nr === nr && p.description)) errors.push('Neues Material ohne Bezeichnung');
      if (errors.length) { results.push({ row_no: rowNo, status: 'FEHLER', message: errors.join('; ') }); return; }
      prepared.push({ rowNo, nr, description, unit, weight: w, barcode, symbology, existing: !!existing });
      results.push({ row_no: rowNo, status: existing ? 'AKTUALISIERT' : 'NEU', message: nr });
    });
    const errors = results.filter((r) => r.status === 'FEHLER').length;
    const summary = { rows: rows.length, errors, new: results.filter((r) => r.status === 'NEU').length, updated: results.filter((r) => r.status === 'AKTUALISIERT').length };
    if (body.dry_run) return { summary, rows: results };
    if (errors && !body.skip_errors) throw bad('Der Import enthält fehlerhafte Zeilen.', { summary, rows: results });
    return mutate(() => {
      for (const p of prepared) {
        const m = findMaterial(p.nr);
        if (!m) {
          db.prepare('INSERT INTO materials (material_number, description, unit, weight_kg, origin) VALUES (?, ?, ?, ?, ?)')
            .run(p.nr, p.description, p.unit || 'ST', p.weight === null ? null : round3(p.weight), 'SAP');
        } else {
          db.prepare('UPDATE materials SET description = ?, unit = ?, weight_kg = ?, origin = ? WHERE material_number = ?')
            .run(p.description || m.description, p.unit || m.unit, p.weight === null ? m.weight_kg : round3(p.weight), 'SAP', m.material_number);
        }
        if (p.barcode) attachBarcode(p.nr, p.barcode, p.symbology, false);
      }
      log(user, null, 'material', null, '', 'Materialstamm importiert', `${prepared.length} Zeilen${body.file_name ? ' aus ' + str(body.file_name, 200) : ''}`);
      return { summary, rows: results };
    });
  }

  // ------------------------------------------------------------------ Scan-Auflösung
  function candidateCodes(raw) {
    const list = [raw];
    const rx = getSetting('barcode_regex');
    if (rx) {
      try {
        const m = new RegExp(rx).exec(raw);
        if (m) {
          const v = str(m[1] !== undefined ? m[1] : m[0], 200);
          if (v && !list.includes(v)) list.push(v);
        }
      } catch { /* ungültiges Muster wird beim Speichern verhindert */ }
    }
    return list;
  }

  function resolveMaterialCode(code) {
    const raw = str(code, 200);
    if (!raw) return null;
    const cands = candidateCodes(raw);
    for (const c of cands) {
      const owner = barcodeOwner(c);
      if (owner) return { material: getMaterial(owner), via: 'barcode', code: c };
    }
    for (const c of cands) {
      const m = findMaterial(c);
      if (m) return { material: m, via: 'material', code: c };
    }
    return null;
  }

  function findHuByCode(code) {
    const c = str(code, 200);
    if (!c) return null;
    return db.prepare('SELECT * FROM handling_units WHERE hu_number = ? OR package_number = ? OR UPPER(hu_number) = UPPER(?) OR UPPER(package_number) = UPPER(?)')
      .get(c, c, c, c) || null;
  }

  function resolveCode(code, projectId) {
    const raw = str(code, 200);
    if (!raw) throw bad('Kein Code übergeben.');
    const hu = findHuByCode(raw);
    if (hu) return { kind: 'hu', id: hu.id, project_id: hu.project_id, label: `Packstück ${hu.package_number} (${hu.hu_number})` };
    const d = db.prepare('SELECT * FROM deliveries WHERE number = ? OR UPPER(number) = UPPER(?)').get(raw, raw);
    if (d) return { kind: 'delivery', id: d.id, project_id: d.project_id, label: `Lieferung ${d.number}` };
    const mat = resolveMaterialCode(raw);
    if (mat) {
      return { kind: 'material', material_number: mat.material.material_number, description: mat.material.description, via: mat.via, label: `Material ${mat.material.material_number} – ${mat.material.description}` };
    }
    const pspArgs = projectId ? [raw, Number(projectId)] : [raw];
    const psp = db.prepare(`SELECT * FROM psp_elements WHERE code = ?${projectId ? ' AND project_id = ?' : ''} LIMIT 1`).get(...pspArgs);
    if (psp) return { kind: 'psp', id: psp.id, project_id: psp.project_id, code: psp.code, label: `PSP-Element ${psp.code}` };
    const project = db.prepare('SELECT * FROM projects WHERE number = ?').get(raw);
    if (project) return { kind: 'project', id: project.id, project_id: project.id, label: `Projekt ${project.number}` };
    return { kind: 'unknown', code: raw, label: `Unbekannter Code „${raw}“` };
  }

  // ------------------------------------------------------------------ Packvorrat-Positionen
  const ITEM_SELECT = `
    SELECT pi.*, ps.code AS psp_code, ps.description AS psp_description,
           pr.number AS project_number, pr.name AS project_name,
           COALESCE((SELECT SUM(c.qty) FROM hu_contents c WHERE c.pack_item_id = pi.id), 0) AS qty_packed
    FROM pack_items pi
    JOIN projects pr ON pr.id = pi.project_id
    LEFT JOIN psp_elements ps ON ps.id = pi.psp_id`;

  function placementsFor(itemIds) {
    const map = new Map();
    if (!itemIds.length) return map;
    const rows = db.prepare(`
      SELECT c.pack_item_id, c.qty, c.packed_at, c.packed_by, h.id AS hu_id, h.hu_number, h.package_number, h.packaging_type,
             h.pack_status, h.ship_status, h.parent_id, h.location, h.delivery_id,
             d.number AS delivery_number, d.kind AS delivery_kind, d.status AS delivery_status, d.truck_plate AS delivery_truck_plate,
             d.loaded_at AS delivery_loaded_at, d.delivered_at AS delivery_delivered_at
      FROM hu_contents c
      JOIN handling_units h ON h.id = c.hu_id
      LEFT JOIN deliveries d ON d.id = h.delivery_id
      WHERE c.pack_item_id IN (SELECT value FROM json_each(?))
      ORDER BY h.package_number`).all(JSON.stringify(itemIds));
    for (const r of rows) {
      r.status = huStatusKey(r);
      r.status_label = C.HU_STATUS[r.status];
      r.qty = round3(r.qty);
      if (!map.has(r.pack_item_id)) map.set(r.pack_item_id, []);
      map.get(r.pack_item_id).push(r);
    }
    return map;
  }

  function enrichItem(it, placements) {
    const packed = round3(it.qty_packed);
    const open = round3(Math.max(0, it.qty_required - packed));
    const missing = round3(Math.min(it.qty_missing, open));
    let status;
    if (missing > EPS) status = 'FEHLTEIL';
    else if (packed <= EPS) status = it.base_status;
    else if (open > EPS) status = 'VERPACKUNG_BEGONNEN';
    else {
      let min = 99;
      for (const p of placements) min = Math.min(min, C.HU_STATUS_RANK[p.status]);
      status = min <= 1 || min === 99 ? 'VERPACKUNG_BEGONNEN' : RANK_TO_HU_STATUS[min];
    }
    return {
      ...it,
      qty_required: round3(it.qty_required),
      qty_packed: packed,
      qty_open: open,
      qty_missing: round3(it.qty_missing),
      qty_missing_eff: missing,
      status,
      status_label: C.ITEM_STATUS[status],
      source_label: C.ITEM_SOURCES[it.source] || it.source,
      placements,
    };
  }

  function queryItems(where, params) {
    const rows = db.prepare(`${ITEM_SELECT} WHERE ${where} ORDER BY ps.code IS NULL, ps.code, pi.material_number, pi.id`).all(...params);
    const pl = placementsFor(rows.map((r) => r.id));
    return rows.map((r) => enrichItem(r, pl.get(r.id) || []));
  }

  function listItems(projectId) {
    return queryItems('pi.project_id = ?', [Number(projectId)]);
  }

  function getItem(id) {
    const r = queryItems('pi.id = ?', [Number(id)]);
    if (!r.length) throw notFound('Position nicht gefunden.');
    return r[0];
  }

  function checkQtyForUnit(qty, unit, label) {
    if (C.INTEGER_UNITS.includes(unit) && !isInt(qty)) throw bad(`${label} muss für die Einheit ${unit} ganzzahlig sein.`);
  }

  function createItem(user, projectId, body) {
    return mutate(() => {
      const p = getProject(projectId);
      const source = body.source === 'LIEFERANT' ? 'LIEFERANT' : 'MANUELL';
      const nr = U.normMaterial(body.material_number);
      if (!nr) throw bad('Materialnummer ist ein Pflichtfeld.');
      let m = findMaterial(nr);
      const description = str(body.description, 200);
      if (!m) {
        if (!description) throw bad(`Material ${nr} ist nicht im Materialstamm. Bitte Bezeichnung angeben, um es als lokales Material anzulegen.`);
        db.prepare('INSERT INTO materials (material_number, description, unit, weight_kg, origin) VALUES (?, ?, ?, ?, ?)')
          .run(nr, description, U.normUnit(body.unit) || 'ST', readWeight(body.weight_kg), 'LOKAL');
        log(user, p.id, 'material', null, nr, 'Material lokal angelegt', description);
        m = findMaterial(nr);
      }
      if (str(body.barcode)) attachBarcode(m.material_number, body.barcode, body.symbology || 'CODE128', false);
      const unit = U.normUnit(body.unit) || m.unit || 'ST';
      const qty = U.requirePositive(body.qty_required, 'Menge');
      checkQtyForUnit(qty, unit, 'Menge');
      const pspId = checkPspOfProject(body.psp_id, p.id);
      const supplier = str(body.supplier, 120);
      if (source === 'LIEFERANT' && !supplier) throw bad('Für Lieferantenmaterial ist der Lieferant ein Pflichtfeld.');
      const r = db.prepare(`INSERT INTO pack_items (project_id, psp_id, material_number, description, qty_required, unit, source, source_ref,
          supplier, purchase_order, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.id, pspId, m.material_number, description || m.description, qty, unit, source, str(body.source_ref, 120),
          supplier, str(body.purchase_order, 60), str(body.note, 500), U.now(), user || '');
      const id = Number(r.lastInsertRowid);
      log(user, p.id, 'item', id, m.material_number, source === 'LIEFERANT' ? 'Lieferantenmaterial ergänzt' : 'Position manuell ergänzt',
        `${fmtQty(qty)} ${unit}${supplier ? ' – Lieferant ' + supplier : ''}`);
      return getItem(id);
    });
  }

  function updateItem(user, id, body) {
    return mutate(() => {
      const it = getItem(id);
      const changes = [];
      let unit = it.unit;
      if (body.unit !== undefined && U.normUnit(body.unit) && U.normUnit(body.unit) !== it.unit) {
        if (it.qty_packed > EPS) throw bad('Die Einheit kann nicht geändert werden, da bereits verpackt wurde.');
        unit = U.normUnit(body.unit);
        changes.push(`Einheit ${it.unit} → ${unit}`);
      }
      let qty = it.qty_required;
      if (body.qty_required !== undefined) {
        qty = U.requirePositive(body.qty_required, 'Menge');
        if (qty + EPS < it.qty_packed) throw bad(`Die Sollmenge (${fmtQty(qty)}) darf nicht kleiner als die bereits verpackte Menge (${fmtQty(it.qty_packed)}) sein.`);
        if (qty !== it.qty_required) changes.push(`Menge ${fmtQty(it.qty_required)} → ${fmtQty(qty)}`);
      }
      checkQtyForUnit(qty, unit, 'Menge');
      const pspId = body.psp_id !== undefined ? checkPspOfProject(body.psp_id, it.project_id) : it.psp_id;
      if (pspId !== it.psp_id) changes.push('PSP-Element geändert');
      const description = body.description !== undefined ? (str(body.description, 200) || it.description) : it.description;
      const supplier = body.supplier !== undefined ? str(body.supplier, 120) : it.supplier;
      if (it.source === 'LIEFERANT' && !supplier) throw bad('Für Lieferantenmaterial ist der Lieferant ein Pflichtfeld.');
      const po = body.purchase_order !== undefined ? str(body.purchase_order, 60) : it.purchase_order;
      const note = body.note !== undefined ? str(body.note, 500) : it.note;
      const open = round3(Math.max(0, qty - it.qty_packed));
      const missing = round3(Math.min(it.qty_missing, open));
      db.prepare(`UPDATE pack_items SET qty_required = ?, unit = ?, psp_id = ?, description = ?, supplier = ?, purchase_order = ?, note = ?,
          qty_missing = ? WHERE id = ?`).run(qty, unit, pspId, description, supplier, po, note, missing, it.id);
      log(user, it.project_id, 'item', it.id, it.material_number, 'Position geändert', changes.join(', '));
      return getItem(it.id);
    });
  }

  function deleteItem(user, id) {
    return mutate(() => {
      const it = getItem(id);
      if (db.prepare('SELECT 1 FROM hu_contents WHERE pack_item_id = ?').get(it.id)) {
        throw bad('Die Position ist bereits (teilweise) verpackt und kann nicht gelöscht werden. Bitte zuerst aus den Packstücken entfernen.');
      }
      db.prepare('DELETE FROM pack_items WHERE id = ?').run(it.id);
      log(user, it.project_id, 'item', it.id, it.material_number, 'Position gelöscht', `${fmtQty(it.qty_required)} ${it.unit}`);
      return { ok: true };
    });
  }

  function setItemsBaseStatus(user, body) {
    const status = str(body.status, 30);
    if (!C.BASE_STATUS.includes(status)) throw bad('Ungültiger Status. Manuell setzbar sind: Angelegt, Material angefordert, Kommissioniert.');
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) throw bad('Keine Positionen ausgewählt.');
    return mutate(() => {
      for (const id of ids) {
        const it = getItem(id);
        if (it.base_status === status) continue;
        db.prepare('UPDATE pack_items SET base_status = ? WHERE id = ?').run(status, it.id);
        log(user, it.project_id, 'item', it.id, it.material_number, 'Status gesetzt', C.ITEM_STATUS[status]);
        sap.enqueue('MATERIAL_STATUS', { project: it.project_number, psp: it.psp_code || '', material: it.material_number, status }, user);
      }
      return { ok: true, count: ids.length };
    });
  }

  function reportMissing(user, id, body) {
    return mutate(() => {
      const it = getItem(id);
      const qty = U.requirePositive(body.qty_missing, 'Fehlmenge', { allowZero: true });
      if (qty > it.qty_open + EPS) throw bad(`Die Fehlmenge (${fmtQty(qty)}) ist größer als die offene Menge (${fmtQty(it.qty_open)}).`);
      checkQtyForUnit(qty, it.unit, 'Fehlmenge');
      const reason = str(body.reason, 300);
      const expected = str(body.expected, 10);
      if (expected && !/^\d{4}-\d{2}-\d{2}$/.test(expected)) throw bad('Voraussichtliches Datum ist ungültig.');
      db.prepare(`UPDATE pack_items SET qty_missing = ?, missing_reason = ?, missing_expected = ?, was_missing = CASE WHEN ? > 0 THEN 1 ELSE was_missing END
          WHERE id = ?`).run(qty, qty > 0 ? reason : '', qty > 0 ? expected : '', qty, it.id);
      log(user, it.project_id, 'item', it.id, it.material_number, qty > 0 ? 'Fehlteil gemeldet' : 'Fehlteil aufgehoben',
        qty > 0 ? `${fmtQty(qty)} ${it.unit}${reason ? ' – ' + reason : ''}${expected ? ' – erwartet ' + expected : ''}` : '');
      sap.enqueue('MATERIAL_SHORTAGE', {
        project: it.project_number, psp: it.psp_code || '', material: it.material_number, qty_missing: qty, unit: it.unit, reason, expected,
      }, user);
      return getItem(it.id);
    });
  }

  // ------------------------------------------------------------------ Import Packvorrat (Excel-Packliste, SAP-PSP-Export, Lieferantenliste)
  function importItems(user, projectId, body) {
    const project = getProject(projectId);
    const source = ['PSP', 'EXCEL', 'LIEFERANT'].includes(body.source) ? body.source : null;
    if (!source) throw bad('Ungültige Importquelle.');
    const listName = str(body.list_name, 80);
    if (!listName) throw bad('Bitte eine Listenbezeichnung angeben (für den späteren Abgleich bei erneutem Import).');
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw bad('Die Importdatei enthält keine Zeilen.');
    if (rows.length > 20000) throw bad('Maximal 20.000 Zeilen pro Import.');
    const fmt = body.number_format === 'EN' ? 'EN' : 'DE';

    const results = [];
    const groups = new Map();
    const barcodeInFile = new Map();
    rows.forEach((r, idx) => {
      const rowNo = Number(r.row_no) || idx + 1;
      const errors = [];
      const nr = U.normMaterial(r.material);
      if (!nr) errors.push('Materialnummer fehlt');
      const qty = U.parseLocaleNumber(r.qty, fmt);
      if (qty === null) errors.push('Menge fehlt');
      else if (Number.isNaN(qty)) errors.push(`Menge „${r.qty}“ ist im Zahlenformat ${fmt === 'DE' ? 'deutsch (1.234,5)' : 'englisch (1,234.5)'} ungültig`);
      else if (qty <= 0) errors.push('Menge muss größer 0 sein');
      const mat = nr ? findMaterial(nr) : null;
      const unit = U.normUnit(r.unit) || (mat ? mat.unit : '') || 'ST';
      if (qty > 0 && C.INTEGER_UNITS.includes(unit) && !isInt(qty)) errors.push(`Menge ${fmtQty(qty)} muss für Einheit ${unit} ganzzahlig sein`);
      const description = str(r.description, 200);
      if (nr && !mat && !description) errors.push(`Material ${nr} ist unbekannt und hat keine Bezeichnung`);
      const psp = str(r.psp, 60);
      if (source === 'PSP' && !psp) errors.push('PSP-Element fehlt');
      const supplier = str(r.supplier, 120);
      if (source === 'LIEFERANT' && !supplier) errors.push('Lieferant fehlt');
      const weight = U.parseLocaleNumber(r.weight_kg, fmt);
      if (weight !== null && (Number.isNaN(weight) || weight < 0)) errors.push(`Gewicht „${r.weight_kg}“ ungültig`);
      const barcode = str(r.barcode, 200);
      if (barcode && nr) {
        try { validateBarcode(barcode, 'CODE128'); } catch (e) { errors.push(e.message); }
        const owner = barcodeOwner(barcode);
        if (owner && owner !== nr) errors.push(`Barcode ${barcode} gehört bereits zu Material ${owner}`);
        const inFile = barcodeInFile.get(barcode);
        if (inFile && inFile !== nr) errors.push(`Barcode ${barcode} ist in der Datei auch Material ${inFile} zugeordnet`);
        barcodeInFile.set(barcode, nr);
      }
      const ref = str(r.ref, 80);
      if (errors.length) { results.push({ row_no: rowNo, status: 'FEHLER', message: errors.join('; ') }); return; }
      const key = JSON.stringify([psp, nr, ref]);
      let g = groups.get(key);
      if (!g) {
        g = { key, psp, psp_description: str(r.psp_description, 200), material: nr, material_known: !!mat, description, unit, qty: 0, rows: [],
          barcode, supplier, purchase_order: str(r.purchase_order, 60), note: str(r.note, 500), weight, ref };
        groups.set(key, g);
      } else if (g.unit !== unit) {
        results.push({ row_no: rowNo, status: 'FEHLER', message: `Einheit ${unit} weicht von Zeile ${g.rows[0]} (${g.unit}) ab` });
        return;
      }
      g.qty = round3(g.qty + qty);
      g.rows.push(rowNo);
      for (const f of ['description', 'barcode', 'supplier', 'purchase_order', 'note', 'psp_description']) if (!g[f]) g[f] = str(r[f], f === 'note' ? 500 : 200);
      if (g.weight === null && weight !== null) g.weight = weight;
      results.push({ row_no: rowNo, status: 'OK', key });
    });

    // Abgleich mit bestehenden Positionen derselben Liste
    const refOf = (g) => (g.ref ? `${listName} / ${g.ref}` : listName);
    for (const g of groups.values()) {
      const pspRow = g.psp ? db.prepare('SELECT id FROM psp_elements WHERE project_id = ? AND code = ?').get(project.id, g.psp) : null;
      let existing = null;
      if (!g.psp || pspRow) {
        existing = db.prepare(`SELECT pi.*, COALESCE((SELECT SUM(qty) FROM hu_contents c WHERE c.pack_item_id = pi.id), 0) AS qty_packed
            FROM pack_items pi WHERE pi.project_id = ? AND pi.source = ? AND pi.source_ref = ? AND pi.material_number = ? AND pi.psp_id IS ?
            ORDER BY pi.id LIMIT 1`).get(project.id, source, refOf(g), g.material, pspRow ? pspRow.id : null) || null;
      }
      g.existing = existing;
      if (!existing) { g.action = 'NEU'; g.message = `${fmtQty(g.qty)} ${g.unit}`; }
      else if (existing.unit !== g.unit) { g.action = 'FEHLER'; g.message = `Einheit ${g.unit} weicht von bestehender Position (${existing.unit}) ab`; }
      else if (Math.abs(existing.qty_required - g.qty) < EPS) { g.action = 'UNVERAENDERT'; g.message = `${fmtQty(g.qty)} ${g.unit}`; }
      else if (g.qty + EPS < existing.qty_packed) { g.action = 'FEHLER'; g.message = `Neue Menge ${fmtQty(g.qty)} ist kleiner als bereits verpackte Menge ${fmtQty(existing.qty_packed)}`; }
      else { g.action = 'AKTUALISIERT'; g.message = `${fmtQty(existing.qty_required)} → ${fmtQty(g.qty)} ${g.unit}`; }
    }
    for (const r of results) {
      if (r.status !== 'OK') continue;
      const g = groups.get(r.key);
      r.status = g.action;
      r.message = `${g.material}${g.psp ? ' / ' + g.psp : ''}: ${g.message}${g.rows.length > 1 ? ` (Zeilen ${g.rows.join(', ')} zusammengefasst)` : ''}`;
      delete r.key;
    }
    // Positionen dieser Liste, die in der Datei nicht mehr vorkommen (werden NICHT gelöscht, nur gemeldet)
    const fileKeys = new Set([...groups.values()].map((g) => JSON.stringify([refOf(g), g.material, g.psp])));
    const notInFile = db.prepare(`SELECT pi.id, pi.material_number, pi.source_ref, ps.code AS psp_code, pi.qty_required, pi.unit
        FROM pack_items pi LEFT JOIN psp_elements ps ON ps.id = pi.psp_id
        WHERE pi.project_id = ? AND pi.source = ? AND (pi.source_ref = ? OR pi.source_ref LIKE ? ESCAPE '\\')`)
      .all(project.id, source, listName, listName.replace(/[\\%_]/g, (c) => '\\' + c) + ' / %')
      .filter((x) => !fileKeys.has(JSON.stringify([x.source_ref, x.material_number, x.psp_code || ''])))
      .map((x) => ({ id: x.id, material_number: x.material_number, psp_code: x.psp_code || '', qty_required: round3(x.qty_required), unit: x.unit }));

    const count = (s) => results.filter((r) => r.status === s).length;
    const summary = {
      rows: rows.length, new: [...groups.values()].filter((g) => g.action === 'NEU').length,
      updated: [...groups.values()].filter((g) => g.action === 'AKTUALISIERT').length,
      unchanged: [...groups.values()].filter((g) => g.action === 'UNVERAENDERT').length,
      errors: count('FEHLER'), not_in_file: notInFile,
    };
    results.sort((a, b) => a.row_no - b.row_no);
    if (body.dry_run) return { summary, rows: results };
    if (summary.errors && !body.skip_errors) throw bad('Der Import enthält fehlerhafte Zeilen.', { summary, rows: results });

    return mutate(() => {
      for (const g of groups.values()) {
        if (g.action !== 'NEU' && g.action !== 'AKTUALISIERT') continue;
        const pspId = g.psp ? ensurePsp(project.id, g.psp, g.psp_description) : null;
        let m = findMaterial(g.material);
        if (!m) {
          db.prepare('INSERT INTO materials (material_number, description, unit, weight_kg, origin) VALUES (?, ?, ?, ?, ?)')
            .run(g.material, g.description, g.unit, g.weight === null ? null : round3(g.weight), source === 'PSP' ? 'SAP' : 'LOKAL');
          m = findMaterial(g.material);
        } else if (m.weight_kg === null && g.weight !== null && m.unit === g.unit) {
          db.prepare('UPDATE materials SET weight_kg = ? WHERE material_number = ?').run(round3(g.weight), m.material_number);
        }
        if (g.barcode) attachBarcode(m.material_number, g.barcode, 'CODE128', false);
        if (g.action === 'NEU') {
          db.prepare(`INSERT INTO pack_items (project_id, psp_id, material_number, description, qty_required, unit, source, source_ref,
              supplier, purchase_order, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(project.id, pspId, m.material_number, g.description || m.description, g.qty, g.unit, source, refOf(g),
              g.supplier, g.purchase_order, g.note, U.now(), user || '');
        } else {
          const open = round3(Math.max(0, g.qty - g.existing.qty_packed));
          db.prepare(`UPDATE pack_items SET qty_required = ?, qty_missing = MIN(qty_missing, ?),
              description = CASE WHEN ? <> '' THEN ? ELSE description END WHERE id = ?`)
            .run(g.qty, open, g.description, g.description, g.existing.id);
        }
      }
      log(user, project.id, 'project', project.id, project.number, 'Packvorrat importiert',
        `${C.ITEM_SOURCES[source]} „${listName}“${body.file_name ? ' (' + str(body.file_name, 200) + ')' : ''}: ${summary.new} neu, ${summary.updated} aktualisiert, ${summary.unchanged} unverändert${summary.errors ? ', ' + summary.errors + ' fehlerhafte Zeilen übersprungen' : ''}`);
      return { summary, rows: results };
    });
  }

  // ------------------------------------------------------------------ Handling Units
  function getHuRaw(id) {
    const h = db.prepare('SELECT * FROM handling_units WHERE id = ?').get(Number(id));
    if (!h) throw notFound('Packstück nicht gefunden.');
    return h;
  }

  function subtreeIds(id) {
    return db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT h.id FROM handling_units h JOIN t ON h.parent_id = t.id)
      SELECT id FROM t`).all(id).map((r) => r.id);
  }

  function ancestors(id) {
    const out = [];
    let h = getHuRaw(id);
    const seen = new Set([h.id]);
    while (h.parent_id) {
      h = getHuRaw(h.parent_id);
      if (seen.has(h.id)) break;
      seen.add(h.id);
      out.unshift(h);
    }
    return out;
  }

  /** Alle HUs eines Projekts inkl. berechneter Gewichte, Status, Zähler */
  function computeHus(projectId) {
    const hus = db.prepare(`
      SELECT h.*, ps.code AS psp_code, d.number AS delivery_number, d.kind AS delivery_kind, d.status AS delivery_status,
             d.truck_plate AS delivery_truck_plate, pr.number AS project_number,
             (SELECT COUNT(*) FROM hu_contents c WHERE c.hu_id = h.id) AS contents_count,
             (SELECT COUNT(*) FROM handling_units k WHERE k.parent_id = h.id) AS children_count,
             (SELECT COUNT(*) FROM photos f WHERE f.hu_id = h.id) AS photos_count
      FROM handling_units h
      JOIN projects pr ON pr.id = h.project_id
      LEFT JOIN psp_elements ps ON ps.id = h.psp_id
      LEFT JOIN deliveries d ON d.id = h.delivery_id
      WHERE h.project_id = ?
      ORDER BY h.package_number`).all(Number(projectId));
    const agg = new Map(db.prepare(`
      SELECT c.hu_id,
             SUM(CASE WHEN m.weight_kg IS NOT NULL AND pi.unit = m.unit THEN c.qty * m.weight_kg ELSE 0 END) AS net_calc,
             SUM(CASE WHEN m.weight_kg IS NULL OR pi.unit <> m.unit THEN 1 ELSE 0 END) AS unknown
      FROM hu_contents c
      JOIN pack_items pi ON pi.id = c.pack_item_id
      JOIN materials m ON m.material_number = pi.material_number
      JOIN handling_units h ON h.id = c.hu_id
      WHERE h.project_id = ?
      GROUP BY c.hu_id`).all(Number(projectId)).map((r) => [r.hu_id, r]));
    const byId = new Map(hus.map((h) => [h.id, h]));
    const children = new Map();
    for (const h of hus) {
      if (h.parent_id) {
        if (!children.has(h.parent_id)) children.set(h.parent_id, []);
        children.get(h.parent_id).push(h.id);
      }
    }
    const done = new Map();
    function calc(id, stack = new Set()) {
      if (done.has(id)) return done.get(id);
      if (stack.has(id)) return { gross: null, complete: false };
      stack.add(id);
      const h = byId.get(id);
      const a = agg.get(id);
      const netCalc = a ? round3(a.net_calc) : 0;
      const netCalcComplete = !a || a.unknown === 0;
      const netEff = h.net_kg !== null ? h.net_kg : netCalc;
      const netComplete = h.net_kg !== null || netCalcComplete;
      let childSum = 0;
      let childComplete = true;
      for (const cid of children.get(id) || []) {
        const c = calc(cid, stack);
        childSum += c.gross || 0;
        if (!c.complete) childComplete = false;
      }
      const grossCalc = round3((h.tare_kg || 0) + netEff + childSum);
      const gross = h.gross_kg !== null ? h.gross_kg : (grossCalc > 0 ? grossCalc : null);
      const complete = h.gross_kg !== null || (netComplete && h.tare_kg !== null && childComplete && gross !== null);
      const res = { net_calc: netCalc, net_calc_complete: netCalcComplete, net_eff: round3(netEff), gross, gross_calc: grossCalc, complete };
      done.set(id, res);
      stack.delete(id);
      return res;
    }
    const out = new Map();
    for (const h of hus) {
      const w = calc(h.id);
      const status = huStatusKey(h);
      const parent = h.parent_id ? byId.get(h.parent_id) : null;
      let top = h;
      const guard = new Set();
      while (top.parent_id && byId.get(top.parent_id) && !guard.has(top.id)) { guard.add(top.id); top = byId.get(top.parent_id); }
      const dims = h.length_cm && h.width_cm && h.height_cm;
      out.set(h.id, {
        ...h,
        status,
        status_label: C.HU_STATUS[status],
        pack_status_label: C.PACK_STATUS[h.pack_status],
        ship_status_label: C.SHIP_STATUS[h.ship_status],
        packaging_label: C.PACKAGING_TYPES[h.packaging_type] || h.packaging_type,
        delivery_kind_label: h.delivery_kind ? C.DELIVERY_KINDS[h.delivery_kind] : '',
        net_calc: w.net_calc,
        net_calc_complete: w.net_calc_complete,
        net_eff: w.net_eff,
        gross_eff: w.gross === null ? null : round3(w.gross),
        gross_calc: w.gross_calc,
        gross_source: h.gross_kg !== null ? 'GEWOGEN' : (w.gross !== null ? 'BERECHNET' : null),
        gross_complete: w.complete,
        dims_complete: !!dims,
        volume_m3: dims ? round3((h.length_cm * h.width_cm * h.height_cm) / 1e6) : null,
        parent_package_number: parent ? parent.package_number : null,
        parent_hu_number: parent ? parent.hu_number : null,
        top_id: top.id,
        top_package_number: top.package_number,
      });
    }
    return out;
  }

  function getHu(id) {
    const raw = getHuRaw(id);
    return computeHus(raw.project_id).get(raw.id);
  }

  function listHus(projectId) {
    getProject(projectId);
    return [...computeHus(projectId).values()];
  }

  function huContents(huId) {
    const rows = db.prepare(`
      SELECT c.*, pi.material_number, pi.description, pi.unit, pi.psp_id, ps.code AS psp_code, pi.source, pi.project_id
      FROM hu_contents c JOIN pack_items pi ON pi.id = c.pack_item_id LEFT JOIN psp_elements ps ON ps.id = pi.psp_id
      WHERE c.hu_id = ? ORDER BY pi.material_number`).all(huId);
    return rows.map((r) => ({ ...r, qty: round3(r.qty) }));
  }

  function photosOf(where, params) {
    return db.prepare(`SELECT f.*, h.package_number, h.hu_number, d.number AS delivery_number FROM photos f
        LEFT JOIN handling_units h ON h.id = f.hu_id LEFT JOIN deliveries d ON d.id = f.delivery_id
        WHERE ${where} ORDER BY f.taken_at DESC, f.id DESC`).all(...params)
      .map((f) => ({ ...f, phase_label: C.PHOTO_PHASES[f.phase], category_label: (C.PHOTO_CATEGORIES[f.phase] || {})[f.category] || f.category }));
  }

  function eventsOf(where, params, limit = 300) {
    return db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit);
  }

  function getHuDetail(id) {
    const hu = getHu(id);
    const all = computeHus(hu.project_id);
    const project = { ...getProject(hu.project_id), psp: listPsp(hu.project_id) };
    const contents = huContents(hu.id);
    const children = [...all.values()].filter((h) => h.parent_id === hu.id);
    const path = ancestors(hu.id).map((a) => all.get(a.id));
    const photos = photosOf('f.hu_id = ? OR (f.hu_id IS NULL AND f.delivery_id IS NOT NULL AND f.delivery_id = ?)', [hu.id, hu.delivery_id ?? -1]);
    const events = eventsOf("entity = 'hu' AND entity_id = ?", [hu.id]);
    const items = listItems(hu.project_id);
    const packable = items.filter((i) => i.qty_open > EPS).map((i) => ({
      id: i.id, material_number: i.material_number, description: i.description, psp_code: i.psp_code, qty_open: i.qty_open, unit: i.unit,
    }));
    const contentStatus = new Map(items.map((i) => [i.id, i]));
    for (const c of contents) {
      const it = contentStatus.get(c.pack_item_id);
      c.item_status_label = it ? it.status_label : '';
      c.qty_required = it ? it.qty_required : null;
    }
    return { hu, project, contents, children, path, photos, events, packable, delivery: hu.delivery_id ? getDeliveryRaw(hu.delivery_id) : null };
  }

  function nextHuNumber() {
    const prefix = str(getSetting('hu_prefix'), 10) || 'HU';
    let seq = Number(getSetting('hu_seq')) || 0;
    let nr;
    do {
      seq += 1;
      nr = `${prefix}${String(seq).padStart(8, '0')}`;
    } while (db.prepare('SELECT 1 FROM handling_units WHERE hu_number = ?').get(nr));
    setSetting('hu_seq', seq);
    return nr;
  }

  function nextPackageNumber(project) {
    let seq = project.hu_seq;
    let nr;
    do {
      seq += 1;
      nr = `${project.number}-${String(seq).padStart(3, '0')}`;
    } while (db.prepare('SELECT 1 FROM handling_units WHERE package_number = ?').get(nr));
    db.prepare('UPDATE projects SET hu_seq = ? WHERE id = ?').run(seq, project.id);
    return nr;
  }

  function readHuFields(body, current) {
    const f = {};
    const has = (k) => body[k] !== undefined;
    if (has('packaging_type') || !current) {
      const t = str(body.packaging_type, 20).toUpperCase();
      if (!C.PACKAGING_TYPES[t]) throw bad('Bitte eine gültige Verpackungsart wählen.');
      f.packaging_type = t;
    }
    if (has('description')) f.description = str(body.description, 200);
    for (const [k, label] of [['length_cm', 'Länge'], ['width_cm', 'Breite'], ['height_cm', 'Höhe'], ['gross_kg', 'Bruttogewicht']]) {
      if (has(k)) f[k] = U.requirePositive(body[k], label, { allowNull: true });
    }
    for (const [k, label] of [['tare_kg', 'Taragewicht'], ['net_kg', 'Nettogewicht']]) {
      if (has(k)) f[k] = U.requirePositive(body[k], label, { allowNull: true, allowZero: true });
    }
    if (has('location')) f.location = str(body.location, 100);
    if (has('destination')) f.destination = str(body.destination, 300);
    if (has('note')) f.note = str(body.note, 1000);
    // Eigenschaften für die Ladeplanung
    for (const k of ['stackable', 'rotatable', 'tiltable']) if (has(k)) f[k] = U.toBool(body[k]) ? 1 : 0;
    if (has('max_top_load_kg')) f.max_top_load_kg = U.requirePositive(body.max_top_load_kg, 'Maximale Auflast', { allowNull: true, allowZero: true });
    return f;
  }

  function huPayload(h) {
    const p = h.project_number ? h : { ...h, project_number: getProject(h.project_id).number };
    const psp = h.psp_id ? getPsp(h.psp_id).code : '';
    return { hu: h.hu_number, package_number: h.package_number, project: p.project_number, psp, packaging_type: h.packaging_type };
  }

  function createHu(user, projectId, body) {
    return mutate(() => {
      const p = getProject(projectId);
      const f = readHuFields(body, null);
      const pspId = checkPspOfProject(body.psp_id, p.id);
      const huNumber = nextHuNumber();
      const pkg = nextPackageNumber(p);
      const r = db.prepare(`INSERT INTO handling_units (hu_number, package_number, project_id, psp_id, packaging_type, description,
          length_cm, width_cm, height_cm, tare_kg, net_kg, gross_kg, location, destination, note, created_at, created_by,
          stackable, rotatable, tiltable, max_top_load_kg)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(huNumber, pkg, p.id, pspId, f.packaging_type, f.description || '', f.length_cm ?? null, f.width_cm ?? null, f.height_cm ?? null,
          f.tare_kg ?? null, f.net_kg ?? null, f.gross_kg ?? null, f.location || '', f.destination || p.destination || '', f.note || '',
          U.now(), user || '', f.stackable ?? (f.packaging_type === 'CONTAINER' ? 0 : 1), f.rotatable ?? 1, f.tiltable ?? 0, f.max_top_load_kg ?? null);
      const id = Number(r.lastInsertRowid);
      log(user, p.id, 'hu', id, pkg, 'Packstück angelegt', `${C.PACKAGING_TYPES[f.packaging_type]} ${huNumber}${f.description ? ' – ' + f.description : ''}`);
      sap.enqueue('HU_CREATED', { ...huPayload(getHuRaw(id)), description: f.description || '' }, user);
      if (body.parent_id) setParentInner(user, id, body.parent_id);
      return getHu(id);
    });
  }

  function updateHu(user, id, body) {
    return mutate(() => {
      const h = getHuRaw(id);
      const f = readHuFields(body, h);
      if (body.psp_id !== undefined) f.psp_id = checkPspOfProject(body.psp_id, h.project_id);
      const frozen = ['packaging_type', 'length_cm', 'width_cm', 'height_cm', 'tare_kg', 'net_kg', 'gross_kg', 'psp_id', 'destination'];
      const changed = Object.keys(f).filter((k) => f[k] !== h[k]);
      if (['VERLADEN', 'AUSGELIEFERT'].includes(h.ship_status) && changed.some((k) => frozen.includes(k))) {
        throw bad('Das Packstück ist bereits verladen. Maße, Gewichte, Art, PSP-Element und Zielort können nicht mehr geändert werden.');
      }
      if (f.packaging_type === 'CONTAINER' && h.parent_id) throw bad('Ein Container kann nicht in einem anderen Packstück liegen.');
      if (!changed.length) return getHu(h.id);
      const sets = changed.map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE handling_units SET ${sets} WHERE id = ?`).run(...changed.map((k) => f[k]), h.id);
      if (h.ship_status === 'VERSANDBEREIT') {
        const missing = shippingReadinessProblems(getHu(h.id));
        if (missing.length) throw bad(`Das Packstück ist versandbereit gemeldet. Die Änderung ist nicht möglich, da dann fehlen würde: ${missing.join(', ')}.`);
      }
      const labels = { packaging_type: 'Art', description: 'Bezeichnung', length_cm: 'Länge', width_cm: 'Breite', height_cm: 'Höhe', tare_kg: 'Tara',
        net_kg: 'Netto', gross_kg: 'Brutto', location: 'Lagerplatz', destination: 'Zielort', note: 'Bemerkung', psp_id: 'PSP-Element',
        stackable: 'Stapelbar', rotatable: 'Drehbar', tiltable: 'Kippbar', max_top_load_kg: 'Max. Auflast' };
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Packstückdaten geändert',
        changed.map((k) => `${labels[k]}: ${h[k] ?? '–'} → ${f[k] ?? '–'}`).join('; '));
      sap.enqueue('HU_UPDATED', { ...huPayload(getHuRaw(h.id)), length_cm: f.length_cm ?? h.length_cm, width_cm: f.width_cm ?? h.width_cm,
        height_cm: f.height_cm ?? h.height_cm, gross_kg: getHu(h.id).gross_eff, location: f.location ?? h.location }, user);
      return getHu(h.id);
    });
  }

  function deleteHu(user, id) {
    return mutate(() => {
      const h = getHuRaw(id);
      if (db.prepare('SELECT 1 FROM hu_contents WHERE hu_id = ?').get(h.id)) throw bad('Das Packstück ist nicht leer und kann nicht gelöscht werden.');
      if (db.prepare('SELECT 1 FROM handling_units WHERE parent_id = ?').get(h.id)) throw bad('Das Packstück enthält weitere Packstücke und kann nicht gelöscht werden.');
      if (db.prepare('SELECT 1 FROM photos WHERE hu_id = ?').get(h.id)) throw bad('Zum Packstück sind Bilder gespeichert – es kann nicht gelöscht werden.');
      if (h.ship_status !== 'OFFEN' || h.pack_status === 'ABGESCHLOSSEN') throw bad('Nur offene Packstücke können gelöscht werden.');
      if (h.parent_id && getHuRaw(h.parent_id).pack_status === 'ABGESCHLOSSEN') throw bad('Das übergeordnete Packstück ist abgeschlossen.');
      const parentId = h.parent_id;
      db.prepare('DELETE FROM handling_units WHERE id = ?').run(h.id);
      if (parentId) refreshPackStatus(user, parentId);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Packstück gelöscht', h.hu_number);
      sap.enqueue('HU_DELETED', huPayload(h), user);
      return { ok: true };
    });
  }

  function refreshPackStatus(user, huId) {
    const h = getHuRaw(huId);
    if (h.pack_status === 'ABGESCHLOSSEN') return;
    const nonEmpty = !!(db.prepare('SELECT 1 FROM hu_contents WHERE hu_id = ?').get(h.id) || db.prepare('SELECT 1 FROM handling_units WHERE parent_id = ?').get(h.id));
    const next = nonEmpty ? 'BEGONNEN' : 'ANGELEGT';
    if (next !== h.pack_status) {
      db.prepare('UPDATE handling_units SET pack_status = ? WHERE id = ?').run(next, h.id);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Status', C.PACK_STATUS[next]);
      sap.enqueue('HU_STATUS', { ...huPayload(h), pack_status: next, ship_status: h.ship_status }, user);
    }
  }

  function assertPackable(h) {
    if (h.pack_status === 'ABGESCHLOSSEN') throw bad(`Packstück ${h.package_number} ist abgeschlossen. Bitte zuerst wieder öffnen.`);
    if (h.ship_status !== 'OFFEN') throw bad(`Packstück ${h.package_number} ist bereits ${C.SHIP_STATUS[h.ship_status].toLowerCase()}.`);
  }

  /** Material in eine HU verpacken – per Scan-Code oder ausgewählter Position */
  function pack(user, huId, body) {
    return mutate(() => {
      const h = getHuRaw(huId);
      assertPackable(h);
      const project = getProject(h.project_id);
      let item;
      if (body.pack_item_id) {
        item = getItem(body.pack_item_id);
        if (item.project_id !== h.project_id) throw bad('Die Position gehört zu einem anderen Projekt als das Packstück.');
      } else {
        const code = str(body.code, 200);
        if (!code) throw bad('Bitte Material scannen oder Position auswählen.');
        const otherHu = findHuByCode(code);
        if (otherHu) throw bad(`Gescannt wurde das Packstück ${otherHu.package_number}. Zum Verschachteln bitte „Packstück hinzufügen“ verwenden.`);
        const res = resolveMaterialCode(code);
        if (!res) throw notFound(`Der Code „${code}“ ist keinem Material zugeordnet.`);
        const nr = res.material.material_number;
        const cands = listItemsOfMaterial(h.project_id, nr);
        if (!cands.length) throw bad(`Material ${nr} (${res.material.description}) ist nicht im Packvorrat von Projekt ${project.number}.`, { material_number: nr, reason: 'NOT_IN_STOCK' });
        const open = cands.filter((c) => c.qty_open > EPS);
        if (!open.length) throw bad(`Material ${nr} ist im Projekt bereits vollständig verpackt.`, { material_number: nr, reason: 'COMPLETE' });
        if (open.length === 1) item = open[0];
        else {
          const samePsp = h.psp_id ? open.filter((c) => c.psp_id === h.psp_id) : [];
          if (samePsp.length === 1) item = samePsp[0];
          else {
            throw conflict(`Material ${nr} ist mehrfach im Packvorrat offen. Bitte Position auswählen.`, {
              reason: 'CHOOSE_ITEM',
              candidates: open.map((c) => ({ id: c.id, material_number: c.material_number, description: c.description, psp_code: c.psp_code, qty_open: c.qty_open, unit: c.unit, source_label: c.source_label })),
            });
          }
        }
      }
      const qty = U.requirePositive(body.qty === undefined ? 1 : body.qty, 'Menge');
      checkQtyForUnit(qty, item.unit, 'Menge');
      if (qty > item.qty_open + EPS) {
        throw bad(`Menge ${fmtQty(qty)} ${item.unit} übersteigt die offene Menge von ${fmtQty(item.qty_open)} ${item.unit} (Material ${item.material_number}).`);
      }
      db.prepare(`INSERT INTO hu_contents (hu_id, pack_item_id, qty, packed_at, packed_by) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(hu_id, pack_item_id) DO UPDATE SET qty = round(qty + excluded.qty, 3), packed_at = excluded.packed_at, packed_by = excluded.packed_by`)
        .run(h.id, item.id, qty, U.now(), user || '');
      const openAfter = round3(item.qty_open - qty);
      if (item.qty_missing > openAfter + EPS) db.prepare('UPDATE pack_items SET qty_missing = ? WHERE id = ?').run(Math.max(0, openAfter), item.id);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Material verpackt',
        `${fmtQty(qty)} ${item.unit} ${item.material_number} ${item.description}${item.psp_code ? ' (PSP ' + item.psp_code + ')' : ''}`);
      sap.enqueue('HU_ITEM_PACKED', { ...huPayload(h), material: item.material_number, qty, unit: item.unit, item_psp: item.psp_code || '' }, user);
      refreshPackStatus(user, h.id);
      const after = getItem(item.id);
      return { hu: getHu(h.id), item: after, packed_qty: qty };
    });
  }

  function listItemsOfMaterial(projectId, nr) {
    return queryItems('pi.project_id = ? AND pi.material_number = ?', [projectId, nr]);
  }

  function unpack(user, huId, body) {
    return mutate(() => {
      const h = getHuRaw(huId);
      assertPackable(h);
      const itemId = Number(body.pack_item_id);
      const c = db.prepare('SELECT * FROM hu_contents WHERE hu_id = ? AND pack_item_id = ?').get(h.id, itemId);
      if (!c) throw notFound('Diese Position ist nicht im Packstück enthalten.');
      const item = getItem(itemId);
      const qty = body.qty === undefined || body.qty === null ? round3(c.qty) : U.requirePositive(body.qty, 'Menge');
      checkQtyForUnit(qty, item.unit, 'Menge');
      if (qty > c.qty + EPS) throw bad(`Es sind nur ${fmtQty(c.qty)} ${item.unit} im Packstück enthalten.`);
      if (Math.abs(c.qty - qty) < EPS) db.prepare('DELETE FROM hu_contents WHERE id = ?').run(c.id);
      else db.prepare('UPDATE hu_contents SET qty = round(qty - ?, 3) WHERE id = ?').run(qty, c.id);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Material entnommen', `${fmtQty(qty)} ${item.unit} ${item.material_number} ${item.description}`);
      sap.enqueue('HU_ITEM_UNPACKED', { ...huPayload(h), material: item.material_number, qty, unit: item.unit, item_psp: item.psp_code || '' }, user);
      refreshPackStatus(user, h.id);
      return { hu: getHu(h.id), item: getItem(item.id) };
    });
  }

  function setShipSubtree(rootId, status, deliveryId) {
    const ids = subtreeIds(rootId);
    db.prepare('UPDATE handling_units SET ship_status = ?, delivery_id = ? WHERE id IN (SELECT value FROM json_each(?))')
      .run(status, deliveryId, JSON.stringify(ids));
    return ids;
  }

  /** Mehrstufige Verpackung: HU in übergeordnete HU legen bzw. herausnehmen */
  function setParentInner(user, huId, parentId) {
    const h = getHuRaw(huId);
    if (!['OFFEN', 'VERSANDBEREIT'].includes(h.ship_status)) throw bad(`Packstück ${h.package_number} ist bereits verladen.`);
    if (h.parent_id) {
      const old = getHuRaw(h.parent_id);
      if (old.pack_status === 'ABGESCHLOSSEN') throw bad(`Das übergeordnete Packstück ${old.package_number} ist abgeschlossen. Bitte zuerst wieder öffnen.`);
    }
    if (parentId) {
      const parent = getHuRaw(parentId);
      if (parent.id === h.id) throw bad('Ein Packstück kann nicht in sich selbst verpackt werden.');
      if (parent.project_id !== h.project_id) throw bad('Packstücke verschiedener Projekte können nicht ineinander verpackt werden.');
      if (h.packaging_type === 'CONTAINER') throw bad('Ein Container kann nicht in ein anderes Packstück verpackt werden.');
      if (subtreeIds(h.id).includes(parent.id)) throw bad(`Packstück ${parent.package_number} liegt bereits in ${h.package_number} – das ergäbe einen Kreis.`);
      assertPackable(parent);
      if (h.parent_id === parent.id) return;
      const oldParent = h.parent_id;
      db.prepare('UPDATE handling_units SET parent_id = ? WHERE id = ?').run(parent.id, h.id);
      if (h.ship_status !== 'OFFEN') setShipSubtree(h.id, 'OFFEN', null);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'In Packstück verpackt', `${parent.package_number} (${C.PACKAGING_TYPES[parent.packaging_type]})`);
      log(user, h.project_id, 'hu', parent.id, parent.package_number, 'Packstück aufgenommen', `${h.package_number} (${C.PACKAGING_TYPES[h.packaging_type]})`);
      sap.enqueue('HU_NESTED', { ...huPayload(h), parent_hu: parent.hu_number }, user);
      refreshPackStatus(user, parent.id);
      if (oldParent) refreshPackStatus(user, oldParent);
    } else {
      if (!h.parent_id) return;
      const old = getHuRaw(h.parent_id);
      db.prepare('UPDATE handling_units SET parent_id = NULL WHERE id = ?').run(h.id);
      log(user, h.project_id, 'hu', h.id, h.package_number, 'Aus Packstück entnommen', old.package_number);
      log(user, h.project_id, 'hu', old.id, old.package_number, 'Packstück entnommen', h.package_number);
      sap.enqueue('HU_UNNESTED', { ...huPayload(h), parent_hu: old.hu_number }, user);
      refreshPackStatus(user, old.id);
    }
  }

  function setParent(user, huId, body) {
    return mutate(() => {
      let parentId = body.parent_id ? Number(body.parent_id) : null;
      if (!parentId && str(body.parent_code)) {
        const p = findHuByCode(body.parent_code);
        if (!p) throw notFound(`Kein Packstück mit Code „${str(body.parent_code, 200)}“ gefunden.`);
        parentId = p.id;
      }
      setParentInner(user, huId, parentId);
      return getHu(huId);
    });
  }

  /** Kind-HU per Scan in diese HU aufnehmen */
  function addChild(user, parentId, body) {
    return mutate(() => {
      let child;
      if (body.child_id) child = getHuRaw(body.child_id);
      else {
        child = findHuByCode(body.code);
        if (!child) throw notFound(`Kein Packstück mit Code „${str(body.code, 200)}“ gefunden.`);
      }
      setParentInner(user, child.id, parentId);
      return getHu(parentId);
    });
  }

  function shippingReadinessProblems(hu) {
    const missing = [];
    if (!hu.dims_complete) missing.push('Abmessungen (L × B × H)');
    if (hu.gross_eff === null || hu.gross_eff <= 0) missing.push('Bruttogewicht');
    else if (!hu.gross_complete) missing.push('vollständiges Bruttogewicht (gewogenes Brutto eintragen oder Tara und alle Materialgewichte pflegen)');
    return missing;
  }

  function huAction(user, id, body) {
    const action = str(body.action, 20);
    return mutate(() => {
      const h = getHuRaw(id);
      const payload = () => huPayload(h);
      const done = (label, pack, ship) => {
        log(user, h.project_id, 'hu', h.id, h.package_number, 'Status', label);
        sap.enqueue('HU_STATUS', { ...payload(), pack_status: pack, ship_status: ship }, user);
      };
      switch (action) {
        case 'close': {
          if (h.pack_status === 'ABGESCHLOSSEN') throw bad('Das Packstück ist bereits abgeschlossen.');
          if (h.pack_status !== 'BEGONNEN') throw bad('Das Packstück ist leer und kann nicht abgeschlossen werden.');
          const openChild = db.prepare("SELECT package_number FROM handling_units WHERE parent_id = ? AND pack_status <> 'ABGESCHLOSSEN'").get(h.id);
          if (openChild) throw bad(`Das enthaltene Packstück ${openChild.package_number} ist noch nicht abgeschlossen.`);
          db.prepare("UPDATE handling_units SET pack_status = 'ABGESCHLOSSEN', closed_at = ? WHERE id = ?").run(U.now(), h.id);
          done(C.HU_STATUS.VERPACKUNG_ABGESCHLOSSEN, 'ABGESCHLOSSEN', h.ship_status);
          break;
        }
        case 'reopen': {
          if (h.pack_status !== 'ABGESCHLOSSEN') throw bad('Das Packstück ist nicht abgeschlossen.');
          if (!['OFFEN', 'VERSANDBEREIT'].includes(h.ship_status)) throw bad('Das Packstück ist bereits verladen und kann nicht mehr geöffnet werden.');
          if (h.parent_id) {
            const p = getHuRaw(h.parent_id);
            if (p.pack_status === 'ABGESCHLOSSEN') throw bad(`Das Packstück liegt im abgeschlossenen Packstück ${p.package_number}. Bitte zuerst dieses öffnen.`);
          }
          if (h.ship_status !== 'OFFEN') setShipSubtree(h.id, 'OFFEN', null);
          db.prepare("UPDATE handling_units SET pack_status = 'BEGONNEN', closed_at = NULL WHERE id = ?").run(h.id);
          refreshPackStatus(user, h.id);
          done('Wieder geöffnet', 'BEGONNEN', 'OFFEN');
          break;
        }
        case 'ready': {
          if (h.parent_id) throw bad(`Das Packstück liegt in ${getHuRaw(h.parent_id).package_number}. Versandbereit gemeldet wird das äußerste Packstück.`);
          if (h.pack_status !== 'ABGESCHLOSSEN') throw bad('Bitte zuerst die Verpackung abschließen.');
          if (h.ship_status !== 'OFFEN') throw bad(`Das Packstück ist bereits ${C.SHIP_STATUS[h.ship_status].toLowerCase()}.`);
          const problems = shippingReadinessProblems(getHu(h.id));
          if (problems.length) throw bad(`Für die Versandbereitschaft fehlen: ${problems.join(', ')}.`);
          setShipSubtree(h.id, 'VERSANDBEREIT', null);
          done(C.HU_STATUS.VERSANDBEREIT, 'ABGESCHLOSSEN', 'VERSANDBEREIT');
          break;
        }
        case 'unready': {
          if (h.ship_status !== 'VERSANDBEREIT') throw bad('Das Packstück ist nicht als versandbereit gemeldet.');
          if (h.parent_id) throw bad('Bitte das äußerste Packstück bearbeiten.');
          setShipSubtree(h.id, 'OFFEN', null);
          done('Versandbereitschaft zurückgenommen', 'ABGESCHLOSSEN', 'OFFEN');
          break;
        }
        default:
          throw bad('Unbekannte Aktion.');
      }
      return getHu(h.id);
    });
  }

  // ------------------------------------------------------------------ Lieferungen / Verladung
  function getDeliveryRaw(id) {
    const d = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(Number(id));
    if (!d) throw notFound('Lieferung nicht gefunden.');
    return d;
  }

  function enrichDelivery(d, hus) {
    const own = hus.filter((h) => h.delivery_id === d.id);
    const top = own.filter((h) => !h.parent_id || !own.some((o) => o.id === h.parent_id));
    return {
      ...d,
      kind_label: C.DELIVERY_KINDS[d.kind],
      status_label: C.DELIVERY_STATUS[d.status],
      hu_count: top.length,
      hu_total: own.length,
      gross_total: round3(top.reduce((s, h) => s + (h.gross_eff || 0), 0)),
      photos_count: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE delivery_id = ?').get(d.id).n,
    };
  }

  function listDeliveries(projectId) {
    getProject(projectId);
    const hus = [...computeHus(projectId).values()];
    return db.prepare('SELECT * FROM deliveries WHERE project_id = ? ORDER BY created_at, id').all(Number(projectId)).map((d) => enrichDelivery(d, hus));
  }

  function getDelivery(id) {
    const d = getDeliveryRaw(id);
    return enrichDelivery(d, [...computeHus(d.project_id).values()]);
  }

  function getDeliveryDetail(id) {
    const d = getDeliveryRaw(id);
    const all = computeHus(d.project_id);
    const hus = [...all.values()];
    const delivery = enrichDelivery(d, hus);
    const loaded = hus.filter((h) => h.delivery_id === d.id);
    const top = loaded.filter((h) => !h.parent_id);
    const ready = hus.filter((h) => !h.parent_id && h.ship_status === 'VERSANDBEREIT' && !h.delivery_id);
    const notReady = hus.filter((h) => !h.parent_id && h.ship_status === 'OFFEN');
    const packingList = loaded.map((h) => ({ hu: h, contents: huContents(h.id) }));
    return {
      delivery,
      project: getProject(d.project_id),
      hus: top,
      ready,
      not_ready_count: notReady.length,
      packing_list: packingList,
      photos: photosOf('f.delivery_id = ?', [d.id]),
      events: eventsOf("entity = 'delivery' AND entity_id = ?", [d.id]),
    };
  }

  function nextDeliveryNumber() {
    const prefix = str(getSetting('delivery_prefix'), 10) || 'L';
    const year = new Date().getFullYear();
    let seq = Number(getSetting('delivery_seq')) || 0;
    let nr;
    do {
      seq += 1;
      nr = `${prefix}${year}${String(seq).padStart(5, '0')}`;
    } while (db.prepare('SELECT 1 FROM deliveries WHERE number = ?').get(nr));
    setSetting('delivery_seq', seq);
    return nr;
  }

  function readDeliveryFields(body) {
    const f = {};
    for (const [k, max] of [['destination', 300], ['carrier', 120], ['truck_plate', 40], ['trailer_plate', 40], ['driver', 120], ['note', 1000]]) {
      if (body[k] !== undefined) f[k] = str(body[k], max);
    }
    if (body.planned_date !== undefined) {
      const v = str(body.planned_date, 10);
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('Geplantes Datum ist ungültig.');
      f.planned_date = v;
    }
    if (body.kind !== undefined) {
      if (!C.DELIVERY_KINDS[body.kind]) throw bad('Ungültige Lieferart.');
      f.kind = body.kind;
    }
    return f;
  }

  function createDelivery(user, projectId, body) {
    return mutate(() => {
      const p = getProject(projectId);
      const f = readDeliveryFields(body);
      let number = str(body.number, 40);
      if (number) {
        if (db.prepare('SELECT 1 FROM deliveries WHERE number = ?').get(number)) throw conflict(`Lieferung ${number} existiert bereits.`);
      } else number = nextDeliveryNumber();
      const shippedBefore = db.prepare("SELECT 1 FROM deliveries WHERE project_id = ? AND status IN ('VERLADEN','AUSGELIEFERT')").get(p.id);
      const kind = f.kind || (shippedBefore ? 'NACHLIEFERUNG' : 'HAUPT');
      const r = db.prepare(`INSERT INTO deliveries (project_id, number, kind, destination, carrier, truck_plate, trailer_plate, driver, planned_date, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.id, number, kind, f.destination || p.destination || '', f.carrier || '', f.truck_plate || '', f.trailer_plate || '', f.driver || '',
          f.planned_date || '', f.note || '', U.now());
      const id = Number(r.lastInsertRowid);
      log(user, p.id, 'delivery', id, number, 'Lieferung angelegt', C.DELIVERY_KINDS[kind]);
      return getDelivery(id);
    });
  }

  function updateDelivery(user, id, body) {
    return mutate(() => {
      const d = getDeliveryRaw(id);
      const f = readDeliveryFields(body);
      if (body.number !== undefined) {
        const number = str(body.number, 40);
        if (!number) throw bad('Lieferungsnummer darf nicht leer sein.');
        if (number !== d.number) {
          if (['VERLADEN', 'AUSGELIEFERT'].includes(d.status)) throw bad('Die Lieferungsnummer kann nach dem Warenausgang nicht mehr geändert werden.');
          if (db.prepare('SELECT 1 FROM deliveries WHERE number = ? AND id <> ?').get(number, d.id)) throw conflict(`Lieferung ${number} existiert bereits.`);
          f.number = number;
        }
      }
      if (f.kind && f.kind !== d.kind && ['VERLADEN', 'AUSGELIEFERT'].includes(d.status)) throw bad('Die Lieferart kann nach dem Warenausgang nicht mehr geändert werden.');
      if (d.status === 'AUSGELIEFERT') {
        const allowed = ['note'];
        if (Object.keys(f).some((k) => !allowed.includes(k) && f[k] !== d[k])) throw bad('Die Lieferung ist ausgeliefert – nur die Bemerkung kann noch geändert werden.');
      }
      const changed = Object.keys(f).filter((k) => f[k] !== d[k]);
      if (!changed.length) return getDelivery(d.id);
      db.prepare(`UPDATE deliveries SET ${changed.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...changed.map((k) => f[k]), d.id);
      log(user, d.project_id, 'delivery', d.id, f.number || d.number, 'Lieferdaten geändert', changed.map((k) => `${k}: ${d[k] || '–'} → ${f[k] || '–'}`).join('; '));
      return getDelivery(d.id);
    });
  }

  function deleteDelivery(user, id) {
    return mutate(() => {
      const d = getDeliveryRaw(id);
      if (d.status !== 'GEPLANT' || db.prepare('SELECT 1 FROM handling_units WHERE delivery_id = ?').get(d.id)) {
        throw bad('Nur geplante Lieferungen ohne verladene Packstücke können gelöscht werden.');
      }
      if (db.prepare('SELECT 1 FROM photos WHERE delivery_id = ?').get(d.id)) throw bad('Zur Lieferung sind Bilder gespeichert – sie kann nicht gelöscht werden.');
      db.prepare('DELETE FROM deliveries WHERE id = ?').run(d.id);
      log(user, d.project_id, 'delivery', d.id, d.number, 'Lieferung gelöscht');
      return { ok: true };
    });
  }

  function loadHu(user, deliveryId, body) {
    return mutate(() => {
      const d = getDeliveryRaw(deliveryId);
      if (!['GEPLANT', 'IN_VERLADUNG'].includes(d.status)) throw bad(`Lieferung ${d.number} ist bereits ${C.DELIVERY_STATUS[d.status].toLowerCase()}.`);
      let h;
      if (body.hu_id) h = getHuRaw(body.hu_id);
      else {
        h = findHuByCode(body.code);
        if (!h) throw notFound(`Kein Packstück mit Code „${str(body.code, 200)}“ gefunden.`);
      }
      if (h.project_id !== d.project_id) throw bad(`Packstück ${h.package_number} gehört zu einem anderen Projekt.`);
      if (h.parent_id) {
        const top = ancestors(h.id)[0];
        throw bad(`Packstück ${h.package_number} ist in ${top.package_number} verpackt. Bitte ${top.package_number} verladen.`);
      }
      if (h.ship_status === 'VERLADEN' || h.ship_status === 'AUSGELIEFERT') {
        const other = h.delivery_id ? getDeliveryRaw(h.delivery_id) : null;
        if (other && other.id === d.id) throw bad(`Packstück ${h.package_number} ist bereits auf dieser Lieferung verladen.`);
        throw bad(`Packstück ${h.package_number} ist bereits${other ? ' auf Lieferung ' + other.number : ''} verladen.`);
      }
      if (h.ship_status !== 'VERSANDBEREIT') throw bad(`Packstück ${h.package_number} ist noch nicht versandbereit (Status: ${C.HU_STATUS[huStatusKey(h)]}).`);
      const ids = setShipSubtree(h.id, 'VERLADEN', d.id);
      if (d.status === 'GEPLANT') db.prepare("UPDATE deliveries SET status = 'IN_VERLADUNG' WHERE id = ?").run(d.id);
      log(user, d.project_id, 'delivery', d.id, d.number, 'Packstück verladen', `${h.package_number} (${h.hu_number})${ids.length > 1 ? ` inkl. ${ids.length - 1} enthaltener Packstücke` : ''}`);
      log(user, d.project_id, 'hu', h.id, h.package_number, 'Verladen', `Lieferung ${d.number}${d.truck_plate ? ', Kennzeichen ' + d.truck_plate : ''}`);
      sap.enqueue('HU_LOADED', { ...huPayload(h), delivery: d.number }, user);
      return { delivery: getDelivery(d.id), hu: getHu(h.id) };
    });
  }

  function unloadHu(user, deliveryId, body) {
    return mutate(() => {
      const d = getDeliveryRaw(deliveryId);
      if (!['GEPLANT', 'IN_VERLADUNG'].includes(d.status)) throw bad('Die Verladung ist abgeschlossen. Bitte zuerst den Warenausgang stornieren.');
      const h = getHuRaw(body.hu_id);
      if (h.delivery_id !== d.id || h.parent_id) throw bad('Das Packstück ist nicht direkt auf dieser Lieferung verladen.');
      setShipSubtree(h.id, 'VERSANDBEREIT', null);
      if (!db.prepare('SELECT 1 FROM handling_units WHERE delivery_id = ?').get(d.id)) db.prepare("UPDATE deliveries SET status = 'GEPLANT' WHERE id = ?").run(d.id);
      log(user, d.project_id, 'delivery', d.id, d.number, 'Packstück entladen', h.package_number);
      log(user, d.project_id, 'hu', h.id, h.package_number, 'Von Lieferung entladen', d.number);
      sap.enqueue('HU_UNLOADED', { ...huPayload(h), delivery: d.number }, user);
      return { delivery: getDelivery(d.id), hu: getHu(h.id) };
    });
  }

  function deliveryHuSummary(d) {
    return db.prepare('SELECT hu_number, package_number FROM handling_units WHERE delivery_id = ? ORDER BY package_number').all(d.id);
  }

  function deliveryAction(user, id, body) {
    const action = str(body.action, 20);
    return mutate(() => {
      const d = getDeliveryRaw(id);
      const tops = db.prepare('SELECT id FROM handling_units WHERE delivery_id = ? AND parent_id IS NULL').all(d.id);
      switch (action) {
        case 'complete': {
          if (d.status !== 'IN_VERLADUNG') throw bad('Es sind noch keine Packstücke verladen.');
          if (!tops.length) throw bad('Es sind noch keine Packstücke verladen.');
          if (!d.truck_plate) throw bad('Bitte zuerst das Kennzeichen (LKW / Container-Nr.) erfassen.');
          db.prepare("UPDATE deliveries SET status = 'VERLADEN', loaded_at = ? WHERE id = ?").run(U.now(), d.id);
          log(user, d.project_id, 'delivery', d.id, d.number, 'Verladung abgeschlossen / Warenausgang', `${tops.length} Packstücke, Kennzeichen ${d.truck_plate}`);
          const hus = deliveryHuSummary(d);
          for (const t of tops) {
            const h = getHuRaw(t.id);
            log(user, d.project_id, 'hu', h.id, h.package_number, 'Warenausgang gebucht', `Lieferung ${d.number}, ${d.truck_plate}`);
          }
          sap.enqueue('DELIVERY_GOODS_ISSUE', {
            delivery: d.number, kind: d.kind, project: getProject(d.project_id).number, truck_plate: d.truck_plate, trailer_plate: d.trailer_plate,
            carrier: d.carrier, hus,
          }, user);
          break;
        }
        case 'reopen': {
          if (d.status !== 'VERLADEN') throw bad('Nur verladene (noch nicht ausgelieferte) Lieferungen können storniert werden.');
          db.prepare("UPDATE deliveries SET status = 'IN_VERLADUNG', loaded_at = NULL WHERE id = ?").run(d.id);
          log(user, d.project_id, 'delivery', d.id, d.number, 'Warenausgang storniert', 'Verladung wieder geöffnet');
          sap.enqueue('DELIVERY_GOODS_ISSUE_REVERSAL', { delivery: d.number, project: getProject(d.project_id).number }, user);
          break;
        }
        case 'delivered': {
          if (d.status !== 'VERLADEN') throw bad('Bitte zuerst die Verladung abschließen.');
          const at = str(body.delivered_at, 30);
          let ts = U.now();
          if (at) {
            const dt = new Date(at);
            if (Number.isNaN(dt.getTime())) throw bad('Zustelldatum ist ungültig.');
            ts = dt.toISOString();
          }
          db.prepare("UPDATE deliveries SET status = 'AUSGELIEFERT', delivered_at = ? WHERE id = ?").run(ts, d.id);
          db.prepare("UPDATE handling_units SET ship_status = 'AUSGELIEFERT' WHERE delivery_id = ?").run(d.id);
          log(user, d.project_id, 'delivery', d.id, d.number, 'Zustellung bestätigt', str(body.note, 300));
          for (const t of tops) {
            const h = getHuRaw(t.id);
            log(user, d.project_id, 'hu', h.id, h.package_number, 'Ausgeliefert', `Lieferung ${d.number}`);
          }
          sap.enqueue('DELIVERY_DELIVERED', { delivery: d.number, project: getProject(d.project_id).number, delivered_at: ts, hus: deliveryHuSummary(d) }, user);
          break;
        }
        default:
          throw bad('Unbekannte Aktion.');
      }
      return getDelivery(d.id);
    });
  }

  // ------------------------------------------------------------------ Bilder
  function addPhoto(user, q, buffer, mime) {
    const phase = str(q.phase, 20);
    const category = str(q.category, 30);
    if (!C.PHOTO_CATEGORIES[phase]) throw bad('Ungültige Phase (Verpackung / Verladung).');
    if (!C.PHOTO_CATEGORIES[phase][category]) throw bad('Ungültige Bildkategorie.');
    const ext = C.MIME_TYPES[mime];
    if (!ext) throw bad('Nur JPEG-, PNG- oder WebP-Bilder werden unterstützt.');
    if (!buffer || !buffer.length) throw bad('Leere Bilddatei.');
    if (!isImage(buffer, mime)) throw bad('Die Datei ist kein gültiges Bild.');
    let hu = q.hu_id ? getHuRaw(q.hu_id) : null;
    let delivery = q.delivery_id ? getDeliveryRaw(q.delivery_id) : null;
    if (!hu && !delivery) throw bad('Bild muss einem Packstück oder einer Lieferung zugeordnet werden.');
    if (hu && delivery && hu.delivery_id !== delivery.id) throw bad(`Packstück ${hu.package_number} ist nicht auf Lieferung ${delivery.number} verladen.`);
    if (hu && !delivery && phase === 'VERLADUNG' && hu.delivery_id) delivery = getDeliveryRaw(hu.delivery_id);
    const projectId = hu ? hu.project_id : delivery.project_id;
    const d = new Date();
    const rel = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${ext}`;
    const abs = path.join(photosDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
    try {
      return mutate(() => {
        const r = db.prepare(`INSERT INTO photos (hu_id, delivery_id, phase, category, filename, mime, note, taken_at, taken_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(hu ? hu.id : null, delivery ? delivery.id : null, phase, category, rel, mime, str(q.note, 300), U.now(), user || '');
        const id = Number(r.lastInsertRowid);
        const label = `${C.PHOTO_PHASES[phase]}: ${C.PHOTO_CATEGORIES[phase][category]}`;
        if (hu) log(user, projectId, 'hu', hu.id, hu.package_number, 'Bild gespeichert', label);
        if (delivery) log(user, projectId, 'delivery', delivery.id, delivery.number, 'Bild gespeichert', label + (hu ? ` (Packstück ${hu.package_number})` : ''));
        return photosOf('f.id = ?', [id])[0];
      });
    } catch (err) {
      try { fs.unlinkSync(abs); } catch { /* ignorieren */ }
      throw err;
    }
  }

  function isImage(buf, mime) {
    if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (mime === 'image/png') return buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (mime === 'image/webp') return buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
    return false;
  }

  function getPhoto(id) {
    const f = db.prepare('SELECT * FROM photos WHERE id = ?').get(Number(id));
    if (!f) throw notFound('Bild nicht gefunden.');
    const abs = path.resolve(photosDir, f.filename);
    if (!abs.startsWith(path.resolve(photosDir) + path.sep)) throw notFound('Bild nicht gefunden.');
    return { ...f, abs };
  }

  function deletePhoto(user, id) {
    const f = getPhoto(id);
    const res = mutate(() => {
      const hu = f.hu_id ? getHuRaw(f.hu_id) : null;
      const d = f.delivery_id ? getDeliveryRaw(f.delivery_id) : null;
      const shipDelivery = d || (hu && hu.delivery_id ? getDeliveryRaw(hu.delivery_id) : null);
      if ((shipDelivery && ['VERLADEN', 'AUSGELIEFERT'].includes(shipDelivery.status)) || (hu && hu.ship_status === 'AUSGELIEFERT')) {
        throw bad('Nach dem Warenausgang können Bilder nicht mehr gelöscht werden (Nachweis).');
      }
      db.prepare('DELETE FROM photos WHERE id = ?').run(f.id);
      const label = `${C.PHOTO_PHASES[f.phase]}: ${(C.PHOTO_CATEGORIES[f.phase] || {})[f.category] || f.category}`;
      if (hu) log(user, hu.project_id, 'hu', hu.id, hu.package_number, 'Bild gelöscht', label);
      if (d) log(user, d.project_id, 'delivery', d.id, d.number, 'Bild gelöscht', label);
      return { ok: true };
    });
    try { fs.unlinkSync(f.abs); } catch { /* Datei bereits entfernt */ }
    return res;
  }

  // ------------------------------------------------------------------ Übersicht, Suche, Protokoll
  function projectSummary(projectId) {
    const items = listItems(projectId);
    const hus = [...computeHus(projectId).values()];
    const deliveries = db.prepare('SELECT status, kind FROM deliveries WHERE project_id = ?').all(Number(projectId));
    const itemStatus = Object.fromEntries(Object.keys(C.ITEM_STATUS).map((k) => [k, 0]));
    for (const i of items) itemStatus[i.status] += 1;
    const huStatus = Object.fromEntries(Object.keys(C.HU_STATUS).map((k) => [k, 0]));
    for (const h of hus) if (!h.parent_id) huStatus[h.status] += 1;
    const deliveryStatus = Object.fromEntries(Object.keys(C.DELIVERY_STATUS).map((k) => [k, 0]));
    for (const d of deliveries) deliveryStatus[d.status] += 1;
    const progress = items.length ? items.reduce((s, i) => s + Math.min(1, i.qty_packed / i.qty_required), 0) / items.length : 0;
    return {
      positions: items.length,
      positions_complete: items.filter((i) => i.qty_open <= EPS).length,
      positions_open: items.filter((i) => i.qty_packed <= EPS).length,
      positions_partial: items.filter((i) => i.qty_packed > EPS && i.qty_open > EPS).length,
      positions_missing: items.filter((i) => i.qty_missing_eff > EPS).length,
      positions_shipped: items.filter((i) => ['VERLADEN', 'AUSGELIEFERT'].includes(i.status)).length,
      progress_pct: Math.round(progress * 1000) / 10,
      item_status: itemStatus,
      hu_total: hus.length,
      hu_top: hus.filter((h) => !h.parent_id).length,
      hu_status: huStatus,
      deliveries: deliveries.length,
      delivery_status: deliveryStatus,
      supplementary_deliveries: deliveries.filter((d) => d.kind === 'NACHLIEFERUNG').length,
      photos: db.prepare('SELECT COUNT(*) AS n FROM photos f LEFT JOIN handling_units h ON h.id = f.hu_id LEFT JOIN deliveries d ON d.id = f.delivery_id WHERE h.project_id = ? OR d.project_id = ?').get(Number(projectId), Number(projectId)).n,
    };
  }

  function listProjects() {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC, id DESC').all().map((p) => ({ ...p, summary: projectSummary(p.id) }));
  }

  function getProjectDetail(id) {
    const p = getProject(id);
    return { ...p, summary: projectSummary(p.id), psp: listPsp(p.id) };
  }

  /** Fehlteile und Nachlieferungen eines Projekts */
  function shortages(projectId) {
    const items = listItems(projectId);
    const open = items.filter((i) => i.qty_missing_eff > EPS);
    const resolved = items.filter((i) => i.was_missing && i.qty_missing_eff <= EPS);
    const deliveries = listDeliveries(projectId).filter((d) => d.kind === 'NACHLIEFERUNG');
    return { open, resolved, supplementary_deliveries: deliveries };
  }

  function search(q, projectId) {
    q = str(q, 100);
    if (q.length < 2) throw bad('Bitte mindestens 2 Zeichen eingeben.');
    const pid = Number.isInteger(Number(projectId)) && Number(projectId) > 0 ? Number(projectId) : null;
    const like = U.likePattern(q);
    const pf = (alias) => (pid ? ` AND ${alias}.project_id = ${pid}` : '');
    const exact = resolveCode(q, pid);

    // Handling Units / Packstücke
    const huRows = db.prepare(`SELECT h.id, h.project_id FROM handling_units h WHERE (h.hu_number LIKE ? ESCAPE '\\' OR h.package_number LIKE ? ESCAPE '\\'
        OR h.description LIKE ? ESCAPE '\\' OR h.location LIKE ? ESCAPE '\\')${pf('h')} ORDER BY h.package_number LIMIT 100`).all(like, like, like, like);
    const cache = new Map();
    const huOf = (row) => {
      if (!cache.has(row.project_id)) cache.set(row.project_id, computeHus(row.project_id));
      return cache.get(row.project_id).get(row.id);
    };
    const hus = huRows.map(huOf);

    // Material / PSP → Positionen inkl. Packstück, Lieferung
    const matched = new Set(db.prepare(`SELECT DISTINCT pi.id FROM pack_items pi LEFT JOIN psp_elements ps ON ps.id = pi.psp_id
        WHERE (pi.material_number LIKE ? ESCAPE '\\' OR pi.description LIKE ? ESCAPE '\\' OR ps.code LIKE ? ESCAPE '\\'
           OR pi.supplier LIKE ? ESCAPE '\\' OR pi.purchase_order LIKE ? ESCAPE '\\'
           OR EXISTS (SELECT 1 FROM material_barcodes b WHERE b.material_number = pi.material_number AND b.barcode = ?))${pf('pi')}
        LIMIT 300`).all(like, like, like, like, like, q).map((r) => r.id));
    if (exact.kind === 'material') {
      for (const r of db.prepare(`SELECT id FROM pack_items pi WHERE material_number = ?${pf('pi')}`).all(exact.material_number)) matched.add(r.id);
    }
    const items = matched.size ? queryItems('pi.id IN (SELECT value FROM json_each(?))', [JSON.stringify([...matched])]) : [];

    // Lieferungen
    const deliveries = db.prepare(`SELECT d.* FROM deliveries d WHERE (d.number LIKE ? ESCAPE '\\' OR d.truck_plate LIKE ? ESCAPE '\\'
        OR d.trailer_plate LIKE ? ESCAPE '\\' OR d.carrier LIKE ? ESCAPE '\\')${pf('d')} ORDER BY d.created_at DESC LIMIT 50`).all(like, like, like, like)
      .map((d) => {
        if (!cache.has(d.project_id)) cache.set(d.project_id, computeHus(d.project_id));
        return enrichDelivery(d, [...cache.get(d.project_id).values()]);
      });

    // Bilder zu gefundenen Packstücken / Lieferungen
    const huIds = new Set(hus.map((h) => h.id));
    const deliveryIds = new Set(deliveries.map((d) => d.id));
    for (const h of hus) if (h.delivery_id) deliveryIds.add(h.delivery_id);
    for (const i of items) {
      for (const p of i.placements) {
        huIds.add(p.hu_id);
        if (p.delivery_id) deliveryIds.add(p.delivery_id);
      }
    }
    // Bilder der Packstücke sowie Verladebilder der zugehörigen Lieferungen (Lieferung gesamt)
    const photos = huIds.size || deliveryIds.size
      ? photosOf('f.hu_id IN (SELECT value FROM json_each(?)) OR (f.hu_id IS NULL AND f.delivery_id IN (SELECT value FROM json_each(?))) OR f.delivery_id IN (SELECT value FROM json_each(?))',
        [JSON.stringify([...huIds]), JSON.stringify([...deliveryIds]), JSON.stringify(deliveries.map((d) => d.id))]).slice(0, 60)
      : [];

    const projects = new Map(db.prepare('SELECT id, number, name FROM projects').all().map((p) => [p.id, p]));
    return { query: q, exact, hus, items, deliveries, photos, projects: Object.fromEntries(projects) };
  }

  function listEvents(filter) {
    const where = [];
    const params = [];
    if (filter.project_id) { where.push('project_id = ?'); params.push(Number(filter.project_id)); }
    if (filter.entity) { where.push('entity = ?'); params.push(str(filter.entity, 20)); }
    if (filter.entity_id) { where.push('entity_id = ?'); params.push(Number(filter.entity_id)); }
    const limit = Math.min(Number(filter.limit) || 300, 2000);
    return eventsOf(where.length ? where.join(' AND ') : '1 = 1', params, limit);
  }

  // ------------------------------------------------------------------ Etikettendaten (identisch für Browserdruck und ZPL)
  function labelData(specs) {
    if (!Array.isArray(specs) || !specs.length) throw bad('Keine Etiketten angefordert.');
    if (specs.length > 500) throw bad('Maximal 500 Etiketten pro Druckauftrag.');
    const header = getSetting('label_header');
    const cache = new Map();
    const hus = (pid) => { if (!cache.has(pid)) cache.set(pid, computeHus(pid)); return cache.get(pid); };
    const out = [];
    for (const s of specs) {
      const copies = Math.min(Math.max(parseInt(s.copies, 10) || 1, 1), 50);
      let label;
      if (s.kind === 'hu') {
        const raw = getHuRaw(s.hu_id);
        const h = hus(raw.project_id).get(raw.id);
        const p = getProject(h.project_id);
        label = {
          kind: 'hu', header, hu_number: h.hu_number, package_number: h.package_number, project_number: p.number, project_name: p.name,
          psp: h.psp_code || '', description: h.description, packaging: h.packaging_label,
          weight_kg: h.gross_eff, weight_source: h.gross_source, weight_complete: h.gross_complete,
          length_cm: h.length_cm, width_cm: h.width_cm, height_cm: h.height_cm,
          ship_status: h.ship_status_label, status: h.status_label, destination: h.destination || p.destination, customer: p.customer,
          parent: h.parent_package_number || '', delivery: h.delivery_number || '',
          barcode: { value: h.hu_number, symbology: 'CODE128' }, qr: h.hu_number,
        };
      } else if (s.kind === 'item') {
        const it = getItem(s.item_id);
        let qty = it.qty_required;
        let hu = null;
        if (s.hu_id) {
          const c = db.prepare('SELECT qty FROM hu_contents WHERE hu_id = ? AND pack_item_id = ?').get(Number(s.hu_id), it.id);
          if (!c) throw bad(`Material ${it.material_number} ist nicht in diesem Packstück enthalten.`);
          qty = round3(c.qty);
          hu = getHuRaw(s.hu_id);
        }
        if (s.qty !== undefined && s.qty !== null && s.qty !== '') {
          qty = U.requirePositive(s.qty, 'Etikettenmenge');
        }
        const bc = labelBarcodeOf(it.material_number);
        label = {
          kind: 'item', header, material_number: it.material_number, description: it.description, project_number: it.project_number,
          project_name: it.project_name, psp: it.psp_code || '', qty, unit: it.unit, status: it.status_label,
          hu_number: hu ? hu.hu_number : '', package_number: hu ? hu.package_number : '',
          barcode: { value: bc.value, symbology: bc.symbology }, barcode_from_master: bc.from_master,
        };
      } else {
        throw bad('Unbekannte Etikettenart.');
      }
      for (let i = 0; i < copies; i++) out.push(label);
    }
    return out;
  }

  // ------------------------------------------------------------------ Drucker
  function listPrinters() {
    return db.prepare('SELECT * FROM printers ORDER BY name').all();
  }
  function getPrinter(id) {
    const p = db.prepare('SELECT * FROM printers WHERE id = ?').get(Number(id));
    if (!p) throw notFound('Drucker nicht gefunden.');
    return p;
  }
  function readPrinter(body) {
    const name = str(body.name, 80);
    const host = str(body.host, 120);
    const port = Number(body.port || 9100);
    const dpi = Number(body.dpi || 203);
    if (!name) throw bad('Druckername ist ein Pflichtfeld.');
    if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host)) throw bad('Bitte eine gültige IP-Adresse oder einen Hostnamen angeben.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('Ungültiger Port.');
    if (![203, 300, 600].includes(dpi)) throw bad('Auflösung muss 203, 300 oder 600 dpi sein.');
    return { name, host, port, dpi };
  }
  function savePrinter(user, id, body) {
    return mutate(() => {
      const p = readPrinter(body);
      if (id) {
        getPrinter(id);
        db.prepare('UPDATE printers SET name = ?, host = ?, port = ?, dpi = ? WHERE id = ?').run(p.name, p.host, p.port, p.dpi, Number(id));
        log(user, null, 'printer', Number(id), p.name, 'Drucker geändert');
        return getPrinter(id);
      }
      const r = db.prepare('INSERT INTO printers (name, host, port, dpi) VALUES (?, ?, ?, ?)').run(p.name, p.host, p.port, p.dpi);
      log(user, null, 'printer', Number(r.lastInsertRowid), p.name, 'Drucker angelegt');
      return getPrinter(Number(r.lastInsertRowid));
    });
  }
  function deletePrinter(user, id) {
    return mutate(() => {
      const p = getPrinter(id);
      db.prepare('DELETE FROM printers WHERE id = ?').run(p.id);
      log(user, null, 'printer', p.id, p.name, 'Drucker gelöscht');
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ Einstellungen (API)
  function publicSettings() {
    const out = {};
    for (const k of EDITABLE_SETTINGS) out[k] = getSetting(k);
    out.sap_auth = out.sap_auth ? '••••••' : '';
    out.sap_auth_set = !!getSetting('sap_auth');
    return out;
  }

  function updateSettings(user, body) {
    return mutate(() => {
      const changed = [];
      for (const k of EDITABLE_SETTINGS) {
        if (body[k] === undefined) continue;
        let v = String(body[k] ?? '').trim();
        if (k === 'sap_auth' && v === '••••••') continue;
        if (k === 'hu_prefix' || k === 'delivery_prefix') {
          v = v.toUpperCase();
          if (!/^[A-Z0-9]{0,6}$/.test(v)) throw bad('Präfix: maximal 6 Zeichen (A–Z, 0–9).');
        }
        if (k === 'barcode_regex' && v) {
          try { new RegExp(v); } catch { throw bad('Das Barcode-Muster ist kein gültiger regulärer Ausdruck.'); }
        }
        if (k === 'sap_enabled') v = v === '1' || v === 'true' ? '1' : '0';
        if (k === 'sap_endpoint' && v && !/^https?:\/\/\S+$/i.test(v)) throw bad('Der SAP-Endpunkt muss eine http(s)-Adresse sein.');
        if (k === 'label_dpi' && !['203', '300', '600'].includes(v)) throw bad('Auflösung muss 203, 300 oder 600 dpi sein.');
        if (k === 'label_header') v = v.slice(0, 60);
        if (getSetting(k) !== v) { setSetting(k, v); changed.push(k); }
      }
      if (changed.length) log(user, null, 'settings', null, '', 'Einstellungen geändert', changed.join(', '));
      return publicSettings();
    });
  }

  function outbox(status, limit = 200) {
    const rows = status
      ? db.prepare('SELECT * FROM sap_outbox WHERE status = ? ORDER BY id DESC LIMIT ?').all(str(status, 20), limit)
      : db.prepare('SELECT * FROM sap_outbox ORDER BY id DESC LIMIT ?').all(limit);
    return { stats: sap.stats(), rows };
  }

  function exportOutbox(user, markExported) {
    const rows = db.prepare("SELECT * FROM sap_outbox WHERE status IN ('PENDING','ERROR') ORDER BY id").all();
    const data = rows.map((r) => ({ messageId: r.id, type: r.type, createdAt: r.created_at, payload: U.parseJsonSafe(r.payload, {}) }));
    if (markExported && rows.length) {
      mutate(() => {
        db.prepare("UPDATE sap_outbox SET status = 'EXPORTED', sent_at = ? WHERE id IN (SELECT value FROM json_each(?))").run(U.now(), JSON.stringify(rows.map((r) => r.id)));
        log(user, null, 'sap', null, '', 'SAP-Nachrichten exportiert', `${rows.length} Nachrichten`);
      });
    }
    return data;
  }

  function retryOutbox() {
    db.prepare("UPDATE sap_outbox SET status = 'PENDING' WHERE status = 'ERROR'").run();
    sap.kick();
    return sap.stats();
  }

  return {
    db, sap, getSetting, setSetting, mutate, log, getDeliveryRaw, getHuRaw,
    // Projekte
    listProjects, getProject, getProjectDetail, createProject, updateProject, projectSummary,
    listPsp, createPsp, updatePsp, deletePsp,
    // Material
    listMaterials, materialDetail, createMaterial, updateMaterial, addBarcode, removeBarcode, importMaterials, resolveCode,
    // Packvorrat
    listItems, getItem, createItem, updateItem, deleteItem, setItemsBaseStatus, reportMissing, importItems, shortages,
    // HUs
    listHus, getHu, getHuDetail, createHu, updateHu, deleteHu, pack, unpack, setParent, addChild, huAction,
    // Lieferungen
    listDeliveries, getDelivery, getDeliveryDetail, createDelivery, updateDelivery, deleteDelivery, loadHu, unloadHu, deliveryAction,
    // Bilder
    addPhoto, getPhoto, deletePhoto,
    // Suche, Protokoll, Etiketten, Drucker, Einstellungen, SAP
    search, listEvents, labelData, listPrinters, getPrinter, savePrinter, deletePrinter, publicSettings, updateSettings,
    outbox, exportOutbox, retryOutbox,
  };
}

module.exports = { createDomain, huStatusKey };
