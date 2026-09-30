'use strict';
// Ladeplanung: 3D-Beladungsoptimierung für LKW, Auflieger und Container
//
// Koordinaten je Laderaum (intern in Millimetern, ganzzahlig):
//   x = Länge ab Stirnwand (Fahrerhaus-Seite, x = 0) bis Tür/Heck
//   y = Breite ab linker Seitenwand
//   z = Höhe ab Ladeboden
//
// Verfahren: Extreme-Point-Heuristik (Crainic/Perboli/Tadei) mit mehreren Sortier- und Bewertungsstrategien;
// die beste gültige Lösung wird gewählt. Berücksichtigt werden: Laderaummaße, Nutzlast, Drehen/Kippen je Teil,
// Stapelbarkeit, maximale Auflast (inkl. Weitergabe durch Stapel), Mindest-Auflagefläche, Gruppen nach
// Entladestelle (später entladene Gruppen vorne), Achslasten bzw. Schwerpunktfenster (Längsverschiebung).

const MM = (cm) => Math.round(Number(cm) * 10);
const CM = (mm) => Math.round(mm) / 10;
const EPS = 1e-6;

const REASONS = {
  TOO_BIG: 'Maße passen in keiner zulässigen Lage in den Laderaum',
  TOO_HEAVY: 'Gewicht überschreitet die Nutzlast des Laderaums',
  PAYLOAD: 'Nutzlast des Laderaums erreicht',
  NO_SPACE: 'Kein passender freier Platz mehr (Laderaum voll)',
};

/** Laderaum aus Fahrzeugtyp (cm/kg) in interne Darstellung (mm) */
function toSpace(v, key) {
  const axle = v.axle_front_x_cm !== null && v.axle_front_x_cm !== undefined && v.axle_rear_x_cm !== null && v.axle_rear_x_cm !== undefined
    && Number(v.axle_rear_x_cm) !== Number(v.axle_front_x_cm)
    ? {
      a: MM(v.axle_front_x_cm), b: MM(v.axle_rear_x_cm),
      emptyA: Number(v.axle_front_empty_kg) || 0, emptyB: Number(v.axle_rear_empty_kg) || 0,
      maxA: v.axle_front_max_kg === null || v.axle_front_max_kg === undefined ? null : Number(v.axle_front_max_kg),
      maxB: v.axle_rear_max_kg === null || v.axle_rear_max_kg === undefined ? null : Number(v.axle_rear_max_kg),
    }
    : null;
  return {
    key,
    name: v.name,
    type_id: v.id ?? v.type_id ?? null,
    category: v.category || '',
    L: MM(v.length_cm), W: MM(v.width_cm), H: MM(v.height_cm),
    maxPayload: v.max_payload_kg === null || v.max_payload_kg === undefined ? null : Number(v.max_payload_kg),
    axle,
    cogTol: v.cog_tolerance_pct === null || v.cog_tolerance_pct === undefined ? null : Number(v.cog_tolerance_pct),
  };
}

/** Ladeteil (cm/kg) in interne Darstellung */
function toPiece(p) {
  return {
    id: p.id,
    l: MM(p.length_cm), w: MM(p.width_cm), h: MM(p.height_cm),
    weight: Number(p.weight_kg) || 0,
    stackable: !!p.stackable,
    rotatable: !!p.rotatable,
    tiltable: !!p.tiltable,
    maxTop: p.max_top_load_kg === null || p.max_top_load_kg === undefined || p.max_top_load_kg === '' ? null : Number(p.max_top_load_kg),
    stop: Number(p.stop) || 1,
  };
}

function orientations(pc) {
  const { l, w, h } = pc;
  const list = [[l, w, h]];
  if (pc.rotatable || pc.tiltable) list.push([w, l, h]);
  if (pc.tiltable) list.push([l, h, w], [h, l, w], [w, h, l], [h, w, l]);
  const seen = new Set();
  return list.filter((o) => { const k = o.join('x'); if (seen.has(k)) return false; seen.add(k); return true; });
}

const overlap1 = (a, da, b, db) => Math.max(0, Math.min(a + da, b + db) - Math.max(a, b));

function collides(box, placed) {
  for (const b of placed) {
    if (box.x < b.x + b.dx && box.x + box.dx > b.x && box.y < b.y + b.dy && box.y + box.dy > b.y && box.z < b.z + b.dz && box.z + box.dz > b.z) return true;
  }
  return false;
}

