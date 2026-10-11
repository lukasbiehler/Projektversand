// Mobile Bilddokumentation: Aufnahme direkt mit der Gerätekamera, Speicherung am Packstück bzw. an der Lieferung
import { h, api, del, modal, toast, fmt, btn, confirmDialog, showError, state, can } from './core.js';

const MAX_EDGE = 2000;

/** Bild verkleinern (spart Speicher und Übertragungszeit im WLAN der Halle) */
async function prepare(file) {
  const okTypes = ['image/jpeg', 'image/png', 'image/webp'];
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (okTypes.includes(file.type)) return file;
    throw new Error(`Bildformat ${file.type || 'unbekannt'} wird nicht unterstützt. Bitte JPEG oder PNG verwenden.`);
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Bild konnte nicht verarbeitet werden.');
  return blob;
}

async function upload(file, params) {
  const blob = await prepare(file);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  return api('POST', `/photos?${qs}`, blob);
}

/**
 * Bildbereich.
 * target: { hu_id?, delivery_id?, huChoices?: [{id,label}] } ; phases: ['VERPACKUNG','VERLADUNG']
 */
export function photoPanel({ target, phases, photos, onChange, readOnlyReason }) {
  const meta = state.meta;
  const noteInput = h('input', { type: 'text', id: `photo-note-${phases.join('-')}`, placeholder: 'Bemerkung zum Bild (optional)', maxlength: 300 });
  let huSel = null;
  if (target.huChoices && target.huChoices.length) {
    huSel = h('select', { id: 'photo-hu' },
      h('option', { value: '' }, 'Lieferung gesamt'),
      target.huChoices.map((c) => h('option', { value: String(c.id) }, c.label)));
  }
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, hidden: true });
  let pending = null;
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length || !pending) return;
    const { phase, category } = pending;
    let n = 0;
    for (const f of files) {
      try {
        await upload(f, {
          hu_id: huSel && huSel.value ? huSel.value : target.hu_id,
          delivery_id: target.delivery_id,
          phase, category, note: noteInput.value.trim(),
        });
        n += 1;
      } catch (err) { showError(err); }
    }
    if (n) {
      toast(`${n} Bild${n > 1 ? 'er' : ''} gespeichert: ${meta.photo_categories[phase][category]}`, 'ok');
      noteInput.value = '';
      onChange?.();
    }
  });
  const take = (phase, category) => { pending = { phase, category }; fileInput.click(); };

  const groups = phases.map((phase) => h('div', { class: 'stack' },
    h('div', { class: 'label-caps' }, meta.photo_phases[phase]),
    h('div', { class: 'photo-cats' },
      Object.entries(meta.photo_categories[phase]).map(([cat, label]) => btn(label, () => take(phase, cat), { icon: 'camera', cls: 'small', disabled: !!readOnlyReason })))));

  const gallery = photos.length
    ? h('div', { class: 'gallery' }, photos.map((p) => h('button', { type: 'button', class: 'thumb', onclick: () => openPhoto(p, onChange) },
      h('img', { src: `/api/photos/${p.id}/file`, alt: p.category_label, loading: 'lazy' }),
      h('span', null, h('b', null, p.category_label), h('br'), `${fmt.dt(p.taken_at)} · ${p.taken_by || '–'}`,
        p.hu_id ? null : h('span', null, h('br'), 'Lieferung gesamt')))))
    : h('p', { class: 'muted small' }, 'Noch keine Bilder.');

  return h('div', { class: 'stack' },
    readOnlyReason ? h('p', { class: 'notice' }, readOnlyReason) : null,
    groups,
    h('div', { class: 'form-grid' },
      huSel ? h('label', { class: 'field' }, 'Bild zuordnen zu', huSel) : null,
      h('label', { class: 'field' }, 'Bemerkung', noteInput)),
    fileInput,
    gallery);
}

function openPhoto(p, onChange) {
  modal({
    title: `${p.phase_label}: ${p.category_label}`,
    wide: true,
    body: [
      h('div', { class: 'lightbox' }, h('img', { src: `/api/photos/${p.id}/file`, alt: p.category_label })),
      h('dl', { class: 'kv' },
        h('dt', null, 'Aufgenommen'), h('dd', null, `${fmt.dt(p.taken_at)} von ${p.taken_by || '–'}`),
        p.package_number ? [h('dt', null, 'Packstück'), h('dd', { class: 'mono' }, `${p.package_number} (${p.hu_number})`)] : null,
        p.delivery_number ? [h('dt', null, 'Lieferung'), h('dd', { class: 'mono' }, p.delivery_number)] : null,
        p.note ? [h('dt', null, 'Bemerkung'), h('dd', null, p.note)] : null),
    ],
    actions: [
      { label: 'Original öffnen', onClick: () => { window.open(`/api/photos/${p.id}/file`, '_blank', 'noopener'); } },
      !(can('pack') || can('load')) ? null : { label: 'Löschen', cls: 'danger', onClick: async (close) => {
        if (!(await confirmDialog('Bild wirklich löschen? Die Löschung wird protokolliert.', { ok: 'Löschen', danger: true }))) return;
        await del(`/photos/${p.id}`);
        toast('Bild gelöscht.', 'ok');
        close();
        onChange?.();
      } },
      { label: 'Schließen', cls: 'primary' },
    ].filter(Boolean),
  });
}
