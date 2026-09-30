// Rückwärtssuche: Material, PSP-Element, Packstück, Handling Unit, Lieferung → Verpack-/Lieferstatus, Bilder, Verladeinfos, Nachlieferungen
import { h, get, btn, chip, fmt, go, setScanHandler } from '../core.js';
import { cameraScan } from '../scanner.js';

export async function render(ctx) {
  const q = (ctx.query.q || '').trim();
  const pid = ctx.query.p || '';
  const projects = await get('/projects');
  const qInput = h('input', { type: 'search', id: 'search-q', value: q, placeholder: 'Materialnummer, Barcode, PSP-Element, Packstück, HU, Lieferung, Kennzeichen …', autocomplete: 'off', 'data-nodirty': '1' });
  const pSel = h('select', { id: 'search-p', value: pid, 'data-nodirty': '1' }, h('option', { value: '' }, 'Alle Projekte'),
    projects.map((p) => h('option', { value: String(p.id) }, `${p.number}${p.name ? ' – ' + p.name : ''}`)));
  const submit = (code) => go(`#/search?q=${encodeURIComponent(code ?? qInput.value.trim())}${pSel.value ? `&p=${pSel.value}` : ''}`);
  const form = h('form', { class: 'panel' }, h('div', { class: 'panel-body' },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field wide' }, 'Suchbegriff oder Code', qInput),
      h('label', { class: 'field' }, 'Projekt', pSel)),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn primary' }, 'Suchen'),
      btn('Mit Kamera scannen', async () => { const c = await cameraScan(); if (c) submit(c); }, { icon: 'camera' }))));
  form.addEventListener('submit', (e) => { e.preventDefault(); if (qInput.value.trim().length >= 2) submit(); });
  pSel.addEventListener('change', () => { if (qInput.value.trim().length >= 2) submit(); });
  setScanHandler((code) => { submit(code); return true; });

  const parts = [h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Rückwärtssuche'),
    h('p', { class: 'muted' }, 'Wo ist ein Material verpackt, in welchem Packstück, auf welcher Lieferung – mit Status, Bildern und Verladeinformationen.'))), form];

  if (q.length >= 2) {
    const r = await get(`/search?q=${encodeURIComponent(q)}${pid ? `&project_id=${pid}` : ''}`);
    parts.push(results(r));
  } else if (q) {
    parts.push(h('p', { class: 'notice warn' }, 'Bitte mindestens 2 Zeichen eingeben.'));
  }
  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } }, parts));
  if (!q && !matchMedia('(pointer: coarse)').matches) qInput.focus();
}