/**
 * Auflage prüfen: Mindest-Auflagefläche, nur auf stapelbaren Teilen, maximale Auflast (auch indirekt über Stapel).
 * Liefert { supporters: [{b, f}], inc: Map } oder null.
 */
function checkSupport(box, weight, placed, minSupport) {
  if (box.z === 0) return { supporters: [], inc: new Map() };
  const base = box.dx * box.dy;
  let area = 0;
  const sups = [];
  for (const b of placed) {
    if (b.z + b.dz !== box.z) continue;
    const a = overlap1(box.x, box.dx, b.x, b.dx) * overlap1(box.y, box.dy, b.y, b.dy);
    if (a <= 0) continue;
    if (!b.pc.stackable) return null;
    area += a;
    sups.push({ b, a });
  }
  if (area + EPS < minSupport * base) return null;
  const supporters = sups.map((s) => ({ b: s.b, f: s.a / area }));
  const inc = new Map();
  const propagate = (list, w) => {
    for (const { b, f } of list) {
      const add = w * f;
      inc.set(b, (inc.get(b) || 0) + add);
      propagate(b.supporters, add);
    }
  };
  propagate(supporters, weight);
  for (const [b, add] of inc) {
    if (b.pc.maxTop !== null && b.load + add > b.pc.maxTop + EPS) return null;
  }
  return { supporters, inc };
}

function insideBox(p, b) {
  return p.x >= b.x && p.x < b.x + b.dx && p.y >= b.y && p.y < b.y + b.dy && p.z >= b.z && p.z < b.z + b.dz;
}

function projZ(p, placed) {
  let z = 0;
  for (const b of placed) {
    const top = b.z + b.dz;
    if (top <= p.z && top > z && p.x >= b.x && p.x < b.x + b.dx && p.y >= b.y && p.y < b.y + b.dy) z = top;
  }
  return { x: p.x, y: p.y, z };
}
function projY(p, placed) {
  let y = 0;
  for (const b of placed) {
    const e = b.y + b.dy;
    if (e <= p.y && e > y && p.x >= b.x && p.x < b.x + b.dx && p.z >= b.z && p.z < b.z + b.dz) y = e;
  }
  return { x: p.x, y, z: p.z };
}
function projX(p, placed) {
  let x = 0;
  for (const b of placed) {
    const e = b.x + b.dx;
    if (e <= p.x && e > x && p.y >= b.y && p.y < b.y + b.dy && p.z >= b.z && p.z < b.z + b.dz) x = e;
  }
  return { x, y: p.y, z: p.z };
}

/** Kandidatenpunkte (Extreme Points) aus allen platzierten Teilen neu aufbauen */
function buildPoints(space, placed) {
  const pts = new Map();
  const add = (p) => {
    if (p.x >= space.L || p.y >= space.W || p.z >= space.H) return;
    const k = `${p.x},${p.y},${p.z}`;
    if (!pts.has(k)) pts.set(k, p);
  };
  add({ x: 0, y: 0, z: 0 });
  for (const b of placed) {
    const px = { x: b.x + b.dx, y: b.y, z: b.z };
    const py = { x: b.x, y: b.y + b.dy, z: b.z };
    const pz = { x: b.x, y: b.y, z: b.z + b.dz };
    add(px); add(projY(px, placed)); add(projZ(px, placed));
    add(py); add(projX(py, placed)); add(projZ(py, placed));
    add(pz); add(projX(pz, placed)); add(projY(pz, placed));
  }
  return [...pts.values()].filter((p) => !placed.some((b) => insideBox(p, b)));
}

const SCORINGS = {
  // Wandweise von der Stirnwand zur Tür füllen (günstig für Beladereihenfolge und Gruppen)
  front: (b) => [b.x, b.z, b.y],
  // Erst den Boden füllen, dann stapeln (schwere Teile unten)
  floor: (b) => [b.z, b.x, b.y],
};

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

function commit(space, state, pc, box, sup) {
  const placedBox = { ...box, pc, load: 0, supporters: sup.supporters };
  for (const [b, add] of sup.inc) b.load += add;
  state.placed.push(placedBox);
  state.weight += pc.weight;
  state.points = buildPointsIncremental(space, state.points, placedBox, state.placed);
  return placedBox;
}

