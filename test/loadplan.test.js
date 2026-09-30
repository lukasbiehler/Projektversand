'use strict';
// Tests des Beladungsalgorithmus mit unabhängiger Prüfung aller Regeln

const test = require('node:test');
const assert = require('node:assert/strict');
const LP = require('../server/loadplan');

const TRAILER = { name: 'Sattelauflieger', length_cm: 1360, width_cm: 245, height_cm: 270, max_payload_kg: 24000,
  axle_front_x_cm: 160, axle_rear_x_cm: 930, axle_front_empty_kg: 2200, axle_rear_empty_kg: 4800, axle_front_max_kg: 12000, axle_rear_max_kg: 24000 };
const C20 = { name: '20ft', length_cm: 589, width_cm: 235, height_cm: 239, max_payload_kg: 28000, cog_tolerance_pct: 10 };

/** Unabhängige Prüfung eines Ergebnisses (arbeitet mit cm-Werten aus dem Ergebnis) */
function verify(result, spaces, pieces, minSupport = 0.8) {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const seen = new Set();
  result.spaces.forEach((s, si) => {
    const v = spaces[si] || spaces[spaces.length - 1];
    const P = s.placements;
    let weight = 0;
    const loads = new Map(P.map((p) => [p.piece_id, 0]));
    for (const p of P) {
      assert.ok(!seen.has(p.piece_id), `Teil ${p.piece_id} doppelt verladen`);
      seen.add(p.piece_id);
      const src = byId.get(p.piece_id);
      weight += src.weight_kg;
      const dims = [p.dx, p.dy, p.dz].map((x) => Math.round(x * 10)).sort((a, b) => a - b).join();
      assert.equal(dims, [src.length_cm, src.width_cm, src.height_cm].map((x) => Math.round(x * 10)).sort((a, b) => a - b).join(), 'Maße unverändert');
      if (!src.tiltable) assert.equal(Math.round(p.dz * 10), Math.round(src.height_cm * 10), `${p.piece_id} darf nicht gekippt werden`);
      if (!src.rotatable && !src.tiltable) assert.equal(Math.round(p.dx * 10), Math.round(src.length_cm * 10), `${p.piece_id} darf nicht gedreht werden`);
      assert.ok(p.x >= 0 && p.y >= 0 && p.z >= 0, 'nicht negativ');
      assert.ok(p.x + p.dx <= v.length_cm + 1e-9 && p.y + p.dy <= v.width_cm + 1e-9 && p.z + p.dz <= v.height_cm + 1e-9, `${p.piece_id} innerhalb des Laderaums`);
      for (const q of P) {
        if (q === p) continue;
        const ov = p.x < q.x + q.dx - 1e-9 && p.x + p.dx > q.x + 1e-9 && p.y < q.y + q.dy - 1e-9 && p.y + p.dy > q.y + 1e-9 && p.z < q.z + q.dz - 1e-9 && p.z + p.dz > q.z + 1e-9;
        assert.ok(!ov, `${p.piece_id} überschneidet ${q.piece_id}`);
      }
      if (p.z > 0) {
        let area = 0;
        for (const q of P) {
          if (Math.abs(q.z + q.dz - p.z) > 1e-9) continue;
          const a = Math.max(0, Math.min(p.x + p.dx, q.x + q.dx) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.dy, q.y + q.dy) - Math.max(p.y, q.y));
          if (a > 0) { assert.ok(byId.get(q.piece_id).stackable, `${p.piece_id} liegt auf nicht stapelbarem ${q.piece_id}`); area += a; }
        }
        assert.ok(area + 1e-6 >= minSupport * p.dx * p.dy, `${p.piece_id} Auflage ${area / (p.dx * p.dy)}`);
      }
    }
    // Auflast (direkt und über Stapel) prüfen
    const sorted = [...P].sort((a, b) => b.z - a.z);
    const carried = new Map(P.map((p) => [p.piece_id, 0]));
    for (const p of sorted) {
      const total = byId.get(p.piece_id).weight_kg + carried.get(p.piece_id);
      if (p.z === 0) continue;
      const sups = P.filter((q) => Math.abs(q.z + q.dz - p.z) < 1e-9).map((q) => ({ q, a: Math.max(0, Math.min(p.x + p.dx, q.x + q.dx) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.dy, q.y + q.dy) - Math.max(p.y, q.y)) })).filter((s) => s.a > 0);
      const sum = sups.reduce((s, x) => s + x.a, 0);
      for (const s of sups) carried.set(s.q.piece_id, carried.get(s.q.piece_id) + (total * s.a) / sum);
    }
    for (const [id, load] of carried) {
      const max = byId.get(id).max_top_load_kg;
      if (max !== null && max !== undefined) assert.ok(load <= max + 1e-6, `Auflast ${id}: ${load} > ${max}`);
    }
    void loads;
    if (v.max_payload_kg) assert.ok(weight <= v.max_payload_kg + 1e-6, 'Nutzlast');
    // Reihenfolge: tragende Teile vor aufliegenden
    const stepOf = new Map(P.map((p) => [p.piece_id, p.step]));
    for (const p of P) {
      for (const q of P) {
        if (Math.abs(q.z + q.dz - p.z) < 1e-9 && p.z > 0) {
          const a = Math.max(0, Math.min(p.x + p.dx, q.x + q.dx) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.dy, q.y + q.dy) - Math.max(p.y, q.y));
          if (a > 0) assert.ok(stepOf.get(q.piece_id) < stepOf.get(p.piece_id), 'Beladereihenfolge');
        }
      }
    }
  });
  for (const u of result.unplaced) assert.ok(!seen.has(u.piece_id));
  assert.equal(seen.size + result.unplaced.length, pieces.length, 'jedes Teil verladen oder als nicht verladen gemeldet');
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('Bodenbelegung: 33 Europaletten im Sattelauflieger 13,60 m', () => {
  const pieces = Array.from({ length: 33 }, (_, i) => ({ id: `P${i}`, length_cm: 120, width_cm: 80, height_cm: 100, weight_kg: 500, stackable: false, rotatable: true, tiltable: false }));
  const r = LP.optimize([TRAILER], pieces, { balance: false });
  verify(r, [TRAILER], pieces);
  // 13,60 m × 2,45 m: 33 Europaletten (Standard-Bodenbelegung) – mindestens 32 muss die Heuristik schaffen
  assert.ok(r.spaces[0].placements.length >= 32, `nur ${r.spaces[0].placements.length} Paletten`);
});

