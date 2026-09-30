'use strict';
// Etiketten als ZPL (Zebra-kompatible Etikettendrucker, stationär oder mobil über WLAN/Netzwerk)
// Formate: Handling Unit 100 × 150 mm, Einzelartikel 100 × 50 mm

const net = require('node:net');

const LABEL_SIZES = {
  hu: { width: 100, height: 150 },
  item: { width: 100, height: 50 },
};

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const nf3 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });

function fmtWeight(l) {
  if (l.weight_kg === null || l.weight_kg === undefined) return '–';
  return `${l.weight_complete ? '' : 'ca. '}${nf1.format(l.weight_kg)} kg`;
}

function fmtDims(l) {
  if (!l.length_cm || !l.width_cm || !l.height_cm) return '–';
  return `${nf1.format(l.length_cm)} × ${nf1.format(l.width_cm)} × ${nf1.format(l.height_cm)} cm`;
}

/** Sonderzeichen für ^FH_ maskieren */
function esc(s) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[_^~]/g, (c) => '_' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function builder(dpi, widthMm, heightMm) {
  const k = dpi / 25.4;
  const d = (mm) => Math.round(mm * k);
  const out = ['^XA', '^CI28', `^PW${d(widthMm)}`, `^LL${d(heightMm)}`, '^LH0,0'];
  const api = {
    text(x, y, h, s, { w, lines = 1, align = 'L', bold = false } = {}) {
      const hd = d(h);
      const wd = Math.round(hd * (bold ? 1 : 0.85));
      out.push(`^FO${d(x)},${d(y)}^A0N,${hd},${wd}${w ? `^FB${d(w)},${lines},0,${align},0` : ''}^FH_^FD${esc(s)}^FS`);
    },
    hline(x, y, w, t = 0.3) {
      out.push(`^FO${d(x)},${d(y)}^GB${d(w)},${Math.max(1, d(t))},${Math.max(1, d(t))}^FS`);
    },
    barcode(x, y, h, value, symbology, maxW, size2d) {
      const v = String(value);
      const hd = d(h);
      switch (symbology) {
        case 'QR': {
          const mag = Math.max(1, Math.min(10, Math.floor(d(size2d) / (21 + 4 * Math.ceil(v.length / 20)))));
          out.push(`^FO${d(x)},${d(y)}^BQN,2,${mag}^FH_^FDMA,${esc(v)}^FS`);
          return;
        }
        case 'DATAMATRIX': {
          const mag = Math.max(1, Math.min(12, Math.floor(d(size2d) / (14 + Math.ceil(v.length / 3)))));
          out.push(`^FO${d(x)},${d(y)}^BXN,${mag},200^FH_^FD${esc(v)}^FS`);
          return;
        }
        case 'EAN13':
          out.push(`^FO${d(x)},${d(y)}^BY${moduleWidth(95 + 18, maxW)},3,${hd}^BEN,${hd},Y,N^FD${v.slice(0, 12)}^FS`);
          return;
        case 'EAN8':
          out.push(`^FO${d(x)},${d(y)}^BY${moduleWidth(67 + 18, maxW)},3,${hd}^B8N,${hd},Y,N^FD${v.slice(0, 7)}^FS`);
          return;
        case 'CODE39':
          out.push(`^FO${d(x)},${d(y)}^BY${moduleWidth((v.length + 2) * 16, maxW)},3,${hd}^B3N,N,${hd},Y,N^FD${esc(v)}^FS`);
          return;
        case 'ITF':
          out.push(`^FO${d(x)},${d(y)}^BY${moduleWidth(v.length * 9 + 20, maxW)},3,${hd}^B2N,${hd},Y,N,N^FD${v}^FS`);
          return;
        default: // CODE128
          out.push(`^FO${d(x)},${d(y)}^BY${moduleWidth(v.length * 11 + 35, maxW)},3,${hd}^BCN,${hd},Y,N,N,A^FH_^FD${esc(v)}^FS`);
      }
    },
    end() {
      out.push('^XZ');
      return out.join('\n');
    },
  };
  function moduleWidth(modules, maxWmm) {
    return Math.max(1, Math.min(4, Math.floor(d(maxWmm) / modules)));
  }
  return api;
}