function buildPointsIncremental(space, points, b, placed) {
  const map = new Map(points.map((p) => [`${p.x},${p.y},${p.z}`, p]));
  const add = (p) => {
    if (p.x >= space.L || p.y >= space.W || p.z >= space.H) return;
    const k = `${p.x},${p.y},${p.z}`;
    if (!map.has(k)) map.set(k, p);
  };
  const px = { x: b.x + b.dx, y: b.y, z: b.z };
  const py = { x: b.x, y: b.y + b.dy, z: b.z };
  const pz = { x: b.x, y: b.y, z: b.z + b.dz };
  add(px); add(projY(px, placed)); add(projZ(px, placed));
  add(py); add(projX(py, placed)); add(projZ(py, placed));
  add(pz); add(projX(pz, placed)); add(projY(pz, placed));
  return [...map.values()].filter((p) => !insideBox(p, b));
}

/** Bestmögliche Position für ein Teil im aktuellen Zustand suchen */
function findPosition(space, state, pc, opts, scoring, frontier = 0, limit = Infinity) {
  let best = null;
  const orients = orientations(pc);
  for (const p of state.points) {
    if (p.x < frontier) continue;
    for (const [dx, dy, dz] of orients) {
      if (p.x + dx > space.L || p.y + dy > space.W || p.z + dz > space.H) continue;
      // Kandidaten: am Punkt sowie bündig an der rechten Seitenwand (füllt Restbreiten besser)
      if (p.x + dx > limit) continue;
      const ys = p.y + dy < space.W ? [p.y, space.W - dy] : [p.y];
      for (const y of ys) {
        const box = { x: p.x, y, z: p.z, dx, dy, dz };
        if (collides(box, state.placed)) continue;
        const sup = checkSupport(box, pc.weight, state.placed, opts.minSupport);
        if (!sup) continue;
        const key = scoring(box);
        if (!best || lexLess(key, best.key)) best = { box, key, sup };
      }
    }
  }
  return best;
}

function fitsEmpty(space, pc) {
  return orientations(pc).some(([dx, dy, dz]) => dx <= space.L && dy <= space.W && dz <= space.H);
}

/** Einen Laderaum mit den Teilen (in gegebener Reihenfolge) befüllen */
function packSpace(space, pieces, opts, scoring) {
  const state = { placed: [], points: [{ x: 0, y: 0, z: 0 }], weight: 0 };
  const unplaced = [];
  let frontier = 0;
  let currentStop = null;
  for (const pc of pieces) {
    if (opts.groupStrict && pc.stop !== currentStop) {
      if (currentStop !== null) frontier = state.placed.reduce((m, b) => Math.max(m, b.x + b.dx), frontier);
      currentStop = pc.stop;
    }
    if (!fitsEmpty(space, pc)) { unplaced.push({ pc, reason: 'TOO_BIG' }); continue; }
    if (space.maxPayload !== null && pc.weight > space.maxPayload + EPS) { unplaced.push({ pc, reason: 'TOO_HEAVY' }); continue; }
    if (space.maxPayload !== null && state.weight + pc.weight > space.maxPayload + EPS) { unplaced.push({ pc, reason: 'PAYLOAD' }); continue; }
    const best = findPosition(space, state, pc, opts, scoring, frontier);
    if (!best) { unplaced.push({ pc, reason: 'NO_SPACE' }); continue; }
    commit(space, state, pc, best.box, best.sup);
  }
  return { state, unplaced };
}