test('Nicht stapelbar, Auflast, Drehen verboten, Kippen erlaubt – zufällige Ladungen', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r0 = rng(seed);
    const n = 10 + Math.floor(r0() * 50);
    const pieces = Array.from({ length: n }, (_, i) => ({
      id: `T${i}`,
      length_cm: 40 + Math.round(r0() * 260), width_cm: 40 + Math.round(r0() * 180), height_cm: 30 + Math.round(r0() * 180),
      weight_kg: Math.round(20 + r0() * 3000),
      stackable: r0() > 0.3, rotatable: r0() > 0.3, tiltable: r0() > 0.85,
      max_top_load_kg: r0() > 0.6 ? Math.round(r0() * 2000) : null,
    }));
    const r = LP.optimize([TRAILER, C20], pieces, { minSupport: 0.8 });
    verify(r, [TRAILER, C20], pieces);
  }
});

test('Entladestellen: spätere Entladung liegt vorne, strikte Trennung', () => {
  const pieces = [];
  for (let i = 0; i < 12; i++) pieces.push({ id: `A${i}`, length_cm: 120, width_cm: 100, height_cm: 120, weight_kg: 400, stackable: true, rotatable: true, stop: 1 });
  for (let i = 0; i < 12; i++) pieces.push({ id: `B${i}`, length_cm: 120, width_cm: 100, height_cm: 120, weight_kg: 400, stackable: true, rotatable: true, stop: 2 });
  const r = LP.optimize([TRAILER], pieces, { groupStrict: true, balance: false });
  verify(r, [TRAILER], pieces);
  const P = r.spaces[0].placements;
  const maxB = Math.max(...P.filter((p) => p.piece_id.startsWith('B')).map((p) => p.x + p.dx));
  const minA = Math.min(...P.filter((p) => p.piece_id.startsWith('A')).map((p) => p.x));
  assert.ok(minA >= maxB, 'Entladestelle 1 (zuerst entladen) liegt vollständig hinter Entladestelle 2');
});