function results(r) {
  const proj = (id) => r.projects[id] || { number: '?' };
  const exact = r.exact && r.exact.kind !== 'unknown'
    ? h('p', { class: 'notice ok' }, 'Erkannt: ', r.exact.kind === 'hu' ? h('a', { href: `#/hu/${r.exact.id}` }, r.exact.label)
      : r.exact.kind === 'delivery' ? h('a', { href: `#/d/${r.exact.id}` }, r.exact.label)
        : r.exact.kind === 'project' ? h('a', { href: `#/p/${r.exact.id}` }, r.exact.label) : r.exact.label)
    : null;
  const total = r.items.length + r.hus.length + r.deliveries.length;

  const itemRows = r.items.map((i) => h('tr', null,
    h('td', null, h('div', { class: 'mono' }, i.material_number), h('div', { class: 'sub' }, i.description)),
    h('td', null, h('a', { href: `#/p/${i.project_id}/items`, class: 'mono' }, i.project_number), h('div', { class: 'sub mono' }, i.psp_code || 'ohne PSP')),
    h('td', { class: 'num' }, fmt.qty(i.qty_required, i.unit), h('div', { class: 'sub' }, `verpackt ${fmt.num(i.qty_packed)} · offen ${fmt.num(i.qty_open)}`),
      i.qty_missing_eff > 0 ? h('div', { class: 'sub', style: { color: 'var(--s-miss-fg)' } }, `Fehlmenge ${fmt.num(i.qty_missing_eff)}${i.missing_expected ? ' · erw. ' + fmt.date(i.missing_expected) : ''}`) : null),
    h('td', null, chip(i.status, i.status_label), i.was_missing && i.qty_missing_eff <= 0 ? h('div', { class: 'sub' }, 'war Fehlteil') : null),
    h('td', { class: 'small' }, i.placements.length ? i.placements.map((p) => h('div', { style: { marginBottom: '4px' } },
      h('a', { href: `#/hu/${p.hu_id}`, class: 'mono' }, p.package_number), ` · ${fmt.num(p.qty)} ${i.unit} · `, h('span', { class: `chip s-${p.status}` }, p.status_label),
      p.location ? h('div', { class: 'sub' }, `Lagerplatz ${p.location}`) : null,
      p.delivery_number ? h('div', { class: 'sub' }, 'Lieferung ', h('a', { href: `#/d/${p.delivery_id}`, class: 'mono' }, p.delivery_number),
        p.delivery_kind === 'NACHLIEFERUNG' ? h('b', null, ' · Nachlieferung') : '', p.delivery_truck_plate ? ` · ${p.delivery_truck_plate}` : '',
        p.delivery_loaded_at ? ` · verladen ${fmt.dt(p.delivery_loaded_at)}` : '', p.delivery_delivered_at ? ` · zugestellt ${fmt.dt(p.delivery_delivered_at)}` : '') : null))
      : h('span', { class: 'muted' }, 'nicht verpackt'))));

  const huRows = r.hus.map((x) => h('tr', null,
    h('td', null, h('a', { href: `#/hu/${x.id}`, class: 'mono' }, x.package_number), h('div', { class: 'sub mono' }, x.hu_number)),
    h('td', null, h('span', { class: 'mono' }, x.project_number), h('div', { class: 'sub' }, `${x.packaging_label}${x.description ? ' · ' + x.description : ''}`)),
    h('td', null, h('div', { class: 'small' }, `Verpackung: ${x.pack_status_label}`), h('div', { class: 'small' }, `Versand: ${x.ship_status_label}`)),
    h('td', { class: 'small' }, x.location || '–', x.parent_package_number ? h('div', { class: 'sub' }, `liegt in ${x.parent_package_number}`) : null),
    h('td', { class: 'small' }, x.delivery_number ? [h('a', { href: `#/d/${x.delivery_id}`, class: 'mono' }, x.delivery_number), h('div', { class: 'sub' }, `${x.delivery_kind_label}${x.delivery_truck_plate ? ' · ' + x.delivery_truck_plate : ''}`)] : '–'),
    h('td', { class: 'num' }, x.photos_count || '–')));

  const dlRows = r.deliveries.map((d) => h('tr', null,
    h('td', null, h('a', { href: `#/d/${d.id}`, class: 'mono' }, d.number)),
    h('td', { class: 'mono' }, proj(d.project_id).number),
    h('td', null, d.kind === 'NACHLIEFERUNG' ? h('span', { class: 'tag warn' }, d.kind_label) : h('span', { class: 'tag' }, d.kind_label)),
    h('td', null, chip(d.status, d.status_label)),
    h('td', { class: 'mono' }, d.truck_plate || '–'),
    h('td', { class: 'small' }, `verladen ${fmt.dt(d.loaded_at)}`, h('div', { class: 'sub' }, `zugestellt ${fmt.dt(d.delivered_at)}`)),
    h('td', { class: 'num' }, d.hu_count)));

  const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, heads.map((x) => h('th', { class: x.endsWith('#') ? 'num' : '' }, x.replace('#', ''))))), h('tbody', null, rows)));
  const section = (title, count, content) => (count ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `${title} (${count})`)), h('div', { class: 'panel-body flush' }, content)) : null);

  return h('div', { class: 'stack', style: { gap: '18px' } },
    exact,
    total === 0 ? h('div', { class: 'panel' }, h('div', { class: 'empty' }, `Keine Treffer für „${r.query}“.`)) : null,
    section('Material / PSP-Positionen', r.items.length, table(['Material', 'Projekt / PSP', 'Menge#', 'Status', 'Packstück · Lieferung'], itemRows)),
    section('Packstücke / Handling Units', r.hus.length, table(['Packstück', 'Projekt / Art', 'Verpack- / Lieferstatus', 'Lagerplatz', 'Lieferung', 'Bilder#'], huRows)),
    section('Lieferungen', r.deliveries.length, table(['Lieferung', 'Projekt', 'Art', 'Status', 'Kennzeichen', 'Verladeinfo', 'Packstücke#'], dlRows)),
    r.photos.length ? h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `Bilder (${r.photos.length})`)),
      h('div', { class: 'panel-body' }, h('div', { class: 'gallery' }, r.photos.map((p) => h('a', { class: 'thumb', href: `/api/photos/${p.id}/file`, target: '_blank', rel: 'noopener' },
        h('img', { src: `/api/photos/${p.id}/file`, alt: p.category_label, loading: 'lazy' }),
        h('span', null, h('b', null, p.category_label), h('br'), `${p.package_number || p.delivery_number || ''} · ${fmt.dt(p.taken_at)}`)))))) : null);
}