// ------------------------------------------------------------------ Kennzahlen, Achslasten, Schwerpunkt
function spaceStats(space, placed) {
  const weight = placed.reduce((s, b) => s + b.pc.weight, 0);
  const vol = placed.reduce((s, b) => s + b.dx * b.dy * b.dz, 0);
  const spaceVol = space.L * space.W * space.H;
  const usedLen = placed.reduce((m, b) => Math.max(m, b.x + b.dx), 0);
  const floorArea = placed.filter((b) => b.z === 0).reduce((s, b) => s + b.dx * b.dy, 0);
  let cog = null;
  if (weight > 0) {
    const c = placed.reduce((a, b) => ({
      x: a.x + (b.x + b.dx / 2) * b.pc.weight, y: a.y + (b.y + b.dy / 2) * b.pc.weight, z: a.z + (b.z + b.dz / 2) * b.pc.weight,
    }), { x: 0, y: 0, z: 0 });
    cog = { x: c.x / weight, y: c.y / weight, z: c.z / weight };
  }
  const warnings = [];
  let axle = null;
  if (space.axle) {
    const { a, b, emptyA, emptyB, maxA, maxB } = space.axle;
    const rb = cog ? (weight * (cog.x - a)) / (b - a) : 0;
    const ra = weight - rb;
    const front = emptyA + ra;
    const rear = emptyB + rb;
    axle = {
      front_kg: Math.round(front), rear_kg: Math.round(rear), front_cargo_kg: Math.round(ra), rear_cargo_kg: Math.round(rb),
      front_max_kg: maxA, rear_max_kg: maxB,
      front_over: maxA !== null && front > maxA + 0.5, rear_over: maxB !== null && rear > maxB + 0.5,
      front_pct: maxA ? Math.round((front / maxA) * 1000) / 10 : null, rear_pct: maxB ? Math.round((rear / maxB) * 1000) / 10 : null,
    };
    if (axle.front_over) warnings.push(`Vordere Achse / Sattellast überschritten: ${axle.front_kg} kg von max. ${maxA} kg`);
    if (axle.rear_over) warnings.push(`Hintere Achse(n) überschritten: ${axle.rear_kg} kg von max. ${maxB} kg`);
    if (weight > 0 && ra < -0.5) warnings.push('Schwerpunkt liegt vor der vorderen Stützachse – Entlastung der Vorderachse, Lenkfähigkeit prüfen');
  }
  let cogDevPct = null;
  if (cog) {
    cogDevPct = Math.round(((cog.x - space.L / 2) / space.L) * 1000) / 10;
    if (space.cogTol !== null && Math.abs(cogDevPct) > space.cogTol + EPS) {
      warnings.push(`Längsschwerpunkt ${cogDevPct > 0 ? 'hinter' : 'vor'} der Mitte (${Math.abs(cogDevPct)} % der Länge, zulässig ±${space.cogTol} %)`);
    }
    const latDev = (cog.y - space.W / 2) / space.W;
    if (Math.abs(latDev) > 0.1) warnings.push(`Seitlicher Schwerpunkt ${Math.round(Math.abs(latDev) * 1000) / 10} % aus der Mitte nach ${latDev > 0 ? 'rechts' : 'links'} – einseitige Belastung`);
  }
  if (space.maxPayload !== null && weight > space.maxPayload + EPS) warnings.push(`Nutzlast überschritten: ${Math.round(weight)} kg von ${space.maxPayload} kg`);
  const minX = placed.length ? placed.reduce((m, b) => Math.min(m, b.x), Infinity) : 0;
  if (minX > 0) warnings.push(`Ladung beginnt ${CM(minX)} cm hinter der Stirnwand (Achslast / Schwerpunkt) – Freiraum vorne formschlüssig sichern.`);
  const right = cog ? cog.y / space.W : 0.5;
  return {
    count: placed.length,
    weight_kg: Math.round(weight * 10) / 10,
    payload_pct: space.maxPayload ? Math.round((weight / space.maxPayload) * 1000) / 10 : null,
    volume_m3: Math.round(vol / 1e7) / 100,
    space_volume_m3: Math.round(spaceVol / 1e7) / 100,
    volume_pct: spaceVol ? Math.round((vol / spaceVol) * 1000) / 10 : 0,
    floor_pct: Math.round((floorArea / (space.L * space.W)) * 1000) / 10,
    used_length_cm: CM(usedLen),
    loading_meters: Math.round((usedLen / 1000) * (space.W / 2400) * 100) / 100,
    free_length_cm: CM(space.L - usedLen),
    cog: cog ? { x_cm: CM(cog.x), y_cm: CM(cog.y), z_cm: CM(cog.z) } : null,
    cog_dev_pct: cogDevPct,
    left_pct: Math.round((1 - right) * 1000) / 10,
    right_pct: Math.round(right * 1000) / 10,
    axle,
    warnings,
    violation: violationOf(space, placed),
  };
}

