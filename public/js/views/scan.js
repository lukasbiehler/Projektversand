// Mobile Scan-Seite: beliebigen Code scannen und direkt das Packstück, die Lieferung oder das Material öffnen
import { h, openCode, setScanHandler } from '../core.js';
import { scanField, cameraScan } from '../scanner.js';

export async function render(ctx) {
  const field = scanField({
    label: 'Code scannen',
    placeholder: 'Packstück, Lieferung, Material, PSP …',
    onScan: (code) => openCode(code),
  });
  setScanHandler((code) => { field.run(code); });
  const camBtn = h('button', { type: 'button', class: 'btn primary big', style: { width: '100%' }, onclick: async () => { const c = await cameraScan(); if (c) field.run(c); } }, 'Kamera öffnen');
  ctx.show(h('div', { class: 'stack', style: { gap: '18px', maxWidth: '640px', margin: '0 auto', width: '100%' } },
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Scannen'),
      h('p', { class: 'muted' }, 'Etikett scannen – das zugehörige Packstück, die Lieferung oder die Materialsuche öffnet sich direkt.'))),
    field,
    camBtn,
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('div', { class: 'label-caps' }, 'Was wird erkannt?'),
      h('ul', { style: { margin: 0, paddingLeft: '18px' } },
        h('li', null, 'HU- oder Packstück-Etikett → Packstück (Verpacken, Status, Bilder)'),
        h('li', null, 'Lieferungsnummer → Verladung'),
        h('li', null, 'Bestehendes Artikeletikett (SAP-Barcode) oder Materialnummer → Rückwärtssuche'),
        h('li', null, 'PSP-Element oder Projektnummer → Suche bzw. Projekt'))))));
}
