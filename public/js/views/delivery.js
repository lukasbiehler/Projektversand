// Lieferung / Verladung: Packstücke per Scan verladen, Ladungsfotos, Warenausgang, Zustellung, Packliste
import {
  h, get, post, put, del, state, btn, chip, fmt, toast, formDialog, confirmDialog, go, setScanHandler, optionList, showError, feedback, notifyChanged,
} from '../core.js';
import { scanField } from '../scanner.js';
import { openLabelDialog, printNodes } from '../labels.js';
import { photoPanel } from '../photos.js';
import { eventsTable } from './project.js';
import { loadThree, createViewer } from '../viewer3d.js';
import { posText } from './loadplan.js';
import { onCleanup } from '../core.js';

export async function render(ctx) {
  const id = Number(ctx.params[0]);
  const d = await get(`/deliveries/${id}`);
  const { delivery: dl, project } = d;
  ctx.projectId = dl.project_id;
  const meta = state.meta;
  const loading = ['GEPLANT', 'IN_VERLADUNG'].includes(dl.status);

  const act = async (action, msg, body = {}) => {
    try { await post(`/deliveries/${dl.id}/action`, { action, ...body }); toast(msg, 'ok'); notifyChanged(); } catch (err) { feedback(false); showError(err); }
  };

  // ---------------------------------------------------------------- Kopf
  const actions = h('div', { class: 'row' });
  const add = (b) => actions.append(b);
  if (dl.status === 'IN_VERLADUNG') add(btn('Verladung abschließen (Warenausgang)', async () => {
    if (!(await confirmDialog(`Verladung von ${dl.hu_count} Packstück(en) abschließen und Warenausgang an SAP melden?`, { ok: 'Abschließen' }))) return;
    act('complete', 'Verladung abgeschlossen, Warenausgang gemeldet.');
  }, { cls: 'primary', icon: 'check' }));
  if (dl.status === 'VERLADEN') {
    add(btn('Zustellung bestätigen', () => formDialog({
      title: 'Zustellung bestätigen',
      fields: [
        { name: 'delivered_at', label: 'Zugestellt am', type: 'datetime-local', value: localNow(), required: true },
        { name: 'note', label: 'Bemerkung (z. B. Empfänger, Zustand)', wide: true },
      ],
      submitLabel: 'Bestätigen',
      onSubmit: async (v) => {
        await post(`/deliveries/${dl.id}/action`, { action: 'delivered', delivered_at: new Date(v.delivered_at).toISOString(), note: v.note });
        toast('Zustellung bestätigt.', 'ok');
      },
    }), { cls: 'ok', icon: 'check' }));
    add(btn('Warenausgang stornieren', async () => {
      if (!(await confirmDialog('Warenausgang stornieren und Verladung wieder öffnen? Die Stornierung wird an SAP gemeldet.', { ok: 'Stornieren', danger: true }))) return;
      act('reopen', 'Warenausgang storniert.');
    }, { cls: 'danger' }));
  }
  add(btn('Packliste drucken', () => printPackingList(d), { icon: 'print' }));
  if (d.hus.length) add(btn('Etiketten aller Packstücke', () => openLabelDialog(d.hus.map((x) => ({ kind: 'hu', hu_id: x.id }))), { icon: 'print' }));
  if (dl.status === 'GEPLANT' && !d.hus.length && !d.photos.length) add(btn('Löschen', async () => {
    if (!(await confirmDialog(`Lieferung ${dl.number} löschen?`, { ok: 'Löschen', danger: true }))) return;
    try { await del(`/deliveries/${dl.id}`); toast('Lieferung gelöscht.', 'ok'); go(`#/p/${dl.project_id}/deliveries`); } catch (err) { showError(err); }
  }, { cls: 'danger', icon: 'trash' }));

  const volume = d.hus.reduce((s, x) => s + (x.volume_m3 || 0), 0);
  const head = h('div', { class: 'stack' },
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Projekte'), '›', h('a', { href: `#/p/${project.id}` }, project.number), '›',
      h('a', { href: `#/p/${project.id}/deliveries` }, 'Lieferungen'), '›', h('span', null, dl.number)),
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' },
        h('div', { class: 'row' }, h('span', { class: 'hu-id' }, dl.number), h('span', { class: `tag${dl.kind === 'NACHLIEFERUNG' ? ' warn' : ''}` }, dl.kind_label), chip(dl.status, dl.status_label)),
        h('div', { class: 'muted' }, [dl.truck_plate ? `Kennzeichen ${dl.truck_plate}` : 'Kennzeichen noch nicht erfasst', dl.carrier, dl.planned_date ? `geplant ${fmt.date(dl.planned_date)}` : ''].filter(Boolean).join(' · '))),
      actions),
    h('div', { class: 'kpis' },
      kpi('Packstücke', dl.hu_count, dl.hu_total > dl.hu_count ? `${dl.hu_total} inkl. enthaltener` : ''),
      kpi('Bruttogewicht', fmt.kg(dl.gross_total)),
      kpi('Volumen', `${fmt.num(volume, 2)} m³`),
      kpi('Verladen', dl.loaded_at ? fmt.dt(dl.loaded_at) : '–'),
      kpi('Zugestellt', dl.delivered_at ? fmt.dt(dl.delivered_at) : '–')));

  // ---------------------------------------------------------------- Ladeplan (falls ein Laderaum dieser Lieferung zugeordnet ist)
  const lp = d.loadplan;
  let planPanel = null;
  let planHint = () => '';
  if (lp) {
    await loadThree();
    const pieces = lp.pieces;
    const order = lp.space.placements;
    const loadedSet = new Set(lp.loaded_piece_ids);
    const manual = order.filter((pl) => !pieces[pl.piece_id].hu_id).map((pl) => pl.piece_id);
    const tracked = order.filter((pl) => pieces[pl.piece_id].hu_id);
    const next = tracked.find((pl) => !loadedSet.has(pl.piece_id));
    const box = h('div', { class: 'viewer3d' });
    const viewer = createViewer(box, { space: lp.space_def, placements: order, pieces, cog: lp.space.stats.cog });
    onCleanup(() => viewer.dispose());
    viewer.setLoaded(new Set([...loadedSet, ...manual]), next ? next.piece_id : null);
    planHint = (huId) => {
      const pl = tracked.find((x) => pieces[x.piece_id].hu_id === huId);
      if (!pl) return { warn: true, text: 'Achtung: Dieses Packstück ist nicht im Ladeplan dieses Laderaums.' };
      const skipped = tracked.filter((x) => x.step < pl.step && !loadedSet.has(x.piece_id) && x !== pl);
      if (skipped.length) return { warn: true, text: `Reihenfolge laut Ladeplan: Schritt ${skipped.map((x) => x.step).slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''} noch nicht verladen. Position für dieses Teil: Schritt ${pl.step}, ${posText(pl, lp.space_def)}.` };
      return { warn: false, text: `Ladeplan Schritt ${pl.step}: ${posText(pl, lp.space_def)}.` };
    };
    planPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, `Ladeplan: ${lp.plan_name} – ${lp.space.name}`), h('a', { href: `#/lp/${lp.plan_id}`, class: 'btn small' }, 'Plan öffnen')),
      h('div', { class: 'panel-body' },
        lp.stale ? h('p', { class: 'notice warn' }, 'Der Ladeplan ist veraltet (Daten geändert). Bitte im Plan neu berechnen.') : null,
        h('div', { class: 'row' },
          h('b', null, `${tracked.filter((x) => loadedSet.has(x.piece_id)).length} von ${tracked.length} Packstücken laut Plan verladen`),
          manual.length ? h('span', { class: 'muted small' }, `+ ${manual.length} zusätzliche Teile ohne Scan`) : null),
        h('div', { class: 'progress' }, h('span', { style: { width: `${tracked.length ? (tracked.filter((x) => loadedSet.has(x.piece_id)).length / tracked.length) * 100 : 0}%` } })),
        next ? h('p', { class: 'notice' }, h('b', null, `Nächster Schritt ${next.step}: ${pieces[next.piece_id].label}`), ` – ${posText(next, lp.space_def)}`)
          : h('p', { class: 'notice ok' }, 'Alle Packstücke des Plans sind verladen.'),
        box,
        h('p', { class: 'hint' }, 'Verladen = voll dargestellt, offen = durchscheinend, nächster Schritt = orange.')));
  }

  // ---------------------------------------------------------------- Verladen per Scan
  let loadPanel = null;
  if (loading) {
    const field = scanField({
      label: 'Packstück zum Verladen scannen', placeholder: 'HU- oder Packstück-Etikett scannen …', id: 'load-scan',
      onScan: async (code) => {
        const r = await post(`/deliveries/${dl.id}/load`, { code });
        const hint = lp ? planHint(r.hu.id) : null;
        toast(`✓ ${r.hu.package_number} verladen.${hint ? ' ' + hint.text : ''}`, hint && hint.warn ? 'warn' : 'ok', hint ? 8000 : 3800);
        notifyChanged();
        return true;
      },
    });
    setScanHandler((code) => { field.run(code); });
    const readyTable = d.ready.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Versandbereit'), h('th', null, 'Art / Bezeichnung'), h('th', null, 'Lagerplatz'), h('th', { class: 'num' }, 'Brutto'), h('th', null, ''))),
      h('tbody', null, d.ready.map((x) => h('tr', null,
        h('td', null, h('a', { href: `#/hu/${x.id}`, class: 'mono' }, x.package_number)),
        h('td', null, h('b', null, x.packaging_label), h('div', { class: 'sub' }, x.description)),
        h('td', { class: 'small' }, x.location || '–'),
        h('td', { class: 'num' }, fmt.kg(x.gross_eff)),
        h('td', null, btn('Verladen', async () => {
          try {
            await post(`/deliveries/${dl.id}/load`, { hu_id: x.id });
            const hint = lp ? planHint(x.id) : null;
            toast(`${x.package_number} verladen.${hint ? ' ' + hint.text : ''}`, hint && hint.warn ? 'warn' : 'ok', hint ? 8000 : 3800);
            feedback(true);
            notifyChanged();
          } catch (err) { feedback(false); showError(err); }
        }, { cls: 'small', icon: 'truck' }))))))) : h('p', { class: 'muted small' }, 'Keine weiteren versandbereiten Packstücke im Projekt.');
    loadPanel = h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Verladen')),
      h('div', { class: 'panel-body' }, field, readyTable,
        d.not_ready_count ? h('p', { class: 'notice warn' }, `${d.not_ready_count} Packstück(e) des Projekts sind noch nicht versandbereit. `, h('a', { href: `#/p/${project.id}/hus` }, 'Packstücke ansehen')) : null));
  } else {
    setScanHandler(null);
  }

  // ---------------------------------------------------------------- Verladene Packstücke
  const loadedTable = d.hus.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'Packstück'), h('th', null, 'Art / Bezeichnung'), h('th', null, 'Inhalt'), h('th', null, 'Maße'), h('th', { class: 'num' }, 'Brutto'), h('th', null, 'Status'), h('th', null, ''))),
    h('tbody', null, d.hus.map((x) => h('tr', null,
      h('td', null, h('a', { href: `#/hu/${x.id}`, class: 'mono' }, x.package_number), h('div', { class: 'sub mono' }, x.hu_number)),
      h('td', null, h('b', null, x.packaging_label), h('div', { class: 'sub' }, x.description)),
      h('td', { class: 'small' }, `${x.contents_count} Pos.`, x.children_count ? ` · ${x.children_count} Packst.` : ''),
      h('td', { class: 'small nowrap' }, fmt.dims(x)),
      h('td', { class: 'num' }, fmt.kg(x.gross_eff)),
      h('td', null, chip(x.status, x.status_label)),
      h('td', null, loading ? btn('Entladen', async () => {
        try { await post(`/deliveries/${dl.id}/unload`, { hu_id: x.id }); toast(`${x.package_number} entladen.`, 'ok'); notifyChanged(); } catch (err) { showError(err); }
      }, { cls: 'small ghost danger' }) : null)))))) : h('div', { class: 'empty' }, 'Noch keine Packstücke verladen.');

  // ---------------------------------------------------------------- Lieferdaten
  const locked = dl.status === 'AUSGELIEFERT';
  const afterGi = ['VERLADEN', 'AUSGELIEFERT'].includes(dl.status);
  const inp = (name, label, value, extra = {}) => h('label', { class: `field${extra.wide ? ' wide' : ''}` }, label,
    h(extra.textarea ? 'textarea' : 'input', { name, id: `dl-${name}`, value: value || '', type: extra.type, disabled: extra.disabled || (locked && name !== 'note'), rows: extra.textarea ? 2 : undefined }));
  const form = h('form', { class: 'form-grid' },
    inp('number', 'Lieferungsnummer', dl.number, { disabled: afterGi }),
    h('label', { class: 'field' }, 'Art', h('select', { name: 'kind', id: 'dl-kind', value: dl.kind, disabled: afterGi }, optionList(meta.delivery_kinds).map((o) => h('option', { value: o.value }, o.label)))),
    inp('planned_date', 'Geplante Verladung', dl.planned_date, { type: 'date' }),
    inp('truck_plate', 'LKW-Kennzeichen / Container-Nr.', dl.truck_plate),
    inp('trailer_plate', 'Auflieger-Kennzeichen', dl.trailer_plate),
    inp('carrier', 'Spedition', dl.carrier),
    inp('driver', 'Fahrer', dl.driver),
    inp('destination', 'Zielort', dl.destination, { textarea: true, wide: true }),
    inp('note', 'Bemerkung', dl.note, { textarea: true, wide: true }),
    h('div', { class: 'row wide' }, h('button', { type: 'submit', class: 'btn primary' }, 'Lieferdaten speichern')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(form).entries()) body[k] = String(v).trim();
    try { await put(`/deliveries/${dl.id}`, body); state.dirty = false; toast('Lieferdaten gespeichert.', 'ok'); notifyChanged(); } catch (err) { feedback(false); showError(err); }
  });

  const huChoices = d.packing_list.map((x) => ({ id: x.hu.id, label: `${x.hu.package_number} · ${x.hu.packaging_label}` }));
  const page = h('div', { class: 'stack', style: { gap: '18px' } },
    head,
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack', style: { gap: '18px' } },
        loadPanel,
        planPanel,
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Verladene Packstücke (${d.hus.length})`)), h('div', { class: 'panel-body flush' }, loadedTable))),
      h('div', { class: 'stack', style: { gap: '18px' } },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Verladedokumentation (${d.photos.length} Bilder)`)),
          h('div', { class: 'panel-body' }, photoPanel({
            target: { delivery_id: dl.id, huChoices }, phases: ['VERLADUNG'], photos: d.photos, onChange: () => notifyChanged(),
          }))),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Lieferdaten')), h('div', { class: 'panel-body' }, form)))),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Verlauf der Lieferung')), h('div', { class: 'panel-body flush' }, eventsTable(d.events))));
  ctx.show(page);
}