/** Summe der Überschreitungen (kg bzw. %-Punkte) – 0 = alles zulässig */
function violationOf(space, placed) {
  const weight = placed.reduce((s, b) => s + b.pc.weight, 0);
  if (weight <= 0) return 0;
  const cx = placed.reduce((s, b) => s + (b.x + b.dx / 2) * b.pc.weight, 0) / weight;
  let v = 0;
  if (space.axle) {
    const { a, b, emptyA, emptyB, maxA, maxB } = space.axle;
    const rb = (weight * (cx - a)) / (b - a);
    const ra = weight - rb;
    if (maxA !== null) v += Math.max(0, emptyA + ra - maxA);
    if (maxB !== null) v += Math.max(0, emptyB + rb - maxB);
    if (ra < 0) v += -ra;
  }
  if (space.cogTol !== null) {
    const dev = Math.abs(((cx - space.L / 2) / space.L) * 100);
    v += Math.max(0, dev - space.cogTol) * 100;
  }
  return v;
}

/** Ladung längs verschieben, wenn dadurch Achslast-/Schwerpunkt-Verstöße sinken (Freiraum vorne ist zu sichern) */
function balance(space, placed) {
  if (!placed.length || (!space.axle && space.cogTol === null)) return 0;
  const base = violationOf(space, placed);
  if (base <= EPS) return 0;
  const usedLen = placed.reduce((m, b) => Math.max(m, b.x + b.dx), 0);
  const slack = space.L - usedLen;
  if (slack <= 0) return 0;
  let bestS = 0;
  let bestV = base;
  const step = 10; // 1 cm
  for (let s = step; s <= slack; s += step) {
    for (const b of placed) b.x += step;
    const v = violationOf(space, placed);
    if (v < bestV - EPS) { bestV = v; bestS = s; }
  }
  const back = slack - (slack % step) - bestS;
  for (const b of placed) b.x -= back;
  return bestS;
}

// ------------------------------------------------------------------ Beladereihenfolge
/** Reihenfolge: Stirnwand → Tür, unten → oben; Auflageteile immer vor den aufliegenden Teilen */
function sequence(placed) {
  const done = new Set();
  const order = [];
  const key = (b) => [Math.floor(b.x / 100), b.z, b.y, b.x];
  const remaining = new Set(placed);
  while (remaining.size) {
    let pick = null;
    for (const b of remaining) {
      if (!b.supporters.every((s) => done.has(s.b))) continue;
      if (!pick || lexLess(key(b), key(pick))) pick = b;
    }
    if (!pick) pick = [...remaining][0]; // Sicherheitsnetz (kann bei gültigen Plänen nicht auftreten)
    remaining.delete(pick);
    done.add(pick);
    order.push(pick);
  }
  return order;
}

/** Auflagebeziehungen und Auflasten für eine (z. B. manuell geänderte) Belegung neu bestimmen */
function rebuildSupports(placed) {
  const sorted = [...placed].sort((a, b) => a.z - b.z);
  for (const b of placed) { b.load = 0; b.supporters = []; }
  for (const b of sorted) {
    if (b.z === 0) continue;
    let area = 0;
    const sups = [];
    for (const o of placed) {
      if (o === b || o.z + o.dz !== b.z) continue;
      const a = overlap1(b.x, b.dx, o.x, o.dx) * overlap1(b.y, b.dy, o.y, o.dy);
      if (a > 0) { sups.push({ b: o, a }); area += a; }
    }
    b.supporters = area > 0 ? sups.map((s) => ({ b: s.b, f: s.a / area })) : [];
  }
  const propagate = (list, w) => { for (const { b, f } of list) { b.load += w * f; propagate(b.supporters, w * f); } };
  for (const b of placed) propagate(b.supporters, b.pc.weight);
}

