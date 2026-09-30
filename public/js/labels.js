// Etiketten (Einzelartikel 100×50 mm, Handling Unit 100×150 mm) – Browserdruck, Netzwerkdrucker (ZPL), ZPL-Datei
import { h, append, api, post, get, modal, toast, fmt, loadScript, downloadBlob, getUser } from './core.js';

const BCID = { CODE128: 'code128', EAN13: 'ean13', EAN8: 'ean8', CODE39: 'code39', ITF: 'interleaved2of5', QR: 'qrcode', DATAMATRIX: 'datamatrix' };

async function bwip() {
  await loadScript('/vendor/bwip-js.min.js');
  if (!window.bwipjs || !window.bwipjs.toSVG) throw new Error('Barcode-Komponente nicht verfügbar.');
  return window.bwipjs;
}

function svgFrom(str) {
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
  const el = document.importNode(doc.documentElement, true);
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  return el;
}

/** Barcode als SVG rendern (Symbologie wie im SAP-Materialstamm hinterlegt) */
export function barcodeSvg(B, value, symbology, { heightMm = 12 } = {}) {
  const bcid = BCID[symbology] || 'code128';
  const twoD = bcid === 'qrcode' || bcid === 'datamatrix';
  const opts = twoD
    ? { bcid, text: value, scale: 3 }
    : { bcid, text: value, scale: 2, height: heightMm, includetext: true, textxalign: 'center', textsize: 9 };
  if (bcid === 'ean13' || bcid === 'ean8') opts.includetext = true;
  try {
    return svgFrom(B.toSVG(opts));
  } catch {
    // Ungültig für die Symbologie → Code 128 als Rückfall, damit das Etikett lesbar bleibt
    return svgFrom(B.toSVG({ bcid: 'code128', text: value, scale: 2, height: heightMm, includetext: true, textxalign: 'center', textsize: 9 }));
  }
}

function dims(l) {
  return l.length_cm && l.width_cm && l.height_cm ? fmt.dims(l) : '–';
}

function huLabel(B, l) {
  const extra = [l.parent ? `in ${l.parent}` : '', l.delivery ? `Lieferung ${l.delivery}` : ''].filter(Boolean).join('  ·  ');
  return h('div', { class: 'lbl lbl-hu' },
    h('div', { class: 'sec', style: { display: 'flex', justifyContent: 'space-between', gap: '2mm', alignItems: 'baseline' } },
      h('span', { class: 'txt' }, l.header), h('span', { class: 'mid' }, l.packaging)),
    h('div', { class: 'sec' }, h('div', { class: 'cap' }, 'Projekt'), h('div', { class: 'big' }, l.project_number), h('div', { class: 'txt' }, l.project_name || '')),
    h('div', { class: 'sec' }, h('div', { class: 'cap' }, 'Packstück-Nr.'), h('div', { class: 'big' }, l.package_number),
      h('div', { class: 'txt clamp2' }, l.description || '')),
    h('div', { class: 'sec two' },
      h('div', null, h('div', { class: 'cap' }, 'PSP-Element'), h('div', { class: 'mid' }, l.psp || '–')),
      h('div', null, h('div', { class: 'cap' }, 'Versandstatus'), h('div', { class: 'mid' }, l.ship_status))),
    h('div', { class: 'sec two' },
      h('div', null, h('div', { class: 'cap' }, 'Gewicht brutto'), h('div', { class: 'mid' }, l.weight_kg === null ? '–' : `${l.weight_complete ? '' : 'ca. '}${fmt.kg(l.weight_kg)}`)),
      h('div', null, h('div', { class: 'cap' }, 'Abmessungen L × B × H'), h('div', { class: 'mid' }, dims(l)))),
    h('div', { class: 'sec' }, h('div', { class: 'cap' }, 'Zielort / Kunde'),
      h('div', { class: 'txt clamp2' }, [l.destination, l.customer].filter(Boolean).join(' – ') || '–')),
    h('div', null,
      h('div', { class: 'codes' },
        h('div', { class: 'bc1' }, barcodeSvg(B, l.barcode.value, 'CODE128', { heightMm: 16 })),
        h('div', null, barcodeSvg(B, l.qr, 'QR'))),
      h('div', { class: 'foot' }, `HU ${l.hu_number}`),
      extra ? h('div', { class: 'txt' }, extra) : null));
}

function itemLabel(B, l) {
  const twoD = l.barcode.symbology === 'QR' || l.barcode.symbology === 'DATAMATRIX';
  const info = [`Projekt ${l.project_number}`, l.psp ? `PSP ${l.psp}` : '', l.package_number ? `Packstück ${l.package_number}` : ''].filter(Boolean).join('  ·  ');
  return h('div', { class: 'lbl lbl-item' },
    h('div', { class: 'head' }, h('span', { class: 'matnr' }, l.material_number), h('span', { class: 'cap' }, l.header)),
    h('div', { class: 'txt clamp2' }, l.description),
    h('div', { class: 'txt' }, info),
    h('div', { class: 'head' }, h('span', { class: 'mid' }, `Menge: ${fmt.qty(l.qty, l.unit)}`), h('span', { class: 'txt' }, `Status: ${l.status}`)),
    h('div', { class: `bc${twoD ? ' bc2d' : ''}` }, barcodeSvg(B, l.barcode.value, l.barcode.symbology, { heightMm: 9 }),
      twoD ? h('span', { class: 'txt' }, l.barcode.value) : null));
}