function kpi(label, value, extra) {
  return h('div', { class: 'kpi' }, h('span', { class: 'label-caps' }, label), h('span', { class: 'v', style: { fontSize: '1.25rem' } }, value), extra ? h('span', { class: 'small muted' }, extra) : null);
}

function localNow() {
  const n = new Date();
  n.setMinutes(n.getMinutes() - n.getTimezoneOffset());
  return n.toISOString().slice(0, 16);
}

/** Packliste (Anlage zum Lieferschein) als A4-Dokument drucken */
function printPackingList(d) {
  const { delivery: dl, project } = d;
  const tops = d.hus;
  const byId = new Map(d.packing_list.map((x) => [x.hu.id, x]));
  const order = [];
  const walk = (hu) => { order.push(byId.get(hu.id)); for (const x of d.packing_list) if (x.hu.parent_id === hu.id) walk(x.hu); };
  for (const t of tops) walk(t);
  const meta = (label, value) => h('div', null, h('b', null, `${label}: `), value || '–');
  const doc = h('div', { class: 'doc' },
    h('h1', null, `Packliste Lieferung ${dl.number}`),
    h('div', { class: 'meta' },
      meta('Projekt', `${project.number}${project.name ? ' – ' + project.name : ''}`), meta('Kunde', project.customer), meta('Art', dl.kind_label),
      meta('Zielort', dl.destination), meta('Kennzeichen', [dl.truck_plate, dl.trailer_plate].filter(Boolean).join(' / ')), meta('Spedition', dl.carrier),
      meta('Fahrer', dl.driver), meta('Verladen', dl.loaded_at ? fmt.dt(dl.loaded_at) : 'noch offen'), meta('Status', dl.status_label)),
    h('h2', null, `Packstücke (${tops.length}) – Gesamtgewicht brutto ${fmt.kg(dl.gross_total)}`),
    h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Packstück-Nr.'), h('th', null, 'HU-Nr.'), h('th', null, 'Art'), h('th', null, 'Bezeichnung'), h('th', null, 'PSP'),
        h('th', null, 'L × B × H'), h('th', { class: 'num' }, 'Brutto'))),
      h('tbody', null, tops.map((x) => h('tr', null, h('td', null, x.package_number), h('td', null, x.hu_number), h('td', null, x.packaging_label),
        h('td', null, x.description), h('td', null, x.psp_code || ''), h('td', null, fmt.dims(x)), h('td', { class: 'num' }, fmt.kg(x.gross_eff)))))),
    h('h2', null, 'Inhalt je Packstück'),
    order.filter(Boolean).map(({ hu, contents }) => h('div', { class: 'hu-block' },
      h('p', null, h('b', null, `${hu.package_number} (${hu.packaging_label})`), hu.parent_package_number ? ` – liegt in ${hu.parent_package_number}` : '', hu.description ? ` – ${hu.description}` : ''),
      contents.length ? h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Material'), h('th', null, 'Bezeichnung'), h('th', null, 'PSP-Element'), h('th', { class: 'num' }, 'Menge'))),
        h('tbody', null, contents.map((c) => h('tr', null, h('td', null, c.material_number), h('td', null, c.description), h('td', null, c.psp_code || ''),
          h('td', { class: 'num' }, fmt.qty(c.qty, c.unit)))))) : h('p', null, 'Kein Einzelmaterial (enthält Packstücke).'))),
    h('div', { class: 'sign' }, h('div', null, 'Verladen durch (Name, Datum, Unterschrift)'), h('div', null, 'Übernommen durch Fahrer (Name, Datum, Unterschrift)')));
  printNodes([doc]);
}