/** Vollständige Prüfung einer Belegung (für manuelle Änderungen) */
function validate(space, placed, minSupport) {
  const errors = [];
  const label = (b) => b.pc.label || b.pc.id;
  rebuildSupports(placed);
  placed.forEach((b, i) => {
    if (b.x < 0 || b.y < 0 || b.z < 0 || b.x + b.dx > space.L || b.y + b.dy > space.W || b.z + b.dz > space.H) errors.push(`${label(b)} ragt über den Laderaum hinaus`);
    for (let j = 0; j < i; j++) {
      const o = placed[j];
      if (b.x < o.x + o.dx && b.x + b.dx > o.x && b.y < o.y + o.dy && b.y + b.dy > o.y && b.z < o.z + o.dz && b.z + b.dz > o.z) {
        errors.push(`${label(b)} überschneidet sich mit ${label(o)}`);
      }
    }
    if (b.z > 0) {
      let supArea = 0;
      for (const o of placed) {
        if (o === b || o.z + o.dz !== b.z) continue;
        supArea += overlap1(b.x, b.dx, o.x, o.dx) * overlap1(b.y, b.dy, o.y, o.dy);
      }
      if (supArea + EPS < minSupport * b.dx * b.dy) errors.push(`${label(b)} liegt nicht ausreichend auf (${Math.round((supArea / (b.dx * b.dy)) * 100)} % Auflage, mindestens ${Math.round(minSupport * 100)} %)`);
      for (const s of b.supporters) if (!s.b.pc.stackable) errors.push(`${label(b)} liegt auf ${label(s.b)}, das nicht stapelbar ist`);
    }
    if (b.pc.maxTop !== null && b.load > b.pc.maxTop + EPS) errors.push(`Auflast auf ${label(b)} zu hoch (${Math.round(b.load)} kg, max. ${b.pc.maxTop} kg)`);
  });
  const weight = placed.reduce((s, b) => s + b.pc.weight, 0);
  if (space.maxPayload !== null && weight > space.maxPayload + EPS) errors.push(`Nutzlast überschritten (${Math.round(weight)} kg von ${space.maxPayload} kg)`);
  return errors;
}

// ------------------------------------------------------------------ Gesamtoptimierung
const SORTS = {
  volume: (a, b) => b.l * b.w * b.h - a.l * a.w * a.h,
  base: (a, b) => b.l * b.w - a.l * a.w || b.h - a.h,
  weight: (a, b) => b.weight - a.weight || b.l * b.w * b.h - a.l * a.w * a.h,
  length: (a, b) => Math.max(b.l, b.w) - Math.max(a.l, a.w) || b.l * b.w - a.l * a.w,
  height: (a, b) => b.h - a.h || b.l * b.w - a.l * a.w,
  density: (a, b) => b.weight / (b.l * b.w * b.h || 1) - a.weight / (a.l * a.w * a.h || 1),
};

/**
 * spacesIn: Laderäume (Fahrzeugtypen, cm/kg), piecesIn: Teile (cm/kg), opts:
 *   minSupport (0..1), groupStrict (bool), balance (bool), autoAdd (Fahrzeugtyp oder null), maxSpaces
 */
function optimize(spacesIn, piecesIn, optsIn = {}) {
  const opts = {
    minSupport: Math.min(1, Math.max(0.3, optsIn.minSupport ?? 0.8)),
    groupStrict: optsIn.groupStrict !== false,
    balance: optsIn.balance !== false,
    maxSpaces: Math.min(Math.max(optsIn.maxSpaces || 30, 1), 60),
  };
  const baseSpaces = spacesIn.map((s, i) => toSpace(s, s.key || `S${i + 1}`));
  const template = optsIn.autoAdd ? toSpace(optsIn.autoAdd, 'AUTO') : null;
  const pieces = piecesIn.map((p) => ({ ...toPiece(p), label: p.label || String(p.id) }));
  const started = Date.now();
  const heavy = pieces.length > 400;
  const sortNames = heavy ? ['volume', 'weight'] : Object.keys(SORTS);
  const scoringNames = heavy ? ['front'] : Object.keys(SCORINGS);

  let best = null;
  for (const sortName of sortNames) {
    for (const scoringName of scoringNames) {
      // Gruppen: höchste Entladestelle zuerst laden (liegt vorne), innerhalb: Stapelbare vor nicht stapelbaren
      const ordered = [...pieces].sort((a, b) => b.stop - a.stop || Number(b.stackable) - Number(a.stackable) || SORTS[sortName](a, b) || String(a.id).localeCompare(String(b.id)));
      const run = runStrategy(baseSpaces, template, ordered, opts, SCORINGS[scoringName]);
      run.strategy = `${sortName}/${scoringName}`;
      if (!best || lexLess(run.score, best.score)) best = run;
      if (Date.now() - started > 20000) break;
    }
  }
  return finish(best, opts);
}

