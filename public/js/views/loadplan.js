// Ladeplanung: Laderäume wählen, Ladegut zusammenstellen, optimal beladen, in 3D prüfen, manuell anpassen, Bericht / Excel
import {
  h, append, get, post, put, del, state, btn, fmt, toast, formDialog, confirmDialog, modal, go, setScanHandler, showError,
  notifyChanged, onCleanup, loadScript, chip,
} from '../core.js';
import { loadThree, createViewer, colorFor } from '../viewer3d.js';
import { openImportWizard } from '../importer.js';
import { printNodes } from '../labels.js';

const ui = new Map(); // je Plan: gewählter Laderaum, Schritt, Auswahl, Kamera

export async function render(ctx) {
  const id = Number(ctx.params[0]);
  const [plan, types] = await Promise.all([get(`/loadplans/${id}`), get('/vehicle-types')]);
  ctx.projectId = plan.project.id;
  await loadThree();
  if (!ui.has(id)) ui.set(id, { space: 0, step: null, selected: null, camera: null });
  const u = ui.get(id);
  const res = plan.result;
  if (res && u.space >= res.spaces.length) u.space = 0;
  setScanHandler(null);

  const head = h('div', { class: 'stack' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projekte'), '›', h('a', { href: `#/p/${plan.project.id}` }, plan.project.number), '›',
      h('a', { href: `#/p/${plan.project.id}/loadplans` }, 'Ladeplanung'), '›', h('span', null, plan.name)),
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' },
        h('div', { class: 'row' }, h('h1', null, plan.name),
          !res ? h('span', { class: 'chip' }, 'Nicht berechnet') : plan.stale ? h('span', { class: 'chip s-FEHLTEIL' }, 'Veraltet – neu berechnen') : h('span', { class: 'chip s-VERSANDBEREIT' }, 'Berechnet')),
        h('p', { class: 'muted' }, res ? `Berechnet ${fmt.dt(plan.computed_at)}${res.computed_by ? ' von ' + res.computed_by : ''} · Strategie ${res.strategy}` : 'Laderaum wählen, Ladegut hinzufügen und „Optimal beladen“ klicken.')),
      h('div', { class: 'row' },
        btn('Optimal beladen', () => calculate(plan), { cls: 'primary big', icon: 'truck' }),
        res ? btn('Bericht drucken', () => reportDialog(plan), { icon: 'print' }) : null,
        res ? btn('Excel-Export', () => exportExcel(plan).catch(showError), { icon: 'upload' }) : null,
        btn('Umbenennen', () => formDialog({
          title: 'Ladeplan umbenennen', fields: [{ name: 'name', label: 'Bezeichnung', value: plan.name, required: true, autofocus: true }],
          onSubmit: async (v) => { await put(`/loadplans/${plan.id}`, { name: v.name }); },
        }), { cls: 'ghost' }),
        btn('Löschen', async () => {
          if (!(await confirmDialog(`Ladeplan „${plan.name}“ löschen?`, { ok: 'Löschen', danger: true }))) return;
          try { await del(`/loadplans/${plan.id}`); toast('Ladeplan gelöscht.', 'ok'); go(`#/p/${plan.project.id}/loadplans`); } catch (err) { showError(err); }
        }, { cls: 'ghost danger' }))));

  const left = h('div', { class: 'stack', style: { gap: '18px' } }, spacesPanel(plan, types), cargoPanel(plan));
  const right = h('div', { class: 'stack', style: { gap: '18px' } });
  if (res) right.append(resultPanel(plan, u, ctx));
  else right.append(h('section', { class: 'panel' }, h('div', { class: 'empty stack' },
    h('h2', null, 'Noch kein Ladeplan berechnet'),
    h('p', null, 'Die Optimierung ordnet alle Teile unter Beachtung von Maßen, Nutzlast, Stapelbarkeit, Drehbarkeit, maximaler Auflast, Entladestellen und Achslasten im Laderaum an. Reicht ein Fahrzeug nicht, werden bei Bedarf weitere Fahrzeuge desselben Typs ergänzt.'))));

  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } }, head, h('div', { class: 'lp-grid' }, left, right)));
}

async function calculate(plan) {
  try {
    const p = await post(`/loadplans/${plan.id}/calculate`);
    const r = p.result;
    const total = Object.keys(r.pieces).length;
    const used = r.spaces.filter((s) => s.placements.length).length;
    toast(`${total - r.unplaced.length} von ${total} Teilen in ${used} Laderaum/-räumen verladen${r.unplaced.length ? ` – ${r.unplaced.length} ${r.unplaced.length === 1 ? 'passt' : 'passen'} nicht` : ''}.`, r.unplaced.length ? 'warn' : 'ok', 6000);
    notifyChanged();
  } catch (err) { showError(err); }
}

// ================================================================== Laderäume & Einstellungen
function typeOptions(types, selected, empty) {
  const cats = state.meta.vehicle_categories;
  const groups = {};
  for (const t of types) (groups[t.category] ||= []).push(t);
  return [
    empty ? h('option', { value: '' }, empty) : null,
    Object.entries(groups).map(([c, list]) => h('optgroup', { label: cats[c] || c },
      list.map((t) => h('option', { value: String(t.id), selected: String(t.id) === String(selected) }, `${t.name} (${fmt.num(t.length_cm, 1)} × ${fmt.num(t.width_cm, 1)} × ${fmt.num(t.height_cm, 1)} cm)`)))),
  ];
}

function dimsText(s) {
  return `${fmt.num(s.length_cm, 1)} × ${fmt.num(s.width_cm, 1)} × ${fmt.num(s.height_cm, 1)} cm${s.max_payload_kg ? ` · Nutzlast ${fmt.num(s.max_payload_kg, 0)} kg` : ''}`;
}

