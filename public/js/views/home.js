// Startseite: Projektübersicht
import { h, get, post, formDialog, btn, openCode, go, setScanHandler, fmt, can } from '../core.js';
import { scanField } from '../scanner.js';

export async function render(ctx) {
  const projects = await get('/projects');
  const field = scanField({
    label: 'Schnellzugriff',
    placeholder: 'Packstück, Lieferung, Material oder Projekt scannen …',
    onScan: (code) => openCode(code),
  });
  setScanHandler((code) => { field.run(code); });

  const newProject = () => formDialog({
    title: 'Neues Projekt',
    fields: [
      { name: 'number', label: 'Projektnummer (SAP)', required: true, autofocus: true, placeholder: 'z. B. P-12345' },
      { name: 'name', label: 'Projektbezeichnung / Maschine' },
      { name: 'customer', label: 'Kunde' },
      { name: 'destination', label: 'Zielort / Lieferadresse', type: 'textarea', wide: true },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (d) => {
      const p = await post('/projects', d);
      go(`#/p/${p.id}/items`);
    },
  });

  const cards = projects.map((p) => {
    const s = p.summary;
    return h('a', { class: 'pcard', href: `#/p/${p.id}` },
      h('div', { class: 'row' }, h('span', { class: 'nr' }, p.number), h('span', { class: 'spacer' }),
        s.positions_missing ? h('span', { class: 'chip s-FEHLTEIL' }, `${s.positions_missing} Fehlteil${s.positions_missing > 1 ? 'e' : ''}`) : null),
      h('div', null, h('b', null, p.name || '–'), h('div', { class: 'muted small' }, p.customer || '')),
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Verpackt'), h('span', { class: 'spacer' }), h('b', { class: 'num' }, `${fmt.num(s.progress_pct, 1)} %`)),
        h('div', { class: 'progress' }, h('span', { style: { width: `${Math.min(100, s.progress_pct)}%` } }))),
      h('div', { class: 'facts' },
        h('div', null, h('b', null, `${s.positions_complete}/${s.positions}`), 'Positionen'),
        h('div', null, h('b', null, `${s.hu_top}`), 'Packstücke'),
        h('div', null, h('b', null, `${s.hu_status.VERLADEN + s.hu_status.AUSGELIEFERT}`), 'verladen')));
  });

  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } },
    h('div', { class: 'page-head' },
      h('div', { class: 'titles' }, h('h1', null, 'Projekte'), h('p', { class: 'muted' }, 'Packvorrat, Packstücke und Versand je Projekt')),
      can('plan') && btn('Neues Projekt', newProject, { cls: 'primary', icon: 'plus' })),
    field,
    projects.length
      ? h('div', { class: 'cards' }, cards)
      : h('div', { class: 'panel' }, h('div', { class: 'empty stack' },
        h('h2', null, 'Noch keine Projekte'),
        h('p', null, 'Legen Sie ein Projekt an und importieren Sie den Packvorrat aus der Excel-Packliste oder dem SAP-Export der PSP-Elemente.'),
        can('plan') && h('div', { class: 'row', style: { justifyContent: 'center' } }, btn('Neues Projekt', newProject, { cls: 'primary', icon: 'plus' }))))));
}