function runStrategy(baseSpaces, template, ordered, opts, scoring) {
  const results = [];
  let remaining = ordered;
  const spaces = baseSpaces.map((s) => ({ ...s }));
  let autoN = 0;
  for (let i = 0; ; i++) {
    if (i >= spaces.length) {
      if (!template || !remaining.length || spaces.length >= opts.maxSpaces) break;
      if (!remaining.some((pc) => fitsEmpty(template, pc) && (template.maxPayload === null || pc.weight <= template.maxPayload))) break;
      autoN += 1;
      spaces.push({ ...template, key: `AUTO${autoN}`, auto: true });
    }
    const space = spaces[i];
    const { state, unplaced } = packSpace(space, remaining, opts, scoring);
    results.push({ space, placed: state.placed });
    remaining = unplaced.map((u) => u.pc);
    if (!remaining.length && i >= baseSpaces.length - 1) {
      for (let j = i + 1; j < spaces.length; j++) results.push({ space: spaces[j], placed: [] });
      break;
    }
  }
  consolidate(results, opts);
  remaining = retryUnplaced(results, remaining, opts);
  for (let i = results.length - 1; i >= 0; i--) if (results[i].space.auto && !results[i].placed.length) results.splice(i, 1);
  for (const r of results) rebuildSupports(r.placed);
  // Gründe für nicht verladene Teile bestimmen
  const unplaced = remaining.map((pc) => {
    let reason = 'NO_SPACE';
    const all = results.map((r) => r.space);
    if (all.length && all.every((s) => !fitsEmpty(s, pc))) reason = 'TOO_BIG';
    else if (all.length && all.every((s) => s.maxPayload !== null && pc.weight > s.maxPayload)) reason = 'TOO_HEAVY';
    else if (all.some((s) => fitsEmpty(s, pc)) && results.every((r) => r.space.maxPayload !== null && r.placed.reduce((w, b) => w + b.pc.weight, 0) + pc.weight > r.space.maxPayload)) reason = 'PAYLOAD';
    return { pc, reason };
  });
  const used = results.filter((r) => r.placed.length).length;
  const placedVol = results.reduce((s, r) => s + r.placed.reduce((v, b) => v + b.dx * b.dy * b.dz, 0), 0);
  // Verstöße nach möglicher Längsverschiebung bewerten
  let violation = 0;
  for (const r of results) {
    r.shift = opts.balance ? balance(r.space, r.placed) : 0;
    violation += violationOf(r.space, r.placed);
  }
  const last = results.filter((r) => r.placed.length).at(-1);
  const lastLen = last ? last.placed.reduce((m, b) => Math.max(m, b.x + b.dx), 0) : 0;
  const cogDev = results.reduce((s, r) => {
    const w = r.placed.reduce((a, b) => a + b.pc.weight, 0);
    if (!w) return s;
    const cx = r.placed.reduce((a, b) => a + (b.x + b.dx / 2) * b.pc.weight, 0) / w;
    return s + Math.abs(cx - r.space.L / 2) / r.space.L;
  }, 0);
  return {
    results, unplaced,
    score: [unplaced.length, Math.round(violation), used, -placedVol, lastLen, cogDev],
  };
}

/** Versucht, Teile des letzten belegten (automatisch ergänzten) Laderaums in frühere Laderäume umzulagern */
function consolidate(results, opts) {
  for (let guard = 0; guard < 10; guard++) {
    const lastIdx = results.map((r, i) => (r.placed.length ? i : -1)).filter((i) => i >= 0).at(-1);
    if (lastIdx === undefined || lastIdx === 0 || !results[lastIdx].space.auto) return;
    const moving = [...results[lastIdx].placed].sort((a, b) => b.dx * b.dy * b.dz - a.dx * a.dy * a.dz);
    const targets = results.slice(0, lastIdx);
    const trial = targets.map((r) => r.placed.map((b) => ({ ...b })));
    let ok = true;
    for (const b of moving) {
      let done = false;
      for (let t = 0; t < targets.length && !done; t++) {
        const box = autoPlace(targets[t].space, trial[t], b.pc, opts.minSupport, opts.groupStrict);
        if (box) { trial[t].push(box); done = true; }
      }
      if (!done) { ok = false; break; }
    }
    if (!ok) return;
    targets.forEach((r, t) => { r.placed = trial[t]; });
    results[lastIdx].placed = [];
  }
}

