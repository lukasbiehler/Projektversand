// Scannen: Hardware-Scanner (Tastatur-Emulation, z. B. Zebra DataWedge), Kamera (HTTPS) oder Foto eines Barcodes
import { h, append, btn, modal, loadScript, toast, feedback } from './core.js';

const LIB = '/vendor/html5-qrcode.min.js';

async function lib() {
  await loadScript(LIB);
  const L = window.__Html5QrcodeLibrary__;
  if (!L || !L.Html5Qrcode) throw new Error('Scan-Komponente nicht verfügbar.');
  return L;
}

function formats(L) {
  const F = L.Html5QrcodeSupportedFormats;
  return [F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.ITF, F.UPC_A, F.QR_CODE, F.DATA_MATRIX].filter((x) => x !== undefined);
}

/** Barcode aus einem Foto lesen (funktioniert auch ohne HTTPS) */
async function scanFromPhoto(file) {
  const L = await lib();
  const holder = h('div', { id: 'pv-file-reader', hidden: true });
  document.body.append(holder);
  try {
    const q = new L.Html5Qrcode('pv-file-reader', { formatsToSupport: formats(L), verbose: false });
    return await q.scanFile(file, false);
  } finally {
    holder.remove();
  }
}

/** Öffnet den Kamera-Scanner; liefert den gelesenen Code oder null */
export function cameraScan(title = 'Barcode / QR-Code scannen') {
  return new Promise((resolve) => {
    let done = false;
    let qr = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      stop().finally(() => { m.close(); resolve(code); });
    };
    const stop = async () => {
      if (qr) { try { if (qr.isScanning) await qr.stop(); qr.clear(); } catch { /* bereits gestoppt */ } }
      qr = null;
    };
    const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      status.textContent = 'Bild wird ausgewertet …';
      try {
        const code = await scanFromPhoto(f);
        finish(code);
      } catch {
        status.textContent = 'Im Foto wurde kein Barcode erkannt. Bitte näher und scharf fotografieren.';
        feedback(false);
      }
      fileInput.value = '';
    });
    const reader = h('div', { id: 'reader' });
    const status = h('p', { class: 'hint' });
    const photoBtn = btn('Foto aufnehmen & auswerten', () => fileInput.click(), { icon: 'camera' });
    const m = modal({
      title,
      body: [reader, status, h('div', { class: 'row' }, photoBtn, fileInput)],
      actions: [{ label: 'Abbrechen', onClick: () => finish(null) }],
      onClose: () => { if (!done) { done = true; stop(); resolve(null); } },
    });
    (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        reader.hidden = true;
        status.textContent = 'Live-Kamera ist nur über HTTPS verfügbar. Barcode einfach fotografieren – er wird aus dem Foto gelesen.';
        return;
      }
      try {
        const L = await lib();
        if (done) return;
        qr = new L.Html5Qrcode('reader', { formatsToSupport: formats(L), verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
        await qr.start(
          { facingMode: 'environment' },
          { fps: 12, qrbox: (w, hh) => ({ width: Math.floor(w * 0.85), height: Math.floor(Math.min(hh * 0.6, w * 0.6)) }) },
          (text) => finish(text),
          () => {},
        );
        status.textContent = 'Barcode in den Rahmen halten.';
      } catch (err) {
        reader.hidden = true;
        status.textContent = `Kamera nicht verfügbar (${err && err.message ? err.message : err}). Alternativ Foto aufnehmen.`;
      }
    })();
  });
}

/**
 * Scanfeld: Eingabe per Hardware-Scanner (Enter), Tastatur oder Kamera.
 * onScan(code) darf async sein; Rückgabe true/false steuert die Rückmeldung.
 */
export function scanField({ placeholder = 'Code scannen oder eingeben …', onScan, label, id = 'scan-input', autofocus = true, big = true }) {
  const input = h('input', {
    id, type: 'text', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go',
    'data-scan': '1', 'aria-label': label || placeholder,
  });
  const box = h('div', { class: big ? 'scan-hero' : '' });
  let busy = false;
  async function run(code) {
    code = String(code || '').trim();
    if (!code || busy) return;
    busy = true;
    input.value = '';
    try {
      const res = await onScan(code);
      if (res !== false) { feedback(true); flash(true); } else { feedback(false); flash(false); }
    } catch (err) {
      feedback(false);
      flash(false);
      toast(err.message || String(err), 'bad');
    } finally {
      busy = false;
      if (!matchMedia('(pointer: coarse)').matches) input.focus({ preventScroll: true });
    }
  }
  function flash(ok) {
    box.classList.remove('scan-flash-ok', 'scan-flash-bad');
    void box.offsetWidth;
    box.classList.add(ok ? 'scan-flash-ok' : 'scan-flash-bad');
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(input.value); }
  });
  input.addEventListener('focus', () => box.classList.add('active'));
  input.addEventListener('blur', () => box.classList.remove('active'));
  const cam = btn('', async () => { const c = await cameraScan(); if (c) run(c); }, { icon: 'camera', title: 'Mit Kamera scannen' });
  cam.setAttribute('aria-label', 'Mit Kamera scannen');
  const go = btn('OK', () => run(input.value), { cls: 'primary' });
  append(box, [
    label ? h('div', { class: 'label-caps' }, label) : null,
    h('div', { class: 'scanbox' }, input, cam, go),
  ]);
  if (autofocus && !matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus({ preventScroll: true }), 50);
  box.run = run;
  box.input = input;
  return box;
}