function huZpl(l, dpi) {
  const { width, height } = LABEL_SIZES.hu;
  const b = builder(dpi, width, height);
  b.text(4, 4, 4, l.header, { w: 55 });
  b.text(55, 3.5, 5.5, l.packaging, { w: 41, align: 'R', bold: true });
  b.hline(4, 11, 92);
  b.text(4, 13, 3, 'Projekt');
  b.text(4, 17, 9, l.project_number, { w: 92, bold: true });
  b.text(4, 27, 4, l.project_name, { w: 92 });
  b.hline(4, 33, 92);
  b.text(4, 35, 3, 'Packstück-Nr.');
  b.text(4, 39, 9, l.package_number, { w: 92, bold: true });
  b.text(4, 50, 4.5, l.description, { w: 92, lines: 2 });
  b.hline(4, 61, 92);
  b.text(4, 63, 3, 'PSP-Element');
  b.text(4, 67, 5, l.psp || '–', { w: 46 });
  b.text(52, 63, 3, 'Versandstatus');
  b.text(52, 67, 5, l.ship_status, { w: 44, bold: true });
  b.hline(4, 74, 92);
  b.text(4, 76, 3, 'Gewicht brutto');
  b.text(4, 80, 6, fmtWeight(l), { w: 46, bold: true });
  b.text(52, 76, 3, 'Abmessungen L × B × H');
  b.text(52, 80, 5, fmtDims(l), { w: 44 });
  b.hline(4, 89, 92);
  b.text(4, 91, 3, 'Zielort / Kunde');
  b.text(4, 95, 4.5, [l.destination, l.customer].filter(Boolean).join(' – ') || '–', { w: 92, lines: 2 });
  b.hline(4, 106, 92);
  b.barcode(4, 110, 18, l.barcode.value, 'CODE128', 62);
  b.barcode(70, 108, 0, l.qr, 'QR', 0, 26);
  const extra = [l.parent ? `in ${l.parent}` : '', l.delivery ? `Lieferung ${l.delivery}` : ''].filter(Boolean).join('  ·  ');
  b.text(4, 137, 4.5, `HU ${l.hu_number}`, { w: 92, bold: true });
  if (extra) b.text(4, 143, 3.5, extra, { w: 92 });
  return b.end();
}

function itemZpl(l, dpi) {
  const { width, height } = LABEL_SIZES.item;
  const b = builder(dpi, width, height);
  b.text(4, 2.5, 6.5, l.material_number, { w: 62, bold: true });
  b.text(66, 3, 3, l.header, { w: 30, align: 'R' });
  b.text(4, 10, 3.6, l.description, { w: 92, lines: 2 });
  b.text(4, 18.5, 3.2, `Projekt ${l.project_number}${l.psp ? '  ·  PSP ' + l.psp : ''}${l.package_number ? '  ·  Packstück ' + l.package_number : ''}`, { w: 92 });
  b.text(4, 23, 3.8, `Menge: ${nf3.format(l.qty)} ${l.unit}`, { w: 44, bold: true });
  b.text(48, 23, 3.4, `Status: ${l.status}`, { w: 48 });
  const sym = l.barcode.symbology;
  if (sym === 'QR' || sym === 'DATAMATRIX') {
    b.barcode(4, 29, 0, l.barcode.value, sym, 0, 18);
    b.text(26, 38, 3.2, l.barcode.value, { w: 70 });
  } else {
    b.barcode(4, 29, 11, l.barcode.value, sym, 90);
  }
  return b.end();
}

function toZpl(labels, dpi = 203) {
  return labels.map((l) => (l.kind === 'hu' ? huZpl(l, dpi) : itemZpl(l, dpi))).join('\n');
}

/** ZPL roh an einen Netzwerkdrucker (Port 9100) senden */
function sendRaw(host, port, data, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.end(Buffer.from(data, 'utf8')));
    sock.on('timeout', () => { failed = true; sock.destroy(); reject(new Error('Zeitüberschreitung – Drucker nicht erreichbar')); });
    sock.on('error', (err) => { failed = true; reject(new Error(`Drucker nicht erreichbar (${err.code || err.message})`)); });
    sock.on('close', () => { if (!failed) resolve(); });
  });
}

module.exports = { toZpl, sendRaw, LABEL_SIZES, esc };