export async function renderLabels(labels) {
  const B = await bwip();
  return labels.map((l) => (l.kind === 'hu' ? huLabel(B, l) : itemLabel(B, l)));
}

/** Inhalt drucken (Etiketten oder Dokument) über den Druckdialog des Geräts (stationär oder mobil) */
export function printNodes(nodes) {
  const root = document.getElementById('print-root');
  root.replaceChildren();
  append(root, nodes);
  const cleanup = () => { root.replaceChildren(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 60);
}

/**
 * Druckdialog für Etiketten.
 * specs: [{kind:'hu', hu_id} | {kind:'item', item_id, hu_id?, qty?}]
 */
export async function openLabelDialog(specs, { title = 'Etiketten drucken' } = {}) {
  if (!specs.length) { toast('Keine Etiketten ausgewählt.', 'warn'); return; }
  const [printers, settings] = await Promise.all([get('/printers'), get('/settings')]);
  const copies = h('input', { type: 'number', min: 1, max: 50, value: '1', id: 'lbl-copies', inputmode: 'numeric' });
  const printerSel = h('select', { id: 'lbl-printer' }, printers.map((p) => h('option', { value: String(p.id) }, `${p.name} (${p.host}, ${p.dpi} dpi)`)));
  const dpiSel = h('select', { id: 'lbl-dpi', value: settings.label_dpi }, ['203', '300', '600'].map((d) => h('option', { value: d }, `${d} dpi`)));
  const preview = h('div', { class: 'label-preview' }, h('p', { class: 'muted' }, 'Vorschau wird erstellt …'));
  const withCopies = () => {
    const n = Math.min(Math.max(parseInt(copies.value, 10) || 1, 1), 50);
    return specs.map((s) => ({ ...s, copies: n }));
  };
  const hus = specs.filter((s) => s.kind === 'hu').length;
  const items = specs.length - hus;
  const m = modal({
    title,
    wide: true,
    body: [
      h('p', null, [hus ? `${hus} Packstück-Etikett(en) 100 × 150 mm` : '', items ? `${items} Artikeletikett(en) 100 × 50 mm` : ''].filter(Boolean).join(', ')),
      preview,
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Exemplare je Etikett', copies),
        printers.length ? h('label', { class: 'field' }, 'Netzwerk-/WLAN-Etikettendrucker (ZPL)', printerSel)
          : h('p', { class: 'hint' }, 'Kein Netzwerkdrucker eingerichtet (Einstellungen → Drucker).'),
        h('label', { class: 'field' }, 'Auflösung für ZPL-Datei', dpiSel)),
      h('p', { class: 'hint' }, 'Browserdruck: Etikettendrucker im Druckdialog wählen – funktioniert stationär und mit mobilen Druckern (z. B. über den Druckdienst des Mobilgeräts). Papierformat wird automatisch gesetzt.'),
    ],
    actions: [
      { label: 'ZPL-Datei', icon: 'upload', onClick: async () => {
        const res = await fetch('/api/labels/zpl', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': encodeURIComponent(getUser()) },
          body: JSON.stringify({ labels: withCopies(), dpi: Number(dpiSel.value) }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ZPL konnte nicht erzeugt werden.');
        downloadBlob(await res.blob(), 'etiketten.zpl');
      } },
      ...(printers.length ? [{ label: 'An Drucker senden', icon: 'print', onClick: async (close) => {
        const r = await post('/print', { printer_id: Number(printerSel.value), labels: withCopies() });
        toast(`${r.count} Etikett(en) an ${r.printer} gesendet.`, 'ok');
        close();
      } }] : []),
      { label: 'Drucken (Browser)', cls: 'primary', icon: 'print', onClick: async (close) => {
        const labels = await post('/labels/data', { labels: withCopies() });
        const nodes = await renderLabels(labels);
        close();
        printNodes(nodes);
      } },
    ],
  });
  try {
    const labels = await post('/labels/data', { labels: specs.slice(0, 12) });
    const nodes = await renderLabels(labels);
    preview.replaceChildren();
    append(preview, nodes);
    if (specs.length > 12) append(preview, [h('p', { class: 'muted' }, `… und ${specs.length - 12} weitere`)]);
    const noMaster = labels.filter((l) => l.kind === 'item' && !l.barcode_from_master);
    if (noMaster.length) {
      m.body.insertBefore(h('p', { class: 'notice warn' },
        `Für ${noMaster.length} Material(ien) ist kein SAP-Barcode im Materialstamm hinterlegt – es wird die Materialnummer als Code 128 gedruckt.`), preview);
    }
  } catch (err) {
    preview.replaceChildren(h('p', { class: 'err' }, err.message));
  }
  return m;
}

export { api };