test('Automatisch weitere Fahrzeuge, zu große und zu schwere Teile', () => {
  const pieces = Array.from({ length: 40 }, (_, i) => ({ id: `K${i}`, length_cm: 240, width_cm: 120, height_cm: 200, weight_kg: 2500, stackable: false, rotatable: true }));
  pieces.push({ id: 'XL', length_cm: 1500, width_cm: 200, height_cm: 200, weight_kg: 1000, stackable: false, rotatable: false });
  pieces.push({ id: 'SCHWER', length_cm: 200, width_cm: 200, height_cm: 200, weight_kg: 30000, stackable: false, rotatable: false });
  const r = LP.optimize([TRAILER], pieces, { autoAdd: TRAILER });
  verify(r, [TRAILER], pieces);
  const reasons = Object.fromEntries(r.unplaced.map((u) => [u.piece_id, u.reason]));
  assert.equal(reasons.XL, 'TOO_BIG');
  assert.equal(reasons.SCHWER, 'TOO_HEAVY');
  assert.equal(r.unplaced.length, 2, 'alle anderen Teile verladen');
  assert.ok(r.spaces.length >= 5, 'Nutzlast 24 t → 9 Kisten je Auflieger → 5 Fahrzeuge');
  for (const s of r.spaces) assert.ok(s.stats.weight_kg <= 24000);
});

test('Achslast: schwere Maschine wird so verschoben, dass Sattellast eingehalten wird', () => {
  const pieces = [{ id: 'M', length_cm: 300, width_cm: 240, height_cm: 250, weight_kg: 14000, stackable: false, rotatable: false }];
  const r = LP.optimize([TRAILER], pieces, { balance: true });
  verify(r, [TRAILER], pieces);
  const s = r.spaces[0];
  assert.ok(!s.stats.axle.front_over && !s.stats.axle.rear_over, JSON.stringify(s.stats.axle));
  assert.ok(s.shift_cm > 0, 'Ladung wurde verschoben');
  assert.ok(s.stats.warnings.some((w) => /hinter der Stirnwand/.test(w)));
  const noBal = LP.optimize([TRAILER], pieces, { balance: false });
  assert.ok(noBal.spaces[0].stats.axle.front_over, 'ohne Ausgleich wäre die Sattellast überschritten');
});

test('Container: Schwerpunktfenster ±10 %', () => {
  const pieces = [{ id: 'S', length_cm: 150, width_cm: 200, height_cm: 150, weight_kg: 10000, stackable: false, rotatable: false }];
  const r = LP.optimize([C20], pieces, { balance: true });
  assert.ok(Math.abs(r.spaces[0].stats.cog_dev_pct) <= 10, String(r.spaces[0].stats.cog_dev_pct));
});

test('Manuelle Prüfung erkennt Überschneidung, fehlende Auflage und Auflast', () => {
  const pieces = [
    { id: 'U', label: 'Unten', length_cm: 100, width_cm: 100, height_cm: 100, weight_kg: 100, stackable: true, rotatable: true, max_top_load_kg: 50 },
    { id: 'O', label: 'Oben', length_cm: 100, width_cm: 100, height_cm: 100, weight_kg: 80, stackable: true, rotatable: true },
  ];
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const sp = { ...C20, key: 'S1' };
  let { space, placed } = LP.restore(sp, [
    { piece_id: 'U', x: 0, y: 0, z: 0, dx: 100, dy: 100, dz: 100 },
    { piece_id: 'O', x: 0, y: 0, z: 100, dx: 100, dy: 100, dz: 100 },
  ], byId);
  assert.ok(LP.validate(space, placed, 0.8).some((e) => /Auflast/.test(e)));
  ({ space, placed } = LP.restore(sp, [
    { piece_id: 'U', x: 0, y: 0, z: 0, dx: 100, dy: 100, dz: 100 },
    { piece_id: 'O', x: 50, y: 0, z: 0, dx: 100, dy: 100, dz: 100 },
  ], byId));
  assert.ok(LP.validate(space, placed, 0.8).some((e) => /überschneidet/.test(e)));
  ({ space, placed } = LP.restore(sp, [
    { piece_id: 'U', x: 0, y: 0, z: 0, dx: 100, dy: 100, dz: 100 },
    { piece_id: 'O', x: 150, y: 0, z: 50, dx: 100, dy: 100, dz: 100 },
  ], byId));
  assert.ok(LP.validate(space, placed, 0.8).some((e) => /nicht ausreichend auf/.test(e)));
  assert.equal(LP.dropZ(placed, placed[1]), 0);
});