function spacesPanel(plan, types) {
  const save = async (body, msg) => {
    try { await put(`/loadplans/${plan.id}`, body); if (msg) toast(msg, 'ok'); notifyChanged(); } catch (err) { showError(err); }
  };
  const keys = () => plan.spaces.map((s) => ({ key: s.key }));
  const addSel = h('select', { id: 'lp-add-type', 'data-nodirty': '1' }, typeOptions(types, types[0] && types[0].id));
  const autoSel = h('select', { id: 'lp-auto', 'data-nodirty': '1' }, typeOptions(types, plan.settings.auto_add_type_id, 'Aus – nur die gewählten Laderäume'));
  autoSel.value = plan.settings.auto_add_type_id ? String(plan.settings.auto_add_type_id) : '';
  autoSel.addEventListener('change', () => save({ settings: { auto_add_type_id: autoSel.value ? Number(autoSel.value) : null } }, 'Einstellung gespeichert.'));
  const support = h('input', { type: 'number', id: 'lp-support', min: 30, max: 100, step: 5, value: String(plan.settings.min_support_pct), 'data-nodirty': '1', style: { maxWidth: '90px' } });
  support.addEventListener('change', () => save({ settings: { min_support_pct: Number(support.value) } }, 'Einstellung gespeichert.'));
  const chk = (key, label, hint) => {
    const c = h('input', { type: 'checkbox', id: `lp-${key}`, checked: !!plan.settings[key], 'data-nodirty': '1' });
    c.addEventListener('change', () => save({ settings: { [key]: c.checked } }, 'Einstellung gespeichert.'));
    return h('label', { class: 'field inline' }, c, h('span', null, label, hint ? h('span', { class: 'hint', style: { display: 'block' } }, hint) : null));
  };
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Laderäume')),
    h('div', { class: 'panel-body' },
      plan.spaces.length ? h('div', { class: 'stack', style: { gap: '6px' } }, plan.spaces.map((s, i) => h('div', { class: 'row lp-space' },
        h('span', { class: 'tag' }, String(i + 1)),
        h('div', { style: { flex: '1 1 200px', minWidth: 0 } }, h('b', null, s.name), h('div', { class: 'hint' }, dimsText(s))),
        btn('Entfernen', () => save({ spaces: keys().filter((k) => k.key !== s.key) }, 'Laderaum entfernt.'), { cls: 'small ghost danger' }))))
        : h('p', { class: 'muted small' }, 'Noch kein Laderaum gewählt.'),
      h('div', { class: 'row' }, h('div', { style: { flex: '1 1 220px', minWidth: 0 } }, addSel),
        btn('Hinzufügen', () => save({ spaces: [...keys(), { type_id: Number(addSel.value) }] }, 'Laderaum hinzugefügt.'), { icon: 'plus' })),
      h('label', { class: 'field' }, 'Reicht der Platz nicht: weitere Fahrzeuge automatisch ergänzen', autoSel),
      h('div', { class: 'label-caps' }, 'Regeln'),
      h('label', { class: 'field inline' }, 'Mindest-Auflagefläche', support, '%'),
      chk('group_strict', 'Entladestellen strikt trennen', 'Später entladene Teile liegen vollständig vor früher entladenen (Heck zuerst entladen).'),
      chk('balance', 'Achslast / Schwerpunkt ausgleichen', 'Verschiebt die Ladung längs, falls sonst eine Achslast oder das Schwerpunktfenster überschritten wird.'),
      h('p', { class: 'hint' }, 'Fahrzeug- und Containertypen (Maße, Nutzlast, Achsmodell) unter Einstellungen pflegen. Vorlagen sind Richtwerte.')));
}

// ================================================================== Ladegut
function flagsText(i) {
  return [i.stackable ? 'stapelbar' : 'nicht stapelbar', i.tiltable ? 'kippbar' : i.rotatable ? 'drehbar' : 'nicht drehbar',
    i.max_top_load_kg !== null && i.max_top_load_kg !== undefined ? `Auflast ≤ ${fmt.num(i.max_top_load_kg, 0)} kg` : ''].filter(Boolean).join(' · ');
}

