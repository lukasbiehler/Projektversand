'use strict';
// Ladeplanung: Fahrzeug-/Containertypen, Ladepläne je Projekt, Berechnung, manuelle Korrekturen,
// Verknüpfung der Laderäume mit Lieferungen (Verladung per Scan nach Ladeplan)

const C = require('./constants');
const U = require('./util');
const LP = require('./loadplan');

const { bad, notFound, str, round3 } = U;

const DEFAULT_SETTINGS = { min_support_pct: 80, group_strict: true, balance: true, auto_add_type_id: null, auto_add: null };
const TYPE_FIELDS = ['length_cm', 'width_cm', 'height_cm', 'max_payload_kg', 'axle_front_x_cm', 'axle_rear_x_cm', 'axle_front_empty_kg',
  'axle_rear_empty_kg', 'axle_front_max_kg', 'axle_rear_max_kg', 'cog_tolerance_pct'];

function createLoadplanDomain(domain) {
  const { db, mutate, log } = domain;

  // ------------------------------------------------------------------ Fahrzeug-/Containertypen
  function seed() {
    if (db.prepare('SELECT COUNT(*) AS n FROM vehicle_types').get().n > 0) return;
    const ins = db.prepare(`INSERT INTO vehicle_types (name, category, ${TYPE_FIELDS.join(', ')}, note, builtin)
      VALUES (?, ?, ${TYPE_FIELDS.map(() => '?').join(', ')}, ?, 1)`);
    for (const v of C.VEHICLE_PRESETS) ins.run(v.name, v.category, ...TYPE_FIELDS.map((k) => v[k] ?? null), v.note || '');
  }
  seed();

  const listTypes = () => db.prepare('SELECT * FROM vehicle_types ORDER BY builtin DESC, category, name').all();
  function getType(id) {
    const t = db.prepare('SELECT * FROM vehicle_types WHERE id = ?').get(Number(id));
    if (!t) throw notFound('Fahrzeug-/Containertyp nicht gefunden.');
    return t;
  }

  function readType(body) {
    const name = str(body.name, 80);
    if (!name) throw bad('Bezeichnung ist ein Pflichtfeld.');
    const category = C.VEHICLE_CATEGORIES[body.category] ? body.category : 'SONSTIGE';
    const t = { name, category, note: str(body.note, 300) };
    const num = (k, label, opts) => { t[k] = U.requirePositive(body[k], label, opts); };
    num('length_cm', 'Innenlänge'); num('width_cm', 'Innenbreite'); num('height_cm', 'Innenhöhe');
    for (const k of ['length_cm', 'width_cm', 'height_cm']) if (t[k] > 5000) throw bad('Maße über 50 m sind nicht zulässig.');
    num('max_payload_kg', 'Nutzlast', { allowNull: true });
    num('cog_tolerance_pct', 'Schwerpunkttoleranz', { allowNull: true });
    if (t.cog_tolerance_pct !== null && t.cog_tolerance_pct > 50) throw bad('Schwerpunkttoleranz höchstens 50 %.');
    const fx = U.toNum(body.axle_front_x_cm);
    const rx = U.toNum(body.axle_rear_x_cm);
    if ((fx === null) !== (rx === null)) throw bad('Für das Achslastmodell bitte beide Abstützpunkte (vorne und hinten) angeben oder beide leer lassen.');
    if (Number.isNaN(fx) || Number.isNaN(rx)) throw bad('Achsposition ist keine gültige Zahl.');
    if (fx !== null && rx <= fx) throw bad('Der hintere Abstützpunkt muss hinter dem vorderen liegen.');
    t.axle_front_x_cm = fx === null ? null : round3(fx);
    t.axle_rear_x_cm = rx === null ? null : round3(rx);
    num('axle_front_empty_kg', 'Leergewicht vorne', { allowNull: true, allowZero: true });
    num('axle_rear_empty_kg', 'Leergewicht hinten', { allowNull: true, allowZero: true });
    num('axle_front_max_kg', 'Zulässige Last vorne', { allowNull: true });
    num('axle_rear_max_kg', 'Zulässige Last hinten', { allowNull: true });
    return t;
  }

  function saveType(user, id, body) {
    return mutate(() => {
      const t = readType(body);
      if (id) {
        getType(id);
        db.prepare(`UPDATE vehicle_types SET name = ?, category = ?, ${TYPE_FIELDS.map((k) => `${k} = ?`).join(', ')}, note = ? WHERE id = ?`)
          .run(t.name, t.category, ...TYPE_FIELDS.map((k) => t[k] ?? null), t.note, Number(id));
        log(user, null, 'vehicle', Number(id), t.name, 'Fahrzeugtyp geändert');
        return getType(id);
      }
      const r = db.prepare(`INSERT INTO vehicle_types (name, category, ${TYPE_FIELDS.join(', ')}, note, builtin) VALUES (?, ?, ${TYPE_FIELDS.map(() => '?').join(', ')}, ?, 0)`)
        .run(t.name, t.category, ...TYPE_FIELDS.map((k) => t[k] ?? null), t.note);
      log(user, null, 'vehicle', Number(r.lastInsertRowid), t.name, 'Fahrzeugtyp angelegt');
      return getType(Number(r.lastInsertRowid));
    });
  }

  function deleteType(user, id) {
    return mutate(() => {
      const t = getType(id);
      db.prepare('DELETE FROM vehicle_types WHERE id = ?').run(t.id);
      log(user, null, 'vehicle', t.id, t.name, 'Fahrzeugtyp gelöscht');
      return { ok: true };
    });
  }

  /** Momentaufnahme eines Typs (Plan bleibt stabil, auch wenn der Typ später geändert wird) */
  function snapshot(type, key) {
    const s = { key, type_id: type.id, name: type.name, category: type.category };
    for (const k of TYPE_FIELDS) s[k] = type[k] ?? null;
    return s;
  }

  // ------------------------------------------------------------------ Ladepläne
  function getPlanRaw(id) {
    const p = db.prepare('SELECT * FROM load_plans WHERE id = ?').get(Number(id));
    if (!p) throw notFound('Ladeplan nicht gefunden.');
    return {
      ...p,
      spaces: U.parseJsonSafe(p.spaces, []),
      settings: { ...DEFAULT_SETTINGS, ...U.parseJsonSafe(p.settings, {}) },
      assignments: U.parseJsonSafe(p.assignments, {}),
      result: p.result ? U.parseJsonSafe(p.result, null) : null,
    };
  }

  function touch(planId, stale = true) {
    db.prepare(`UPDATE load_plans SET updated_at = ?${stale ? ', stale = 1' : ''} WHERE id = ?`).run(U.now(), planId);
  }

  function listPlans(projectId) {
    domain.getProject(projectId);
    return db.prepare('SELECT * FROM load_plans WHERE project_id = ? ORDER BY updated_at DESC').all(Number(projectId)).map((row) => {
      const p = getPlanRaw(row.id);
      const items = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(qty), 0) AS q FROM load_plan_items WHERE plan_id = ?').get(p.id);
      const res = p.result;
      return {
        id: p.id, name: p.name, stale: !!p.stale, computed_at: p.computed_at, updated_at: p.updated_at, created_by: p.created_by,
        spaces: p.spaces.map((s) => s.name), items: items.n, pieces: items.q,
        vehicles_used: res ? res.spaces.filter((s) => s.placements.length).length : null,
        unplaced: res ? res.unplaced.length : null,
        weight_kg: res ? round3(res.spaces.reduce((a, s) => a + s.stats.weight_kg, 0)) : null,
        warnings: res ? res.spaces.reduce((a, s) => a + s.stats.warnings.length, 0) : null,
        deliveries: Object.values(p.assignments).length,
      };
    });
  }

  function createPlan(user, projectId, body) {
    return mutate(() => {
      const project = domain.getProject(projectId);
      const name = str(body.name, 100) || `Ladeplan ${new Date().toLocaleDateString('de-DE')}`;
      const spaces = [];
      if (body.vehicle_type_id) spaces.push(snapshot(getType(body.vehicle_type_id), 'S1'));
      const settings = { ...DEFAULT_SETTINGS };
      if (body.vehicle_type_id && body.auto_add !== false) {
        settings.auto_add_type_id = Number(body.vehicle_type_id);
        settings.auto_add = snapshot(getType(body.vehicle_type_id), 'AUTO');
      }
      const r = db.prepare('INSERT INTO load_plans (project_id, name, spaces, settings, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(project.id, name, JSON.stringify(spaces), JSON.stringify(settings), U.now(), user || '', U.now());
      const id = Number(r.lastInsertRowid);
      log(user, project.id, 'loadplan', id, name, 'Ladeplan angelegt', spaces.map((s) => s.name).join(', '));
      if (body.add_hus === 'ready' || body.add_hus === 'open') {
        const hus = domain.listHus(project.id).filter((h) => !h.parent_id && !h.delivery_id
          && (body.add_hus === 'open' ? h.ship_status === 'OFFEN' || h.ship_status === 'VERSANDBEREIT' : h.ship_status === 'VERSANDBEREIT'));
        addHuItems(user, id, hus.map((h) => h.id));
      }
      return getPlan(id);
    });
  }

  function updatePlan(user, id, body) {
    return mutate(() => {
      const p = getPlanRaw(id);
      const name = body.name !== undefined ? (str(body.name, 100) || p.name) : p.name;
      let spaces = p.spaces;
      if (Array.isArray(body.spaces)) {
        const used = new Set();
        spaces = body.spaces.map((s) => {
          const existing = s.key ? p.spaces.find((x) => x.key === s.key) : null;
          let snap;
          if (existing && (!s.type_id || Number(s.type_id) === existing.type_id)) snap = existing;
          else snap = snapshot(getType(s.type_id), null);
          let key = snap.key && !used.has(snap.key) ? snap.key : null;
          if (!key) { let n = 1; while (used.has(`S${n}`) || p.spaces.some((x) => x.key === `S${n}` && x !== existing)) n += 1; key = `S${n}`; }
          used.add(key);
          return { ...snap, key };
        });
        if (spaces.length > 30) throw bad('Maximal 30 Laderäume je Plan.');
      }
      const settings = { ...p.settings };
      if (body.settings) {
        const s = body.settings;
        if (s.min_support_pct !== undefined) {
          const v = Number(s.min_support_pct);
          if (!Number.isFinite(v) || v < 30 || v > 100) throw bad('Mindest-Auflagefläche muss zwischen 30 und 100 % liegen.');
          settings.min_support_pct = v;
        }
        if (s.group_strict !== undefined) settings.group_strict = U.toBool(s.group_strict);
        if (s.balance !== undefined) settings.balance = U.toBool(s.balance);
        if (s.auto_add_type_id !== undefined) {
          if (s.auto_add_type_id) {
            const t = getType(s.auto_add_type_id);
            settings.auto_add_type_id = t.id;
            settings.auto_add = snapshot(t, 'AUTO');
          } else { settings.auto_add_type_id = null; settings.auto_add = null; }
        }
      }
      db.prepare('UPDATE load_plans SET name = ?, spaces = ?, settings = ?, stale = 1, updated_at = ? WHERE id = ?')
        .run(name, JSON.stringify(spaces), JSON.stringify(settings), U.now(), p.id);
      log(user, p.project_id, 'loadplan', p.id, name, 'Ladeplan geändert', spaces.map((s) => s.name).join(', '));
      return getPlan(p.id);
    });
  }

  function deletePlan(user, id) {
    return mutate(() => {
      const p = getPlanRaw(id);
      db.prepare('DELETE FROM load_plans WHERE id = ?').run(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladeplan gelöscht');
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ Ladegut
  function readFlags(body, current = {}) {
    const f = {};
    for (const k of ['stackable', 'rotatable', 'tiltable']) f[k] = body[k] !== undefined ? (U.toBool(body[k]) ? 1 : 0) : (current[k] ?? (k === 'tiltable' ? 0 : 1));
    f.max_top_load_kg = body.max_top_load_kg !== undefined
      ? U.requirePositive(body.max_top_load_kg, 'Maximale Auflast', { allowNull: true, allowZero: true })
      : (current.max_top_load_kg ?? null);
    const stop = body.stop !== undefined ? Number(body.stop) : (current.stop ?? 1);
    if (!Number.isInteger(stop) || stop < 1 || stop > 99) throw bad('Entladestelle muss eine ganze Zahl von 1 bis 99 sein.');
    f.stop = stop;
    return f;
  }

  function addHuItems(user, planId, huIds) {
    const p = getPlanRaw(planId);
    let n = 0;
    for (const huId of huIds) {
      const h = domain.getHuRaw(huId);
      if (h.project_id !== p.project_id) throw bad(`Packstück ${h.package_number} gehört zu einem anderen Projekt.`);
      if (h.parent_id) throw bad(`Packstück ${h.package_number} liegt in einem anderen Packstück – bitte das äußere Packstück einplanen.`);
      if (db.prepare('SELECT 1 FROM load_plan_items WHERE plan_id = ? AND hu_id = ?').get(p.id, h.id)) continue;
      db.prepare('INSERT INTO load_plan_items (plan_id, hu_id, name, stop) VALUES (?, ?, ?, 1)').run(p.id, h.id, h.package_number);
      n += 1;
    }
    if (n) {
      touch(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Packstücke eingeplant', `${n} Packstück(e)`);
    }
    return n;
  }

  function readManual(body, current = {}) {
    const name = body.name !== undefined ? str(body.name, 100) : current.name;
    if (!name) throw bad('Bezeichnung ist ein Pflichtfeld.');
    const it = { name };
    for (const [k, label] of [['length_cm', 'Länge'], ['width_cm', 'Breite'], ['height_cm', 'Höhe']]) {
      it[k] = body[k] !== undefined ? U.requirePositive(body[k], label) : current[k];
      if (it[k] > 5000) throw bad(`${label} über 50 m ist nicht zulässig.`);
    }
    it.weight_kg = body.weight_kg !== undefined ? U.requirePositive(body.weight_kg, 'Gewicht', { allowZero: true }) : current.weight_kg;
    const qty = body.qty !== undefined ? Number(body.qty) : (current.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) throw bad('Anzahl muss zwischen 1 und 999 liegen.');
    it.qty = qty;
    return { ...it, ...readFlags(body, current) };
  }

  function addItems(user, planId, body) {
    return mutate(() => {
      const p = getPlanRaw(planId);
      if (Array.isArray(body.hu_ids)) {
        const n = addHuItems(user, p.id, body.hu_ids.map(Number));
        return { added: n, plan: getPlan(p.id) };
      }
      const it = readManual(body);
      db.prepare(`INSERT INTO load_plan_items (plan_id, hu_id, name, length_cm, width_cm, height_cm, weight_kg, qty, stackable, rotatable, tiltable, max_top_load_kg, stop)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.id, it.name, it.length_cm, it.width_cm, it.height_cm, it.weight_kg, it.qty, it.stackable, it.rotatable, it.tiltable, it.max_top_load_kg, it.stop);
      touch(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladegut ergänzt', `${it.qty} × ${it.name}`);
      return { added: 1, plan: getPlan(p.id) };
    });
  }

  function getItemRow(id) {
    const it = db.prepare('SELECT * FROM load_plan_items WHERE id = ?').get(Number(id));
    if (!it) throw notFound('Ladegut nicht gefunden.');
    return it;
  }

  function updateItem(user, id, body) {
    return mutate(() => {
      const it = getItemRow(id);
      const p = getPlanRaw(it.plan_id);
      if (it.hu_id) {
        // Eigenschaften eines Packstücks werden am Packstück gepflegt (eine Quelle der Wahrheit)
        const huBody = {};
        for (const k of ['stackable', 'rotatable', 'tiltable', 'max_top_load_kg']) if (body[k] !== undefined) huBody[k] = body[k];
        if (Object.keys(huBody).length) domain.updateHu(user, it.hu_id, huBody);
        const f = readFlags({ stop: body.stop }, it);
        db.prepare('UPDATE load_plan_items SET stop = ? WHERE id = ?').run(f.stop, it.id);
      } else {
        const m = readManual(body, it);
        db.prepare(`UPDATE load_plan_items SET name = ?, length_cm = ?, width_cm = ?, height_cm = ?, weight_kg = ?, qty = ?, stackable = ?, rotatable = ?,
          tiltable = ?, max_top_load_kg = ?, stop = ? WHERE id = ?`)
          .run(m.name, m.length_cm, m.width_cm, m.height_cm, m.weight_kg, m.qty, m.stackable, m.rotatable, m.tiltable, m.max_top_load_kg, m.stop, it.id);
      }
      touch(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladegut geändert', it.name);
      return getPlan(p.id);
    });
  }

  function deleteItem(user, id) {
    return mutate(() => {
      const it = getItemRow(id);
      const p = getPlanRaw(it.plan_id);
      db.prepare('DELETE FROM load_plan_items WHERE id = ?').run(it.id);
      touch(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladegut entfernt', it.name);
      return getPlan(p.id);
    });
  }

  function importItems(user, planId, body) {
    const p = getPlanRaw(planId);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) throw bad('Die Importdatei enthält keine Zeilen.');
    if (rows.length > 2000) throw bad('Maximal 2.000 Zeilen pro Import.');
    const fmt = body.number_format === 'EN' ? 'EN' : 'DE';
    const results = [];
    const ok = [];
    rows.forEach((r, idx) => {
      const rowNo = Number(r.row_no) || idx + 1;
      try {
        const num = (v) => { const n = U.parseLocaleNumber(v, fmt); return Number.isNaN(n) ? v : n; };
        const flag = (v, def) => (v === undefined || v === null || String(v).trim() === '' ? def : v);
        const it = readManual({
          name: r.name, length_cm: num(r.length_cm), width_cm: num(r.width_cm), height_cm: num(r.height_cm),
          weight_kg: num(r.weight_kg ?? 0) ?? 0, qty: r.qty === undefined || String(r.qty).trim() === '' ? 1 : Number(num(r.qty)),
          stackable: flag(r.stackable, true), rotatable: flag(r.rotatable, true), tiltable: flag(r.tiltable, false),
          max_top_load_kg: r.max_top_load_kg === undefined || String(r.max_top_load_kg).trim() === '' ? null : num(r.max_top_load_kg),
          stop: r.stop === undefined || String(r.stop).trim() === '' ? 1 : Number(num(r.stop)),
        });
        ok.push(it);
        results.push({ row_no: rowNo, status: 'NEU', message: `${it.qty} × ${it.name} (${it.length_cm} × ${it.width_cm} × ${it.height_cm} cm, ${it.weight_kg} kg)` });
      } catch (err) {
        results.push({ row_no: rowNo, status: 'FEHLER', message: err.message });
      }
    });
    const summary = { rows: rows.length, new: ok.length, updated: 0, errors: results.filter((r) => r.status === 'FEHLER').length };
    if (body.dry_run) return { summary, rows: results };
    if (summary.errors && !body.skip_errors) throw bad('Der Import enthält fehlerhafte Zeilen.', { summary, rows: results });
    return mutate(() => {
      const ins = db.prepare(`INSERT INTO load_plan_items (plan_id, hu_id, name, length_cm, width_cm, height_cm, weight_kg, qty, stackable, rotatable, tiltable, max_top_load_kg, stop)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const it of ok) ins.run(p.id, it.name, it.length_cm, it.width_cm, it.height_cm, it.weight_kg, it.qty, it.stackable, it.rotatable, it.tiltable, it.max_top_load_kg, it.stop);
      touch(p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladegut importiert', `${ok.length} Zeilen${body.file_name ? ' aus ' + str(body.file_name, 200) : ''}`);
      return { summary, rows: results };
    });
  }

  /** Ladegut mit aktuellen Packstückdaten (Maße, Gewicht, Eigenschaften) */
  function resolvedItems(p) {
    const hus = new Map(domain.listHus(p.project_id).map((h) => [h.id, h]));
    return db.prepare('SELECT * FROM load_plan_items WHERE plan_id = ? ORDER BY stop DESC, id').all(p.id).map((it) => {
      if (!it.hu_id) {
        return { ...it, kind: 'MANUELL', label: it.name, sub: '', problems: [] };
      }
      const h = hus.get(it.hu_id);
      const problems = [];
      if (!h) problems.push('Packstück nicht mehr vorhanden');
      else {
        if (!h.dims_complete) problems.push('Abmessungen fehlen');
        if (h.gross_eff === null) problems.push('Gewicht fehlt');
        if (h.parent_id) problems.push(`liegt inzwischen in ${h.parent_package_number}`);
      }
      return {
        ...it, kind: 'PACKSTUECK', label: h ? h.package_number : it.name,
        sub: h ? `${h.packaging_label}${h.description ? ' · ' + h.description : ''}` : '',
        length_cm: h ? h.length_cm : null, width_cm: h ? h.width_cm : null, height_cm: h ? h.height_cm : null,
        weight_kg: h ? h.gross_eff : null, weight_complete: h ? h.gross_complete : false,
        stackable: h ? h.stackable : 1, rotatable: h ? h.rotatable : 1, tiltable: h ? h.tiltable : 0, max_top_load_kg: h ? h.max_top_load_kg : null,
        hu_number: h ? h.hu_number : '', hu_status: h ? h.status : '', hu_status_label: h ? h.status_label : '',
        delivery_id: h ? h.delivery_id : null, delivery_number: h ? h.delivery_number : null,
        problems,
      };
    });
  }

  function piecesOf(items) {
    const pieces = [];
    for (const it of items) {
      for (let n = 1; n <= it.qty; n++) {
        pieces.push({
          id: `I${it.id}-${n}`, item_id: it.id, hu_id: it.hu_id || null,
          label: it.qty > 1 ? `${it.label} #${n}` : it.label, sub: it.sub,
          length_cm: it.length_cm, width_cm: it.width_cm, height_cm: it.height_cm, weight_kg: it.weight_kg ?? 0,
          stackable: !!it.stackable, rotatable: !!it.rotatable, tiltable: !!it.tiltable, max_top_load_kg: it.max_top_load_kg ?? null, stop: it.stop,
        });
      }
    }
    return pieces;
  }

  function getPlan(id) {
    const p = getPlanRaw(id);
    const project = domain.getProject(p.project_id);
    const items = resolvedItems(p);
    const inPlan = new Set(items.filter((i) => i.hu_id).map((i) => i.hu_id));
    const candidates = domain.listHus(p.project_id).filter((h) => !h.parent_id && !inPlan.has(h.id)).map((h) => ({
      id: h.id, package_number: h.package_number, packaging_label: h.packaging_label, description: h.description, status: h.status, status_label: h.status_label,
      dims_complete: h.dims_complete, gross_eff: h.gross_eff, length_cm: h.length_cm, width_cm: h.width_cm, height_cm: h.height_cm,
      delivery_number: h.delivery_number, ship_status: h.ship_status,
    }));
    // Hat sich seit der Berechnung etwas an den Packstücken geändert?
    let changedSinceCalc = false;
    if (p.result && !p.stale) {
      const current = new Map(piecesOf(items.filter((i) => !i.problems.length)).map((pc) => [pc.id, pc]));
      for (const [pid, snap] of Object.entries(p.result.pieces || {})) {
        const c = current.get(pid);
        if (!c || ['length_cm', 'width_cm', 'height_cm', 'weight_kg', 'stackable', 'rotatable', 'tiltable', 'max_top_load_kg', 'stop'].some((k) => (c[k] ?? null) !== (snap[k] ?? null))) {
          changedSinceCalc = true;
          break;
        }
      }
      if (current.size !== Object.keys(p.result.pieces || {}).length) changedSinceCalc = true;
    }
    const deliveries = {};
    for (const [key, did] of Object.entries(p.assignments)) {
      const d = db.prepare('SELECT id, number, status, kind, truck_plate FROM deliveries WHERE id = ?').get(did);
      if (d) deliveries[key] = { ...d, status_label: C.DELIVERY_STATUS[d.status], kind_label: C.DELIVERY_KINDS[d.kind] };
    }
    return {
      id: p.id, project, name: p.name, spaces: p.spaces, settings: p.settings, result: p.result, stale: !!p.stale || changedSinceCalc,
      changed_since_calc: changedSinceCalc, computed_at: p.computed_at, updated_at: p.updated_at, created_by: p.created_by,
      items, candidates, deliveries, assignments: p.assignments,
      open_deliveries: db.prepare("SELECT id, number, status, kind FROM deliveries WHERE project_id = ? AND status IN ('GEPLANT','IN_VERLADUNG') ORDER BY id").all(p.project_id),
    };
  }

  // ------------------------------------------------------------------ Berechnung
  function calculate(user, id) {
    const p = getPlanRaw(id);
    const items = resolvedItems(p);
    if (!p.spaces.length && !p.settings.auto_add) throw bad('Bitte mindestens einen Laderaum (Fahrzeug / Container) wählen.');
    const valid = items.filter((i) => !i.problems.length);
    const invalid = items.filter((i) => i.problems.length);
    const pieces = piecesOf(valid);
    if (!pieces.length) throw bad(invalid.length ? 'Kein Ladegut mit vollständigen Maßen vorhanden.' : 'Bitte zuerst Ladegut (Packstücke oder Positionen) hinzufügen.');
    if (pieces.length > 3000) throw bad('Maximal 3.000 Teile je Ladeplan.');
    const res = LP.optimize(p.spaces, pieces, {
      minSupport: p.settings.min_support_pct / 100,
      groupStrict: p.settings.group_strict,
      balance: p.settings.balance,
      autoAdd: p.settings.auto_add || null,
    });
    // Automatisch ergänzte Laderäume erhalten die Daten des Vorlagetyps
    const spaceDefs = [];
    for (const s of res.spaces) {
      const def = p.spaces.find((x) => x.key === s.key) || { ...p.settings.auto_add, key: s.key, name: `${p.settings.auto_add.name} (${s.key.replace('AUTO', 'zusätzlich ')})` };
      s.name = def.name;
      spaceDefs.push(def);
    }
    const piecesMap = Object.fromEntries(pieces.map((pc) => [pc.id, pc]));
    const result = {
      ...res,
      computed_by: user || '',
      space_defs: spaceDefs,
      pieces: piecesMap,
      excluded: invalid.map((i) => ({ item_id: i.id, label: i.label, problems: i.problems })),
    };
    return mutate(() => {
      const assignments = Object.fromEntries(Object.entries(p.assignments).filter(([k]) => result.spaces.some((s) => s.key === k)));
      db.prepare('UPDATE load_plans SET result = ?, stale = 0, computed_at = ?, assignments = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(result), U.now(), JSON.stringify(assignments), U.now(), p.id);
      const used = result.spaces.filter((s) => s.placements.length).length;
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladeplan berechnet',
        `${pieces.length - result.unplaced.length} von ${pieces.length} Teilen in ${used} Laderaum/-räumen${result.unplaced.length ? `, ${result.unplaced.length} nicht verladen` : ''}`);
      return getPlan(p.id);
    });
  }

  // ------------------------------------------------------------------ Manuelle Korrektur
  function edit(user, id, body) {
    const p = getPlanRaw(id);
    if (!p.result) throw bad('Bitte zuerst den Ladeplan berechnen.');
    if (p.stale || getPlan(p.id).changed_since_calc) throw bad('Der Plan oder die Packstückdaten wurden seit der Berechnung geändert. Bitte neu berechnen, bevor Sie manuell anpassen.');
    const result = p.result;
    const piecesById = new Map(Object.entries(result.pieces));
    const minSupport = (result.options && result.options.min_support) || p.settings.min_support_pct / 100;
    const action = str(body.action, 20);
    const pieceId = str(body.piece_id, 40);
    if (!piecesById.has(pieceId)) throw notFound('Teil nicht im Ladeplan.');
    const findSpaceOf = () => result.spaces.findIndex((s) => s.placements.some((pl) => pl.piece_id === pieceId));
    let si = findSpaceOf();
    const targetKey = body.space_key ? str(body.space_key, 20) : null;
    const ti = targetKey ? result.spaces.findIndex((s) => s.key === targetKey) : si;
    if (ti < 0) throw bad('Laderaum nicht gefunden.');
    const defOf = (i) => result.space_defs[i];

    const apply = (i, placed) => {
      const errors = LP.validate(LP.toSpace(defOf(i), defOf(i).key), placed, minSupport);
      if (errors.length) throw bad(`Nicht zulässig: ${[...new Set(errors)].slice(0, 5).join('; ')}`);
      const ser = LP.serialize(LP.toSpace(defOf(i), defOf(i).key), placed);
      result.spaces[i].placements = ser.placements;
      result.spaces[i].stats = ser.stats;
      result.spaces[i].shift_cm = 0;
    };

    if (action === 'remove') {
      if (si < 0) throw bad('Teil ist nicht verladen.');
      const { placed } = LP.restore(defOf(si), result.spaces[si].placements, piecesById);
      const rest = placed.filter((b) => b.pc.id !== pieceId);
      apply(si, rest);
      result.unplaced.push({ piece_id: pieceId, reason: 'MANUAL', reason_label: 'Manuell aus dem Plan genommen' });
    } else if (action === 'place') {
      const { space, placed } = LP.restore(defOf(ti), result.spaces[ti].placements.filter((pl) => pl.piece_id !== pieceId), piecesById);
      const pc = { ...LP.toPiece(piecesById.get(pieceId)), label: piecesById.get(pieceId).label };
      const box = LP.autoPlace(space, placed, pc, minSupport, p.settings.group_strict);
      if (!box) throw bad(`Im Laderaum „${result.spaces[ti].name}“ ist kein zulässiger Platz frei.`);
      if (si >= 0 && si !== ti) {
        const from = LP.restore(defOf(si), result.spaces[si].placements.filter((pl) => pl.piece_id !== pieceId), piecesById);
        apply(si, from.placed);
      }
      apply(ti, [...placed, box]);
      result.unplaced = result.unplaced.filter((u) => u.piece_id !== pieceId);
    } else if (['move', 'rotate', 'drop'].includes(action)) {
      if (si < 0) throw bad('Teil ist nicht verladen – bitte zuerst platzieren.');
      const { placed } = LP.restore(defOf(si), result.spaces[si].placements, piecesById);
      const b = placed.find((x) => x.pc.id === pieceId);
      if (action === 'move') {
        for (const k of ['x', 'y', 'z']) {
          if (body[k] === undefined) continue;
          const v = U.toNum(body[k]);
          if (v === null || Number.isNaN(v)) throw bad(`Position ${k} ist ungültig.`);
          b[k] = LP.MM(v);
        }
        if (body.drop !== false) b.z = LP.dropZ(placed, b);
      } else if (action === 'rotate') {
        if (!b.pc.rotatable && !b.pc.tiltable) throw bad('Dieses Teil darf nicht gedreht werden.');
        [b.dx, b.dy] = [b.dy, b.dx];
      } else {
        b.z = LP.dropZ(placed, b);
      }
      apply(si, placed);
    } else {
      throw bad('Unbekannte Aktion.');
    }
    return mutate(() => {
      db.prepare('UPDATE load_plans SET result = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(result), U.now(), p.id);
      const label = piecesById.get(pieceId).label;
      const texts = { move: 'verschoben', rotate: 'gedreht', drop: 'abgesenkt', remove: 'aus dem Plan genommen', place: 'automatisch platziert' };
      log(user, p.project_id, 'loadplan', p.id, p.name, 'Ladeplan manuell angepasst', `${label} ${texts[action]}`);
      return getPlan(p.id);
    });
  }

  // ------------------------------------------------------------------ Lieferungen
  function assign(user, id, body) {
    return mutate(() => {
      const p = getPlanRaw(id);
      if (!p.result) throw bad('Bitte zuerst den Ladeplan berechnen.');
      const key = str(body.space_key, 20);
      const space = p.result.spaces.find((s) => s.key === key);
      if (!space) throw notFound('Laderaum nicht gefunden.');
      let deliveryId = null;
      if (body.create) {
        const d = domain.createDelivery(user, p.project_id, { note: `Ladeplan „${p.name}“ – ${space.name}` });
        deliveryId = d.id;
      } else if (body.delivery_id) {
        const d = domain.getDeliveryRaw(body.delivery_id);
        if (d.project_id !== p.project_id) throw bad('Die Lieferung gehört zu einem anderen Projekt.');
        deliveryId = d.id;
      }
      const assignments = { ...p.assignments };
      for (const [k, v] of Object.entries(assignments)) if (v === deliveryId && k !== key) delete assignments[k];
      if (deliveryId) assignments[key] = deliveryId; else delete assignments[key];
      db.prepare('UPDATE load_plans SET assignments = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(assignments), U.now(), p.id);
      log(user, p.project_id, 'loadplan', p.id, p.name, deliveryId ? 'Laderaum einer Lieferung zugeordnet' : 'Lieferungszuordnung entfernt', space.name);
      return getPlan(p.id);
    });
  }

  /** Ladeplan-Laderaum zu einer Lieferung (für die Verladung per Scan) */
  function planForDelivery(deliveryId) {
    const d = domain.getDeliveryRaw(deliveryId);
    const rows = db.prepare('SELECT id FROM load_plans WHERE project_id = ? ORDER BY updated_at DESC').all(d.project_id);
    for (const r of rows) {
      const p = getPlanRaw(r.id);
      const key = Object.keys(p.assignments).find((k) => p.assignments[k] === d.id);
      if (!key || !p.result) continue;
      const idx = p.result.spaces.findIndex((s) => s.key === key);
      if (idx < 0) continue;
      const space = p.result.spaces[idx];
      const def = p.result.space_defs[idx];
      const loaded = new Set(db.prepare('SELECT id FROM handling_units WHERE delivery_id = ?').all(d.id).map((x) => x.id));
      const pieces = {};
      for (const pl of space.placements) pieces[pl.piece_id] = p.result.pieces[pl.piece_id];
      return {
        plan_id: p.id, plan_name: p.name, stale: !!p.stale, space_key: key, space_def: def, space, pieces,
        loaded_piece_ids: space.placements.filter((pl) => pieces[pl.piece_id].hu_id && loaded.has(pieces[pl.piece_id].hu_id)).map((pl) => pl.piece_id),
      };
    }
    return null;
  }

  return {
    listTypes, getType, saveType, deleteType,
    listPlans, createPlan, getPlan, updatePlan, deletePlan,
    addItems, updateItem, deleteItem, importItems,
    calculate, edit, assign, planForDelivery,
  };
}

module.exports = { createLoadplanDomain };
