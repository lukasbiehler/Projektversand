'use strict';
// API-Tests der Ladeplanung

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');

let server; let base; let ctx; let dataDir;
const S = {};

async function call(method, url, body) {
  const opts = { method, headers: { 'X-User': 'Planer' } };
  if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(base + url, opts);
  return { status: res.status, data: await res.json() };
}
const ok = async (m, u, b) => { const r = await call(m, u, b); assert.ok(r.status < 300, `${m} ${u} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const fails = async (m, u, b, status, rx) => { const r = await call(m, u, b); assert.equal(r.status, status, JSON.stringify(r.data)); if (rx) assert.match(r.data.error, rx); return r.data; };

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-lp-'));
  ctx = createApp({ dataDir });
  server = http.createServer(ctx.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { ctx.close(); await new Promise((r) => server.close(r)); ctx.db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('Fahrzeugtypen: Vorlagen, eigener Typ, Validierung', async () => {
  const types = await ok('GET', '/vehicle-types');
  assert.ok(types.length >= 10);
  S.trailer = types.find((t) => t.name === 'Sattelauflieger Plane 13,60 m');
  S.c20 = types.find((t) => t.name === "20' Standard-Container");
  assert.ok(S.trailer && S.c20);
  await fails('POST', '/vehicle-types', { name: 'X', length_cm: 500, width_cm: 200, height_cm: 200, axle_front_x_cm: 100 }, 400, /beide Abstützpunkte/);
  await fails('POST', '/vehicle-types', { name: 'X', length_cm: 500, width_cm: 200, height_cm: 200, axle_front_x_cm: 300, axle_rear_x_cm: 100 }, 400, /hinter dem vorderen/);
  const own = await ok('POST', '/vehicle-types', { name: 'Werks-LKW', category: 'LKW', length_cm: 700, width_cm: 240, height_cm: 250, max_payload_kg: 8000 });
  assert.equal(own.builtin, 0);
  await ok('DELETE', `/vehicle-types/${own.id}`);
});

test('Ladeplan aus Packstücken berechnen', async () => {
  const p = await ok('POST', '/projects', { number: 'P-7', name: 'Test' });
  S.pid = p.id;
  const mk = async (type, l, w, hgt, kg, extra = {}) => {
    const hu = await ok('POST', `/projects/${p.id}/hus`, { packaging_type: type, length_cm: l, width_cm: w, height_cm: hgt, gross_kg: kg, ...extra });
    return hu;
  };
  S.hus = [];
  for (let i = 0; i < 6; i++) S.hus.push(await mk('KISTE', 240, 120, 110, 900));
  S.hus.push(await mk('GROSSCOLLI', 600, 240, 250, 8000, { stackable: false, rotatable: false }));
  S.hus.push(await mk('PALETTE', 120, 80, 90, 300, { max_top_load_kg: 0 }));
  S.noDims = await ok('POST', `/projects/${p.id}/hus`, { packaging_type: 'KARTON' });
  const plan = await ok('POST', `/projects/${p.id}/loadplans`, { name: 'Versand KW 40', vehicle_type_id: S.trailer.id, add_hus: 'open' });
  S.plan = plan.id;
  assert.equal(plan.items.length, 9);
  assert.deepEqual(plan.items.find((i) => i.hu_id === S.noDims.id).problems, ['Abmessungen fehlen', 'Gewicht fehlt']);
  assert.equal(plan.stale, true);
  const calc = await ok('POST', `/loadplans/${plan.id}/calculate`);
  assert.equal(calc.stale, false);
  const r = calc.result;
  assert.equal(r.excluded.length, 1, 'Packstück ohne Maße ausgeschlossen');
  assert.equal(r.unplaced.length, 0);
  const placedIds = r.spaces.flatMap((s) => s.placements.map((pl) => pl.piece_id));
  assert.equal(placedIds.length, 8);
  const colli = r.spaces.flatMap((s) => s.placements).find((pl) => r.pieces[pl.piece_id].hu_id === S.hus[6].id);
  assert.equal(colli.z, 0, 'nicht stapelbar → trotzdem am Boden');
  assert.equal(colli.rotated, false, 'darf nicht gedreht werden');
  // Nichts liegt auf der Palette mit Auflast 0
  const pal = r.spaces.flatMap((s) => s.placements).find((pl) => r.pieces[pl.piece_id].hu_id === S.hus[7].id);
  const onTop = r.spaces.flatMap((s) => s.placements).filter((pl) => Math.abs(pl.z - (pal.z + pal.dz)) < 0.01
    && pl.x < pal.x + pal.dx && pl.x + pl.dx > pal.x && pl.y < pal.y + pal.dy && pl.y + pl.dy > pal.y);
  assert.equal(onTop.length, 0);
  const st = r.spaces[0].stats;
  assert.ok(st.weight_kg <= 24000 && st.axle && !st.axle.front_over && !st.axle.rear_over, JSON.stringify(st));
  S.result = r;
});

test('Änderungen machen den Plan veraltet; Packstück-Eigenschaften über den Plan', async () => {
  let plan = await ok('GET', `/loadplans/${S.plan}`);
  const item = plan.items.find((i) => i.hu_id === S.hus[0].id);
  plan = await ok('PUT', `/loadplan-items/${item.id}`, { stackable: false, stop: 2 });
  assert.equal(plan.stale, true);
  const hu = await ok('GET', `/hus/${S.hus[0].id}`);
  assert.equal(hu.hu.stackable, 0, 'Eigenschaft am Packstück gespeichert');
  await fails('POST', `/loadplans/${S.plan}/edit`, { action: 'drop', piece_id: `I${item.id}-1` }, 400, /neu berechnen/);
  plan = await ok('POST', `/loadplans/${S.plan}/calculate`);
  assert.equal(plan.stale, false);
  // HU-Maße nachträglich geändert → Plan gilt als veraltet
  await ok('PUT', `/hus/${S.hus[1].id}`, { height_cm: 115 });
  plan = await ok('GET', `/loadplans/${S.plan}`);
  assert.equal(plan.changed_since_calc, true);
  plan = await ok('POST', `/loadplans/${S.plan}/calculate`);
  assert.equal(plan.stale, false);
  S.result = plan.result;
});

test('Manuelle Korrektur: verschieben, drehen, entfernen, platzieren – nur zulässige Lagen', async () => {
  const r = S.result;
  const sp = r.spaces[0];
  const a = sp.placements[0];
  const b = sp.placements[1];
  // In ein anderes Teil schieben → abgelehnt
  await fails('POST', `/loadplans/${S.plan}/edit`, { action: 'move', piece_id: a.piece_id, x: b.x, y: b.y, z: b.z }, 400, /Nicht zulässig/);
  // Über die Laderaumgrenze → abgelehnt
  await fails('POST', `/loadplans/${S.plan}/edit`, { action: 'move', piece_id: a.piece_id, x: 1350 }, 400, /ragt über/);
  // Entfernen und automatisch wieder platzieren
  let plan = await ok('POST', `/loadplans/${S.plan}/edit`, { action: 'remove', piece_id: a.piece_id });
  assert.ok(plan.result.unplaced.some((u) => u.piece_id === a.piece_id));
  plan = await ok('POST', `/loadplans/${S.plan}/edit`, { action: 'place', piece_id: a.piece_id, space_key: sp.key });
  assert.ok(!plan.result.unplaced.some((u) => u.piece_id === a.piece_id));
  assert.ok(plan.result.spaces[0].placements.some((pl) => pl.piece_id === a.piece_id));
  // Großcolli darf nicht gedreht werden
  const colliPiece = Object.values(plan.result.pieces).find((pc) => pc.hu_id === S.hus[6].id);
  await fails('POST', `/loadplans/${S.plan}/edit`, { action: 'rotate', piece_id: colliPiece.id }, 400, /nicht gedreht/);
  // Schritte sind lückenlos nummeriert
  const steps = plan.result.spaces[0].placements.map((pl) => pl.step);
  assert.deepEqual(steps, steps.map((_, i) => i + 1));
});

test('Laderaum einer Lieferung zuordnen – Verladung zeigt den Ladeplan', async () => {
  let plan = await ok('POST', `/loadplans/${S.plan}/assign`, { space_key: S.result.spaces[0].key, create: true });
  const did = plan.assignments[S.result.spaces[0].key];
  assert.ok(did);
  assert.equal(plan.deliveries[S.result.spaces[0].key].status, 'GEPLANT');
  // Ein Packstück versandbereit machen und verladen
  const hu = S.hus[7];
  const box = await ok('POST', `/projects/${S.pid}/items`, { material_number: 'M-1', description: 'Teil', qty_required: 1 });
  await ok('POST', `/hus/${hu.id}/pack`, { pack_item_id: box.id, qty: 1 });
  await ok('POST', `/hus/${hu.id}/action`, { action: 'close' });
  await ok('POST', `/hus/${hu.id}/action`, { action: 'ready' });
  await ok('POST', `/deliveries/${did}/load`, { hu_id: hu.id });
  const d = await ok('GET', `/deliveries/${did}`);
  assert.ok(d.loadplan, 'Ladeplan an der Lieferung');
  assert.equal(d.loadplan.plan_id, S.plan);
  const piece = Object.values(d.loadplan.pieces).find((pc) => pc.hu_id === hu.id);
  assert.ok(d.loadplan.loaded_piece_ids.includes(piece.id));
  plan = await ok('POST', `/loadplans/${S.plan}/assign`, { space_key: S.result.spaces[0].key, delivery_id: null });
  assert.equal(Object.keys(plan.assignments).length, 0);
});

test('Manuelles Ladegut und Excel-Import', async () => {
  await fails('POST', `/loadplans/${S.plan}/items`, { name: 'Kiste', length_cm: 0, width_cm: 10, height_cm: 10 }, 400, /Länge/);
  let res = await ok('POST', `/loadplans/${S.plan}/items`, { name: 'Europalette', length_cm: 120, width_cm: 80, height_cm: 100, weight_kg: 250, qty: 10, stop: 1 });
  assert.equal(res.plan.items.filter((i) => !i.hu_id).length, 1);
  const dry = await ok('POST', `/loadplans/${S.plan}/items/import`, { dry_run: true, rows: [
    { row_no: 2, name: 'Gitterbox', length_cm: '124', width_cm: '83,5', height_cm: '97', weight_kg: '85', qty: '4', stackable: 'ja', rotatable: 'nein' },
    { row_no: 3, name: 'Kaputt', length_cm: 'abc', width_cm: '10', height_cm: '10' },
  ] });
  assert.equal(dry.summary.new, 1);
  assert.equal(dry.summary.errors, 1);
  res = await ok('POST', `/loadplans/${S.plan}/items/import`, { skip_errors: true, rows: [
    { row_no: 2, name: 'Gitterbox', length_cm: '124', width_cm: '83,5', height_cm: '97', weight_kg: '85', qty: '4', stackable: 'ja', rotatable: 'nein' },
  ] });
  const plan = await ok('POST', `/loadplans/${S.plan}/calculate`);
  const gb = plan.items.find((i) => i.name === 'Gitterbox');
  assert.equal(gb.width_cm, 83.5);
  assert.equal(gb.rotatable, 0);
  const pieces = Object.values(plan.result.pieces).filter((pc) => pc.item_id === gb.id);
  assert.equal(pieces.length, 4);
  const list = await ok('GET', `/projects/${S.pid}/loadplans`);
  assert.equal(list[0].pieces >= 22, true);
  await ok('DELETE', `/loadplans/${S.plan}`);
  await fails('GET', `/loadplans/${S.plan}`, undefined, 404);
});