function cargoPanel(plan) {
  const count = plan.items.reduce((s, i) => s + i.qty, 0);
  const weight = plan.items.reduce((s, i) => s + (i.weight_kg || 0) * i.qty, 0);
  const volume = plan.items.reduce((s, i) => s + (i.length_cm && i.width_cm && i.height_cm ? (i.length_cm * i.width_cm * i.height_cm * i.qty) / 1e6 : 0), 0);
  const stops = new Set(plan.items.map((i) => i.stop));
  const table = plan.items.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Ladegut'), h('th', null, 'L × B × H'), h('th', { class: 'num' }, 'kg'), h('th', { class: 'num' }, 'Anz.'),
      stops.size > 1 || plan.items.some((i) => i.stop > 1) ? h('th', { class: 'num' }, 'Entl.') : null, h('th', null, ''))),
    h('tbody', null, plan.items.map((i) => h('tr', null,
      h('td', null,
        i.hu_id ? h('a', { href: `#/hu/${i.hu_id}`, class: 'mono' }, i.label) : h('b', null, i.name),
        i.sub ? h('div', { class: 'sub' }, i.sub) : null,
        h('div', { class: 'sub' }, flagsText(i)),
        i.problems.length ? h('div', { class: 'sub', style: { color: 'var(--s-miss-fg)' } }, `⚠ ${i.problems.join(', ')} – wird nicht eingeplant`) : null,
        i.delivery_number ? h('div', { class: 'sub' }, `bereits auf Lieferung ${i.delivery_number}`) : null),
      h('td', { class: 'small nowrap' }, i.length_cm ? `${fmt.num(i.length_cm, 1)} × ${fmt.num(i.width_cm, 1)} × ${fmt.num(i.height_cm, 1)}` : '–'),
      h('td', { class: 'num' }, i.weight_kg === null || i.weight_kg === undefined ? '–' : `${i.hu_id && !i.weight_complete ? 'ca. ' : ''}${fmt.num(i.weight_kg, 1)}`),
      h('td', { class: 'num' }, i.qty),
      stops.size > 1 || plan.items.some((x) => x.stop > 1) ? h('td', { class: 'num' }, i.stop) : null,
      h('td', { class: 'nowrap' },
        btn('Bearbeiten', () => itemDialog(plan, i), { cls: 'small ghost' }),
        btn('Entfernen', async () => {
          try { await del(`/loadplan-items/${i.id}`); notifyChanged(); } catch (err) { showError(err); }
        }, { cls: 'small ghost danger' }))))))) : h('p', { class: 'muted small' }, 'Noch kein Ladegut.');
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Ladegut (${count} Teile)`)),
    h('div', { class: 'panel-body' },
      h('div', { class: 'row' },
        btn('Packstücke einplanen', () => huDialog(plan), { icon: 'box', cls: 'primary' }),
        btn('Position', () => itemDialog(plan, null), { icon: 'plus' }),
        btn('Excel-Import', () => openImportWizard({ mode: 'cargo', planId: plan.id, onDone: () => notifyChanged() }), { icon: 'upload' })),
      h('p', { class: 'hint' }, `Summe ${fmt.kg(weight)} · ${fmt.num(volume, 2)} m³. Maße, Gewicht und Eigenschaften von Packstücken kommen immer aktuell aus der Packstückverwaltung.`)),
    h('div', { class: 'panel-body flush' }, table));
}

function huDialog(plan) {
  const list = plan.candidates;
  const boxes = new Map();
  const rows = list.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: c.dims_complete && ['VERSANDBEREIT', 'OFFEN'].includes(c.ship_status) && !c.delivery_number });
    boxes.set(c.id, cb);
    return h('tr', null, h('td', null, cb),
      h('td', null, h('span', { class: 'mono' }, c.package_number), h('div', { class: 'sub' }, `${c.packaging_label}${c.description ? ' · ' + c.description : ''}`)),
      h('td', { class: 'small nowrap' }, c.dims_complete ? `${fmt.num(c.length_cm, 1)} × ${fmt.num(c.width_cm, 1)} × ${fmt.num(c.height_cm, 1)} cm` : h('span', { style: { color: 'var(--s-miss-fg)' } }, 'Maße fehlen')),
      h('td', { class: 'num' }, c.gross_eff === null ? '–' : fmt.kg(c.gross_eff)),
      h('td', null, chip(c.status, c.status_label), c.delivery_number ? h('div', { class: 'sub' }, `Lieferung ${c.delivery_number}`) : null));
  });
  modal({
    title: 'Packstücke einplanen',
    wide: true,
    body: list.length ? [
      h('p', { class: 'hint' }, 'Äußere Packstücke des Projekts (enthaltene Packstücke reisen mit ihrem äußeren Packstück). Vorausgewählt: noch nicht verladene mit vollständigen Maßen.'),
      h('div', { class: 'row' },
        btn('Alle', () => { for (const cb of boxes.values()) cb.checked = true; }, { cls: 'small' }),
        btn('Keine', () => { for (const cb of boxes.values()) cb.checked = false; }, { cls: 'small' })),
      h('div', { class: 'table-wrap', style: { maxHeight: '55vh', overflow: 'auto' } }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Packstück'), h('th', null, 'Maße'), h('th', { class: 'num' }, 'Brutto'), h('th', null, 'Status'))),
        h('tbody', null, rows))),
    ] : h('p', null, 'Alle Packstücke des Projekts sind bereits eingeplant.'),
    actions: [
      { label: 'Abbrechen' },
      ...(list.length ? [{ label: 'Einplanen', cls: 'primary', onClick: async (close) => {
        const ids = [...boxes].filter(([, cb]) => cb.checked).map(([hid]) => hid);
        if (!ids.length) { toast('Bitte Packstücke auswählen.', 'warn'); return; }
        const r = await post(`/loadplans/${plan.id}/items`, { hu_ids: ids });
        toast(`${r.added} Packstück(e) eingeplant.`, 'ok');
        close();
        notifyChanged();
      } }] : []),
    ],
  });
}

function itemDialog(plan, item) {
  const isHu = item && item.hu_id;
  const flagFields = [
    { name: 'stackable', label: 'Stapelbar (andere Teile dürfen darauf)', type: 'checkbox', value: item ? !!item.stackable : true },
    { name: 'rotatable', label: 'Drehbar (90° auf der Grundfläche)', type: 'checkbox', value: item ? !!item.rotatable : true },
    { name: 'tiltable', label: 'Kippbar (darf auf jeder Seite liegen)', type: 'checkbox', value: item ? !!item.tiltable : false },
    { name: 'max_top_load_kg', label: 'Maximale Auflast (kg, leer = unbegrenzt)', type: 'number', step: 'any', min: 0, value: item ? item.max_top_load_kg : null },
    { name: 'stop', label: 'Entladestelle (1 = zuerst entladen)', type: 'number', min: 1, step: 1, value: item ? item.stop : 1, required: true },
  ];
  const fields = isHu ? flagFields : [
    { name: 'name', label: 'Bezeichnung', value: item ? item.name : '', required: true, autofocus: true, wide: true },
    { name: 'length_cm', label: 'Länge (cm)', type: 'number', step: 'any', min: 0, value: item ? item.length_cm : null, required: true },
    { name: 'width_cm', label: 'Breite (cm)', type: 'number', step: 'any', min: 0, value: item ? item.width_cm : null, required: true },
    { name: 'height_cm', label: 'Höhe (cm)', type: 'number', step: 'any', min: 0, value: item ? item.height_cm : null, required: true },
    { name: 'weight_kg', label: 'Gewicht je Teil (kg)', type: 'number', step: 'any', min: 0, value: item ? item.weight_kg : 0, required: true },
    { name: 'qty', label: 'Anzahl', type: 'number', min: 1, step: 1, value: item ? item.qty : 1, required: true },
    ...flagFields,
  ];
  formDialog({
    title: isHu ? `Packstück ${item.label}` : item ? `Ladegut ${item.name}` : 'Ladegut hinzufügen',
    intro: isHu ? h('p', { class: 'hint' }, 'Eigenschaften werden am Packstück gespeichert und gelten für alle Ladepläne. Maße und Gewicht bitte am Packstück pflegen.') : null,
    fields,
    submitLabel: item ? 'Speichern' : 'Hinzufügen',
    onSubmit: async (v) => {
      if (item) await put(`/loadplan-items/${item.id}`, v);
      else await post(`/loadplans/${plan.id}/items`, v);
    },
  });
}

// ================================================================== Ergebnis
function spaceDef(plan, i) {
  return plan.result.space_defs[i];
}

function resultPanel(plan, u, ctx) {
  const res = plan.result;
  const total = Object.keys(res.pieces).length;
  const byStop = new Set(Object.values(res.pieces).map((p) => p.stop)).size > 1;
  const sp = res.spaces[u.space];
  const def = spaceDef(plan, u.space);
  const st = sp.stats;
  const n = sp.placements.length;
  if (u.step !== null && u.step > n) u.step = null;

  // Laderaum-Reiter
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Laderäume' }, res.spaces.map((s, i) => h('a', {
    href: '#', class: i === u.space ? 'active' : '',
    onclick: (e) => { e.preventDefault(); u.space = i; u.step = null; u.selected = null; u.camera = null; ctx.refresh(); },
  }, `${i + 1}: ${s.name}`, h('span', { class: 'count muted' }, `(${s.placements.length})`), plan.deliveries[s.key] ? h('span', { class: 'count muted' }, ` · ${plan.deliveries[s.key].number}`) : null)));

  // 3D-Ansicht
  const box = h('div', { class: 'viewer3d' });
  const viewer = createViewer(box, {
    space: def, placements: sp.placements, pieces: res.pieces, byStop, cog: st.cog,
    onPick: (pid) => { u.selected = pid; viewer.setSelected(pid); renderSelection(); highlightRow(); },
  });
  onCleanup(() => { u.camera = viewer.getCamera(); viewer.dispose(); });
  if (u.camera) viewer.setCamera(u.camera);
  viewer.setStep(u.step ?? Infinity);
  viewer.setSelected(u.selected);

  const stepLabel = h('span', { class: 'mono small', style: { minWidth: '110px', textAlign: 'center' } });
  const slider = h('input', { type: 'range', min: 0, max: n, value: String(u.step ?? n), id: 'lp-step', 'data-nodirty': '1', style: { flex: '1 1 160px', minHeight: '0' }, 'aria-label': 'Beladeschritt' });
  const setStep = (v) => {
    u.step = v >= n ? null : v;
    slider.value = String(v);
    viewer.setStep(u.step ?? Infinity);
    const pl = sp.placements[v - 1];
    stepLabel.textContent = v >= n ? `Alle ${n} Schritte` : `Schritt ${v} / ${n}`;
    stepInfo.textContent = pl && u.step !== null ? `Schritt ${v}: ${res.pieces[pl.piece_id].label} – ${posText(pl, def)}` : '';
  };
  const stepInfo = h('p', { class: 'small', style: { minHeight: '1.3em', margin: 0 } });
  slider.addEventListener('input', () => setStep(Number(slider.value)));
  const toolbar = h('div', { class: 'row' },
    [['iso', '3D'], ['top', 'Oben'], ['side', 'Seite'], ['rear', 'Heck'], ['front', 'Front']].map(([v, l]) => btn(l, () => viewer.view(v), { cls: 'small' })),
    h('span', { class: 'spacer' }),
    btn('◀', () => setStep(Math.max(0, Number(slider.value) - 1)), { cls: 'small', title: 'Schritt zurück' }),
    slider,
    btn('▶', () => setStep(Math.min(n, Number(slider.value) + 1)), { cls: 'small', title: 'Schritt vor' }),
    stepLabel);
  setStep(u.step ?? n);

  // Kennzahlen & Gewichtsverteilung
  const kpi = (label, value, sub, alert) => h('div', { class: `kpi${alert ? ' alert' : ''}` }, h('span', { class: 'label-caps' }, label), h('span', { class: 'v', style: { fontSize: '1.2rem' } }, value), sub ? h('span', { class: 'small muted' }, sub) : null);
  const over = def.max_payload_kg && st.weight_kg > def.max_payload_kg;
  const kpis = h('div', { class: 'kpis' },
    kpi('Teile', String(st.count)),
    kpi('Gewicht', fmt.kg(st.weight_kg), st.payload_pct !== null ? `${fmt.num(st.payload_pct, 1)} % der Nutzlast` : '', over),
    kpi('Volumen', `${fmt.num(st.volume_pct, 1)} %`, `${fmt.num(st.volume_m3, 2)} von ${fmt.num(st.space_volume_m3, 2)} m³`),
    kpi('Lademeter', `${fmt.num(st.loading_meters, 2)} ldm`, `belegt ${fmt.num(st.used_length_cm, 0)} cm · frei ${fmt.num(st.free_length_cm, 0)} cm`),
    kpi('Bodenfläche', `${fmt.num(st.floor_pct, 1)} %`));
  const bar = (label, val, max, overFlag) => {
    const pct = max ? Math.min(100, (val / max) * 100) : 0;
    return h('div', { class: 'stack', style: { gap: '4px' } },
      h('div', { class: 'row small' }, h('span', null, label), h('span', { class: 'spacer' }), h('b', { class: 'num', style: overFlag ? { color: 'var(--bad)' } : null }, `${fmt.num(val, 0)} kg${max ? ` / ${fmt.num(max, 0)} kg` : ''}`)),
      max ? h('div', { class: 'progress' }, h('span', { style: { width: `${pct}%`, background: overFlag ? 'var(--bad)' : pct > 90 ? 'var(--warn)' : 'var(--ok)' } })) : null);
  };
  const distribution = h('div', { class: 'stack' },
    st.axle ? [bar('Vorne (Sattellast / Vorderachse) inkl. Leergewicht', st.axle.front_kg, st.axle.front_max_kg, st.axle.front_over),
      bar('Hinten (Achsaggregat) inkl. Leergewicht', st.axle.rear_kg, st.axle.rear_max_kg, st.axle.rear_over)] : null,
    st.cog ? h('dl', { class: 'kv' },
      h('dt', null, 'Schwerpunkt'), h('dd', null, `${fmt.num(st.cog.x_cm, 0)} cm ab Stirnwand · ${fmt.num(st.cog.y_cm, 0)} cm von links · ${fmt.num(st.cog.z_cm, 0)} cm hoch`),
      h('dt', null, 'Längs'), h('dd', null, `${st.cog_dev_pct > 0 ? '+' : ''}${fmt.num(st.cog_dev_pct, 1)} % zur Mitte${def.cog_tolerance_pct !== null && def.cog_tolerance_pct !== undefined ? ` (zulässig ±${fmt.num(def.cog_tolerance_pct, 1)} %)` : ''}`),
      h('dt', null, 'Links / rechts'), h('dd', null, `${fmt.num(st.left_pct, 1)} % / ${fmt.num(st.right_pct, 1)} %`)) : h('p', { class: 'muted small' }, 'Kein Gewicht erfasst.'),
    st.warnings.length ? h('div', { class: 'stack', style: { gap: '6px' } }, st.warnings.map((w) => h('p', { class: 'notice warn' }, w)))
      : st.count ? h('p', { class: 'notice ok' }, 'Alle Grenzwerte eingehalten.') : null);

  // Lieferung zuordnen
  const assigned = plan.deliveries[sp.key];
  const dSel = h('select', { id: 'lp-delivery', 'data-nodirty': '1' }, h('option', { value: '' }, '— bestehende Lieferung wählen —'),
    plan.open_deliveries.map((d) => h('option', { value: String(d.id) }, `${d.number} (${state.meta.delivery_status[d.status]})`)));
  const assignBox = h('div', { class: 'stack' },
    assigned ? h('p', null, 'Zugeordnet: ', h('a', { href: `#/d/${assigned.id}`, class: 'mono' }, assigned.number), ` · ${assigned.kind_label} · ${assigned.status_label}${assigned.truck_plate ? ' · ' + assigned.truck_plate : ''}`)
      : h('p', { class: 'hint' }, 'Beim Verladen per Scan zeigt die Lieferung diesen Ladeplan an (Position, Reihenfolge, Fortschritt).'),
    h('div', { class: 'row' },
      h('div', { style: { flex: '1 1 200px' } }, dSel),
      btn('Zuordnen', async () => {
        if (!dSel.value) { toast('Bitte eine Lieferung wählen.', 'warn'); return; }
        try { await post(`/loadplans/${plan.id}/assign`, { space_key: sp.key, delivery_id: Number(dSel.value) }); toast('Lieferung zugeordnet.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
      }),
      btn('Neue Lieferung anlegen', async () => {
        try { await post(`/loadplans/${plan.id}/assign`, { space_key: sp.key, create: true }); toast('Lieferung angelegt und zugeordnet.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
      }, { icon: 'plus' }),
      assigned ? btn('Zuordnung lösen', async () => {
        try { await post(`/loadplans/${plan.id}/assign`, { space_key: sp.key, delivery_id: null }); notifyChanged(); } catch (err) { showError(err); }
      }, { cls: 'ghost danger' }) : null));

  // Beladereihenfolge
  const rowsById = new Map();
  const seqTable = n ? h('div', { class: 'table-wrap', style: { maxHeight: '420px', overflow: 'auto' } }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Schritt'), h('th', null, 'Teil'), h('th', null, 'Lage (L × B × H)'), h('th', { class: 'num' }, 'kg'), h('th', null, 'Position'))),
    h('tbody', null, sp.placements.map((pl) => {
      const pc = res.pieces[pl.piece_id];
      const tr = h('tr', { class: 'clickable', onclick: () => { u.selected = pl.piece_id; viewer.setSelected(pl.piece_id); renderSelection(); highlightRow(); } },
        h('td', { class: 'num' }, pl.step),
        h('td', null, h('i', { class: 'swatch', style: { background: colorFor(pc, byStop) } }), pc.hu_id ? h('span', { class: 'mono' }, pc.label) : h('b', null, pc.label),
          pc.sub ? h('div', { class: 'sub' }, pc.sub) : null, byStop ? h('div', { class: 'sub' }, `Entladestelle ${pc.stop}`) : null),
        h('td', { class: 'small nowrap' }, `${fmt.num(pl.dx, 1)} × ${fmt.num(pl.dy, 1)} × ${fmt.num(pl.dz, 1)}`, pl.rotated ? h('div', { class: 'sub' }, 'gedreht') : null, pl.tilted ? h('div', { class: 'sub' }, 'gekippt') : null),
        h('td', { class: 'num' }, fmt.num(pc.weight_kg, 1)),
        h('td', { class: 'small' }, posText(pl, def)));
      rowsById.set(pl.piece_id, tr);
      return tr;
    })))) : h('p', { class: 'muted' }, 'In diesem Laderaum ist nichts verladen.');
  function highlightRow() {
    for (const [pid, tr] of rowsById) tr.classList.toggle('sel', pid === u.selected);
    const tr = rowsById.get(u.selected);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }

  // Manuelle Anpassung des gewählten Teils
  const selBox = h('div', { class: 'stack' });
  const edit = async (body, msg) => {
    try { await post(`/loadplans/${plan.id}/edit`, body); if (msg) toast(msg, 'ok'); notifyChanged(); } catch (err) { showError(err); }
  };
  function renderSelection() {
    selBox.replaceChildren();
    const pl = sp.placements.find((x) => x.piece_id === u.selected);
    if (!pl) { selBox.append(h('p', { class: 'hint' }, 'Teil in der 3D-Ansicht oder in der Liste anklicken, um es manuell zu verschieben, zu drehen oder herauszunehmen. Jede Änderung wird auf Überschneidung, Auflage, Stapelbarkeit, Auflast und Nutzlast geprüft.')); return; }
    const pc = res.pieces[pl.piece_id];
    const inputs = {};
    const num = (k, label, v) => { inputs[k] = h('input', { type: 'number', step: 'any', id: `lp-pos-${k}`, value: String(v), 'data-nodirty': '1' }); return h('label', { class: 'field' }, label, inputs[k]); };
    const dropChk = h('input', { type: 'checkbox', id: 'lp-drop', checked: true, 'data-nodirty': '1' });
    const nudge = (dx, dy) => edit({ action: 'move', piece_id: pl.piece_id, x: pl.x + dx, y: pl.y + dy, z: pl.z, drop: true });
    const target = h('select', { id: 'lp-target', 'data-nodirty': '1' }, res.spaces.map((s, i) => h('option', { value: s.key, selected: i === u.space }, `${i + 1}: ${s.name}`)));
    append(selBox, [
      h('div', { class: 'row' }, h('b', null, `Schritt ${pl.step}: ${pc.label}`), h('span', { class: 'muted small' }, `${fmt.num(pl.dx, 1)} × ${fmt.num(pl.dy, 1)} × ${fmt.num(pl.dz, 1)} cm · ${fmt.kg(pc.weight_kg)}`)),
      h('div', { class: 'form-grid' }, num('x', 'x ab Stirnwand (cm)', pl.x), num('y', 'y ab links (cm)', pl.y), num('z', 'z Höhe (cm)', pl.z)),
      h('div', { class: 'row' },
        h('label', { class: 'field inline' }, dropChk, 'auf Auflage absenken'),
        btn('Position übernehmen', () => edit({ action: 'move', piece_id: pl.piece_id, x: Number(inputs.x.value), y: Number(inputs.y.value), z: Number(inputs.z.value), drop: dropChk.checked }, 'Teil verschoben.'), { cls: 'primary' })),
      h('div', { class: 'row' },
        btn('← 10 cm zur Stirnwand', () => nudge(-10, 0), { cls: 'small' }),
        btn('10 cm zum Heck →', () => nudge(10, 0), { cls: 'small' }),
        btn('10 cm nach links', () => nudge(0, -10), { cls: 'small' }),
        btn('10 cm nach rechts', () => nudge(0, 10), { cls: 'small' })),
      h('div', { class: 'row' },
        btn('90° drehen', () => edit({ action: 'rotate', piece_id: pl.piece_id }, 'Teil gedreht.'), { cls: 'small', disabled: !pc.rotatable && !pc.tiltable }),
        btn('Absenken', () => edit({ action: 'drop', piece_id: pl.piece_id }), { cls: 'small' }),
        btn('Aus dem Plan nehmen', () => edit({ action: 'remove', piece_id: pl.piece_id }, 'Teil herausgenommen.'), { cls: 'small danger' })),
      h('div', { class: 'row' }, h('div', { style: { flex: '1 1 200px' } }, target),
        btn('Automatisch neu platzieren', () => edit({ action: 'place', piece_id: pl.piece_id, space_key: target.value }, 'Teil platziert.'), { cls: 'small' })),
    ]);
  }
  renderSelection();
  setTimeout(highlightRow, 0);

  // Nicht verladen / ausgeschlossen
  const unplacedList = res.unplaced.length || res.excluded.length ? h('div', { class: 'stack' },
    res.unplaced.map((x) => {
      const pc = res.pieces[x.piece_id];
      const tsel = h('select', { 'data-nodirty': '1', 'aria-label': 'Ziel-Laderaum' }, res.spaces.map((s, i) => h('option', { value: s.key, selected: i === u.space }, `${i + 1}: ${s.name}`)));
      return h('div', { class: 'row notice warn' },
        h('div', { style: { flex: '1 1 240px' } }, h('b', null, pc.label), ` – ${pc.length_cm} × ${pc.width_cm} × ${pc.height_cm} cm, ${fmt.kg(pc.weight_kg)}`, h('div', { class: 'small' }, x.reason_label)),
        tsel, btn('Platzieren', () => edit({ action: 'place', piece_id: x.piece_id, space_key: tsel.value }, 'Teil platziert.'), { cls: 'small' }));
    }),
    res.excluded.map((x) => h('p', { class: 'notice bad' }, h('b', null, x.label), ` – nicht eingeplant: ${x.problems.join(', ')}`))) : null;

  return h('div', { class: 'stack', style: { gap: '18px' } },
    plan.stale ? h('p', { class: 'notice warn' }, plan.changed_since_calc ? 'Packstückdaten wurden seit der Berechnung geändert. Bitte „Optimal beladen“ erneut ausführen.' : 'Ladegut oder Laderäume wurden geändert. Bitte „Optimal beladen“ erneut ausführen.') : null,
    h('p', { class: `notice ${res.unplaced.length ? 'warn' : 'ok'}` },
      `${total - res.unplaced.length} von ${total} Teilen verladen in ${res.spaces.filter((s) => s.placements.length).length} Laderaum/-räumen`,
      res.unplaced.length ? ` – ${res.unplaced.length} Teil(e) nicht verladen.` : '.'),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-body', style: { paddingBottom: 0 } }, tabs),
      h('div', { class: 'panel-body' },
        h('div', { class: 'muted small' }, `${def.name}: ${dimsText(def)}`),
        toolbar, box, stepInfo,
        h('p', { class: 'hint' }, 'Ziehen = drehen, Mausrad / zwei Finger = zoomen, rechte Maustaste = verschieben. Rote Kugel = Schwerpunkt.'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Auslastung')), h('div', { class: 'panel-body' }, kpis)),
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Gewichtsverteilung')), h('div', { class: 'panel-body' }, distribution))),
    unplacedList ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Nicht verladen')), h('div', { class: 'panel-body' }, unplacedList)) : null,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Manuell anpassen')), h('div', { class: 'panel-body' }, selBox)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Beladereihenfolge (${n})`)), h('div', { class: 'panel-body flush' }, seqTable)),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Lieferung / Verladung')), h('div', { class: 'panel-body' }, assignBox)));
}

/** Lagebeschreibung für Verlader */
export function posText(pl, def) {
  const W = def.width_cm;
  const side = pl.y <= 1 ? 'links' : pl.y + pl.dy >= W - 1 ? 'rechts' : 'Mitte';
  const level = pl.z <= 0 ? 'Boden' : `auf ${fmt.num(pl.z, 0)} cm Höhe`;
  return `${fmt.num(pl.x, 0)}–${fmt.num(pl.x + pl.dx, 0)} cm ab Stirnwand, ${side} (${fmt.num(pl.y, 0)}–${fmt.num(pl.y + pl.dy, 0)} cm), ${level}`;
}

// ================================================================== Bericht (Druck) & Excel
function reportDialog(plan) {
  formDialog({
    title: 'Ladeplan-Bericht drucken',
    intro: h('p', { class: 'hint' }, 'Je Laderaum: Kennzahlen, Gewichtsverteilung, 3D-Ansichten und Beladereihenfolge. Über den Druckdialog als PDF speichern oder ausdrucken.'),
    fields: [{ name: 'steps', label: 'Schritt-für-Schritt-Bilder (je Beladeschritt ein Bild, max. 60 je Laderaum)', type: 'checkbox', value: false }],
    submitLabel: 'Bericht erstellen',
    onSubmit: async (v) => { await printReport(plan, { steps: v.steps }); },
  });
}

async function printReport(plan, { steps }) {
  const res = plan.result;
  const byStop = new Set(Object.values(res.pieces).map((p) => p.stop)).size > 1;
  const host = h('div', { style: { position: 'fixed', left: '-10000px', top: '0', width: '1200px', height: '700px' } });
  document.body.append(host);
  const pages = [];
  try {
    for (let i = 0; i < res.spaces.length; i++) {
      const sp = res.spaces[i];
      if (!sp.placements.length) continue;
      const def = res.space_defs[i];
      const v = createViewer(host, { space: def, placements: sp.placements, pieces: res.pieces, byStop, cog: sp.stats.cog });
      const shots = {};
      for (const view of ['iso', 'top', 'side']) { v.view(view); shots[view] = v.snapshot(1200, 700); }
      const stepShots = [];
      if (steps) {
        v.view('iso');
        const count = Math.min(sp.placements.length, 60);
        for (let s = 1; s <= count; s++) { v.setStep(s); v.setSelected(sp.placements[s - 1].piece_id); stepShots.push(v.snapshot(600, 380)); }
      }
      v.dispose();
      const st = sp.stats;
      const img = (src, alt) => h('img', { src, alt, style: { width: '100%', border: '0.2mm solid #999', marginBottom: '2mm' } });
      pages.push(h('div', { class: 'doc', style: { breakBefore: pages.length ? 'page' : 'auto' } },
        h('h1', null, `Ladeplan ${plan.name} – Laderaum ${i + 1}: ${sp.name}`),
        h('div', { class: 'meta' },
          h('div', null, h('b', null, 'Projekt: '), `${plan.project.number}${plan.project.name ? ' – ' + plan.project.name : ''}`),
          h('div', null, h('b', null, 'Laderaum: '), dimsText(def)),
          h('div', null, h('b', null, 'Lieferung: '), plan.deliveries[sp.key] ? plan.deliveries[sp.key].number : '–'),
          h('div', null, h('b', null, 'Teile: '), String(st.count)),
          h('div', null, h('b', null, 'Gewicht: '), `${fmt.kg(st.weight_kg)}${st.payload_pct !== null ? ` (${fmt.num(st.payload_pct, 1)} %)` : ''}`),
          h('div', null, h('b', null, 'Volumen: '), `${fmt.num(st.volume_pct, 1)} % · ${fmt.num(st.loading_meters, 2)} ldm`),
          h('div', null, h('b', null, 'Schwerpunkt: '), st.cog ? `${fmt.num(st.cog.x_cm, 0)} cm ab Stirnwand (${st.cog_dev_pct > 0 ? '+' : ''}${fmt.num(st.cog_dev_pct, 1)} %)` : '–'),
          st.axle ? h('div', null, h('b', null, 'Vorne: '), `${fmt.kg(st.axle.front_kg)}${st.axle.front_max_kg ? ' / ' + fmt.kg(st.axle.front_max_kg) : ''}`) : null,
          st.axle ? h('div', null, h('b', null, 'Hinten: '), `${fmt.kg(st.axle.rear_kg)}${st.axle.rear_max_kg ? ' / ' + fmt.kg(st.axle.rear_max_kg) : ''}`) : null,
          h('div', null, h('b', null, 'Berechnet: '), `${fmt.dt(plan.computed_at)}`)),
        st.warnings.length ? h('div', null, st.warnings.map((w) => h('p', null, `⚠ ${w}`))) : h('p', null, 'Alle Grenzwerte eingehalten.'),
        img(shots.iso, '3D-Ansicht'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3mm' } }, img(shots.top, 'Draufsicht'), img(shots.side, 'Seitenansicht')),
        h('h2', null, 'Beladereihenfolge'),
        h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Schritt'), h('th', null, 'Teil'), h('th', null, 'Lage L × B × H (cm)'), h('th', { class: 'num' }, 'kg'), h('th', null, 'Position'))),
          h('tbody', null, sp.placements.map((pl) => {
            const pc = res.pieces[pl.piece_id];
            return h('tr', null, h('td', null, String(pl.step)), h('td', null, pc.label + (pc.sub ? ` (${pc.sub})` : '')),
              h('td', null, `${fmt.num(pl.dx, 1)} × ${fmt.num(pl.dy, 1)} × ${fmt.num(pl.dz, 1)}${pl.rotated ? ' gedreht' : ''}${pl.tilted ? ' gekippt' : ''}`),
              h('td', { class: 'num' }, fmt.num(pc.weight_kg, 1)), h('td', null, posText(pl, def)));
          }))),
        stepShots.length ? [h('h2', { style: { breakBefore: 'page' } }, 'Schritt für Schritt'),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '2mm' } },
            stepShots.map((src, s) => h('div', { style: { breakInside: 'avoid' } }, img(src, `Schritt ${s + 1}`),
              h('div', { style: { fontSize: '8pt' } }, `${s + 1}. ${res.pieces[sp.placements[s].piece_id].label}`))))] : null));
    }
    if (res.unplaced.length) {
      pages.push(h('div', { class: 'doc', style: { breakBefore: 'page' } }, h('h2', null, 'Nicht verladen'),
        h('table', null, h('tbody', null, res.unplaced.map((x) => h('tr', null, h('td', null, res.pieces[x.piece_id].label), h('td', null, x.reason_label)))))));
    }
  } finally {
    host.remove();
  }
  if (!pages.length) { toast('Keine verladenen Teile vorhanden.', 'warn'); return; }
  printNodes(pages);
}

async function exportExcel(plan) {
  await loadScript('/vendor/xlsx.full.min.js');
  const XLSX = window.XLSX;
  const res = plan.result;
  const wb = XLSX.utils.book_new();
  const summary = [['Ladeplan', plan.name], ['Projekt', `${plan.project.number} ${plan.project.name || ''}`.trim()], ['Berechnet', fmt.dt(plan.computed_at)], [],
    ['Laderaum', 'Typ', 'Teile', 'Gewicht kg', 'Nutzlast %', 'Volumen %', 'Lademeter', 'Schwerpunkt ab Stirnwand cm', 'Last vorne kg', 'Last hinten kg', 'Lieferung', 'Hinweise']];
  res.spaces.forEach((sp, i) => {
    const st = sp.stats;
    summary.push([i + 1, sp.name, st.count, st.weight_kg, st.payload_pct, st.volume_pct, st.loading_meters, st.cog ? st.cog.x_cm : '',
      st.axle ? st.axle.front_kg : '', st.axle ? st.axle.rear_kg : '', plan.deliveries[sp.key] ? plan.deliveries[sp.key].number : '', st.warnings.join(' | ')]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Übersicht');
  res.spaces.forEach((sp, i) => {
    const rows = [['Schritt', 'Teil', 'Beschreibung', 'Länge cm', 'Breite cm', 'Höhe cm', 'Gewicht kg', 'x ab Stirnwand cm', 'y ab links cm', 'z Höhe cm', 'gedreht', 'gekippt', 'Entladestelle']];
    for (const pl of sp.placements) {
      const pc = res.pieces[pl.piece_id];
      rows.push([pl.step, pc.label, pc.sub || '', pl.dx, pl.dy, pl.dz, pc.weight_kg, pl.x, pl.y, pl.z, pl.rotated ? 'ja' : 'nein', pl.tilted ? 'ja' : 'nein', pc.stop]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), `Laderaum ${i + 1}`.slice(0, 31));
  });
  if (res.unplaced.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Teil', 'Länge cm', 'Breite cm', 'Höhe cm', 'Gewicht kg', 'Grund'],
      ...res.unplaced.map((x) => { const pc = res.pieces[x.piece_id]; return [pc.label, pc.length_cm, pc.width_cm, pc.height_cm, pc.weight_kg, x.reason_label]; })]), 'Nicht verladen');
  }
  XLSX.writeFile(wb, `Ladeplan ${plan.project.number} ${plan.name}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'));
}