/** Nicht verladene Teile nachträglich in freie Lücken setzen */
function retryUnplaced(results, remaining, opts) {
  const left = [];
  for (const pc of remaining) {
    let done = false;
    for (const r of results) {
      const box = autoPlace(r.space, r.placed, pc, opts.minSupport, opts.groupStrict);
      if (box) { r.placed.push(box); done = true; break; }
    }
    if (!done) left.push(pc);
  }
  return left;
}

function finish(run, opts) {
  const spaces = run.results.map((r) => {
    const order = sequence(r.placed);
    const stats = spaceStats(r.space, r.placed);
    return {
      key: r.space.key,
      auto: !!r.space.auto,
      name: r.space.name,
      shift_cm: CM(r.shift || 0),
      placements: order.map((b, i) => ({
        piece_id: b.pc.id, step: i + 1,
        x: CM(b.x), y: CM(b.y), z: CM(b.z), dx: CM(b.dx), dy: CM(b.dy), dz: CM(b.dz),
        rotated: b.dx !== b.pc.l || b.dy !== b.pc.w, tilted: b.dz !== b.pc.h,
      })),
      stats,
    };
  });
  return {
    strategy: run.strategy,
    options: { min_support: opts.minSupport, group_strict: opts.groupStrict, balance: opts.balance },
    spaces,
    unplaced: run.unplaced.map((u) => ({ piece_id: u.pc.id, reason: u.reason, reason_label: REASONS[u.reason] })),
  };
}

/** Belegung eines Laderaums aus gespeichertem Ergebnis wiederherstellen (für Prüfung / manuelle Änderung) */
function restore(spaceDef, placements, piecesById) {
  const space = toSpace(spaceDef, spaceDef.key);
  const placed = placements.map((p) => {
    const src = piecesById.get(p.piece_id);
    if (!src) throw new Error(`Teil ${p.piece_id} fehlt`);
    return { x: MM(p.x), y: MM(p.y), z: MM(p.z), dx: MM(p.dx), dy: MM(p.dy), dz: MM(p.dz), pc: { ...toPiece(src), label: src.label }, load: 0, supporters: [] };
  });
  return { space, placed };
}

/** Belegung zurück in das Ergebnisformat (mit neuer Reihenfolge und Kennzahlen) */
function serialize(space, placed, extra = {}) {
  rebuildSupports(placed);
  const order = sequence(placed);
  return {
    placements: order.map((b, i) => ({
      piece_id: b.pc.id, step: i + 1,
      x: CM(b.x), y: CM(b.y), z: CM(b.z), dx: CM(b.dx), dy: CM(b.dy), dz: CM(b.dz),
      rotated: b.dx !== b.pc.l || b.dy !== b.pc.w, tilted: b.dz !== b.pc.h,
    })),
    stats: { ...spaceStats(space, placed), ...extra },
  };
}

/** Ein einzelnes Teil automatisch an der besten freien Stelle platzieren */
function autoPlace(space, placed, pc, minSupport, groupStrict = false) {
  rebuildSupports(placed);
  const state = { placed, points: buildPoints(space, placed), weight: placed.reduce((s, b) => s + b.pc.weight, 0) };
  if (space.maxPayload !== null && state.weight + pc.weight > space.maxPayload + EPS) return null;
  if (!fitsEmpty(space, pc)) return null;
  let frontier = 0;
  let limit = Infinity;
  if (groupStrict) {
    // Später entladene Gruppen (höhere Entladestelle) liegen vorne, früher entladene dahinter
    for (const b of placed) {
      if (b.pc.stop > pc.stop) frontier = Math.max(frontier, b.x + b.dx);
      if (b.pc.stop < pc.stop) limit = Math.min(limit, b.x);
    }
  }
  const best = findPosition(space, state, pc, { minSupport }, SCORINGS.front, frontier, limit);
  if (!best) return null;
  return { ...best.box, pc, load: 0, supporters: [] };
}

/** Teil auf die nächste tragende Fläche absenken */
function dropZ(placed, box) {
  let z = 0;
  for (const o of placed) {
    if (o === box) continue;
    const top = o.z + o.dz;
    if (top <= box.z && top > z && overlap1(box.x, box.dx, o.x, o.dx) > 0 && overlap1(box.y, box.dy, o.y, o.dy) > 0) z = top;
  }
  return z;
}

module.exports = { optimize, restore, serialize, validate, autoPlace, dropZ, toSpace, toPiece, orientations, spaceStats, MM, CM, REASONS };
