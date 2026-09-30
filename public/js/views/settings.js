// Einstellungen: Benutzer, Etiketten, Nummernkreise, Barcode-Muster, SAP-Schnittstelle, Drucker
import { h, get, put, post, del, btn, fmt, toast, formDialog, confirmDialog, getUser, setUser, showError, downloadBlob, notifyChanged, state, optionList } from '../core.js';

export async function render(ctx) {
  const [s, printers, outbox, vtypes] = await Promise.all([get('/settings'), get('/printers'), get('/sap/outbox?limit=50'), get('/vehicle-types')]);

  // ---------------------------------------------------------------- Allgemein
  const f = (name, label, value, extra = {}) => h('label', { class: `field${extra.wide ? ' wide' : ''}` }, label,
    extra.select
      ? h('select', { name, id: `set-${name}`, value }, extra.select.map(([v, l]) => h('option', { value: v }, l)))
      : h('input', { name, id: `set-${name}`, value: value ?? '', placeholder: extra.placeholder, type: extra.type }),
    extra.hint ? h('span', { class: 'hint' }, extra.hint) : null);
  const userInput = h('input', { id: 'set-user', value: getUser() });
  const general = h('form', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Benutzer an diesem Gerät', userInput, h('span', { class: 'hint' }, 'Wird bei jeder Buchung protokolliert')),
    f('label_header', 'Kopfzeile auf Etiketten', s.label_header, { hint: 'z. B. Firmenname oder Werk' }),
    f('label_dpi', 'Auflösung ZPL-Dateien', s.label_dpi, { select: [['203', '203 dpi'], ['300', '300 dpi'], ['600', '600 dpi']] }),
    f('hu_prefix', 'Präfix HU-Nummern', s.hu_prefix, { hint: 'HU-Nummer = Präfix + 8 Ziffern' }),
    f('delivery_prefix', 'Präfix Lieferungsnummern', s.delivery_prefix, { hint: 'Nur für automatisch vergebene Nummern' }),
    f('barcode_regex', 'Barcode-Muster (optional, regulärer Ausdruck)', s.barcode_regex, { wide: true, placeholder: 'z. B. ^MAT:([^;]+);', hint: 'Nur nötig, wenn bestehende Etiketten zusammengesetzte Codes enthalten. Die erste Klammergruppe liefert die Materialnummer. Einfache Barcodes werden ohne Muster erkannt.' }),
    h('div', { class: 'row wide' }, h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  general.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(general));
    try {
      if (userInput.value.trim()) setUser(userInput.value.trim().slice(0, 60));
      document.getElementById('userbtn').textContent = getUser() || 'Anmelden';
      await put('/settings', body);
      toast('Einstellungen gespeichert.', 'ok');
      notifyChanged();
    } catch (err) { showError(err); }
  });

  // ---------------------------------------------------------------- SAP
  const st = outbox.stats;
  const sapForm = h('form', { class: 'form-grid' },
    f('sap_enabled', 'Übertragung an SAP', s.sap_enabled, { select: [['0', 'Aus (Nachrichten sammeln)'], ['1', 'Ein (sofort übertragen)']] }),
    f('sap_endpoint', 'Endpunkt (HTTP POST, JSON)', s.sap_endpoint, { wide: true, placeholder: 'https://sap-gateway.firma.local/sap/opu/…', type: 'url' }),
    f('sap_auth', 'Authorization-Header', s.sap_auth, { wide: true, placeholder: 'z. B. Basic … oder Bearer …', hint: s.sap_auth_set ? 'Hinterlegt. Zum Ändern neu eingeben.' : 'Optional' }),
    h('div', { class: 'row wide' }, h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  sapForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await put('/settings', Object.fromEntries(new FormData(sapForm))); toast('SAP-Einstellungen gespeichert.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
  });
  const exportJson = async (mark) => {
    const res = await fetch(`/api/sap/export${mark ? '?mark=1' : ''}`, { headers: { 'X-User': encodeURIComponent(getUser()) } });
    if (!res.ok) throw new Error('Export fehlgeschlagen.');
    downloadBlob(await res.blob(), `sap-nachrichten-${new Date().toISOString().slice(0, 10)}.json`);
    if (mark) notifyChanged();
  };
  const statusTag = (x) => h('span', { class: `tag${x === 'SENT' ? ' ok' : x === 'ERROR' ? ' warn' : ''}` },
    { PENDING: 'wartet', SENT: 'übertragen', ERROR: 'Fehler', EXPORTED: 'exportiert' }[x] || x);
  const sapPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'SAP-Rückmeldung (Echtzeit)')),
    h('div', { class: 'panel-body' },
      h('p', { class: 'hint' }, 'Jede Buchung (HU angelegt, Material verpackt/entnommen, Verschachtelung, Status, Verladung, Warenausgang, Zustellung, Fehlteile) wird als Nachricht in exakt der Buchungsreihenfolge an den Endpunkt übertragen – z. B. einen SOMA- oder SAP-Gateway-Service. Ohne Verbindung bleiben die Nachrichten erhalten und werden automatisch nachgesendet.'),
      h('div', { class: 'kpis' },
        kpi('Wartend', st.PENDING), kpi('Fehler', st.ERROR, st.ERROR > 0), kpi('Übertragen', st.SENT), kpi('Exportiert', st.EXPORTED)),
      st.last_error ? h('p', { class: 'notice bad' }, `Letzter Fehler: ${st.last_error}`) : null,
      !st.enabled ? h('p', { class: 'notice warn' }, 'Übertragung ist ausgeschaltet oder kein Endpunkt hinterlegt. Nachrichten werden gesammelt.') : null,
      sapForm,
      h('div', { class: 'row' },
        btn('Fehlgeschlagene erneut senden', async () => { try { await post('/sap/retry'); toast('Übertragung angestoßen.', 'ok'); setTimeout(() => ctx.refresh(), 800); } catch (err) { showError(err); } }),
        btn('Offene als JSON exportieren', () => exportJson(false).catch(showError), { icon: 'upload' }),
        btn('Exportieren & als übertragen markieren', async () => {
          if (!(await confirmDialog('Offene Nachrichten exportieren und als „exportiert“ markieren? Sie werden dann nicht mehr automatisch gesendet.', { ok: 'Exportieren' }))) return;
          exportJson(true).catch(showError);
        })),
      h('div', { class: 'table-wrap', style: { maxHeight: '320px', overflow: 'auto' } }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Nr.'), h('th', null, 'Zeit'), h('th', null, 'Nachricht'), h('th', null, 'Status'), h('th', null, 'Details'))),
        h('tbody', null, outbox.rows.map((r) => h('tr', null,
          h('td', { class: 'num' }, r.id), h('td', { class: 'small nowrap' }, fmt.dt(r.created_at)), h('td', { class: 'mono small' }, r.type),
          h('td', null, statusTag(r.status), r.attempts > 1 ? h('div', { class: 'sub' }, `${r.attempts} Versuche`) : null),
          h('td', { class: 'small' }, r.last_error || summarize(r.payload)))))))));

  // ---------------------------------------------------------------- Drucker
  const printerDialog = (p) => formDialog({
    title: p ? `Drucker ${p.name}` : 'Etikettendrucker hinzufügen',
    intro: h('p', { class: 'hint' }, 'ZPL-fähige Etikettendrucker (z. B. Zebra) im Netzwerk/WLAN – stationär oder mobil. Übertragung direkt über Port 9100.'),
    fields: [
      { name: 'name', label: 'Name', value: p ? p.name : '', required: true, autofocus: true, placeholder: 'z. B. Versand Tor 3' },
      { name: 'host', label: 'IP-Adresse / Hostname', value: p ? p.host : '', required: true },
      { name: 'port', label: 'Port', type: 'number', value: p ? p.port : 9100, required: true },
      { name: 'dpi', label: 'Auflösung', type: 'select', value: String(p ? p.dpi : 203), options: [{ value: '203', label: '203 dpi' }, { value: '300', label: '300 dpi' }, { value: '600', label: '600 dpi' }] },
    ],
    onSubmit: async (v) => {
      const body = { ...v, dpi: Number(v.dpi) };
      if (p) await put(`/printers/${p.id}`, body); else await post('/printers', body);
      toast('Drucker gespeichert.', 'ok');
    },
  });
  const printerPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Etikettendrucker (Netzwerk / WLAN)'), btn('Drucker hinzufügen', () => printerDialog(), { icon: 'plus' })),
    h('div', { class: 'panel-body' },
      h('p', { class: 'hint' }, 'Ohne eingerichteten Drucker wird über den Druckdialog des Geräts gedruckt (Etikettengrößen 100 × 150 mm und 100 × 50 mm werden automatisch gesetzt). ZPL-Dateien können zusätzlich heruntergeladen werden.'),
      printers.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Adresse'), h('th', null, 'Auflösung'), h('th', null, ''))),
        h('tbody', null, printers.map((p) => h('tr', null,
          h('td', null, p.name), h('td', { class: 'mono' }, `${p.host}:${p.port}`), h('td', null, `${p.dpi} dpi`),
          h('td', { class: 'nowrap' },
            btn('Testdruck', async () => { try { await post(`/printers/${p.id}/test`); toast('Testdruck gesendet.', 'ok'); } catch (err) { showError(err); } }, { cls: 'small ghost', icon: 'print' }),
            btn('Bearbeiten', () => printerDialog(p), { cls: 'small ghost' }),
            btn('Löschen', async () => {
              if (!(await confirmDialog(`Drucker ${p.name} löschen?`, { ok: 'Löschen', danger: true }))) return;
              try { await del(`/printers/${p.id}`); notifyChanged(); } catch (err) { showError(err); }
            }, { cls: 'small ghost danger' }))))))) : h('p', { class: 'muted' }, 'Kein Netzwerkdrucker eingerichtet.')));

  // ---------------------------------------------------------------- Fahrzeug- und Containertypen (Ladeplanung)
  const vtDialog = (t, copy) => formDialog({
    title: t && !copy ? `Laderaum-Typ ${t.name}` : 'Laderaum-Typ anlegen',
    intro: h('p', { class: 'hint' }, 'Innenmaße des Laderaums. Achsmodell optional: Abstützpunkte ab Stirnwand der Ladefläche in cm (vorne = Königszapfen bzw. Vorderachse, negativ = vor der Ladefläche; hinten = Mitte Achsaggregat), dazu Leergewichtsanteile und zulässige Lasten. Ohne Achsmodell kann ein Schwerpunktfenster (± % der Länge um die Mitte, z. B. 10 für Container) geprüft werden.'),
    wide: true,
    fields: [
      { name: 'name', label: 'Bezeichnung', value: t ? (copy ? `${t.name} (Kopie)` : t.name) : '', required: true, autofocus: true, wide: true },
      { name: 'category', label: 'Kategorie', type: 'select', value: t ? t.category : 'LKW', options: optionList(state.meta.vehicle_categories) },
      { name: 'max_payload_kg', label: 'Nutzlast (kg)', type: 'number', step: 'any', min: 0, value: t ? t.max_payload_kg : null },
      { name: 'length_cm', label: 'Innenlänge (cm)', type: 'number', step: 'any', min: 0, value: t ? t.length_cm : null, required: true },
      { name: 'width_cm', label: 'Innenbreite (cm)', type: 'number', step: 'any', min: 0, value: t ? t.width_cm : null, required: true },
      { name: 'height_cm', label: 'Innenhöhe (cm)', type: 'number', step: 'any', min: 0, value: t ? t.height_cm : null, required: true },
      { name: 'cog_tolerance_pct', label: 'Schwerpunktfenster ± % (optional)', type: 'number', step: 'any', min: 0, value: t ? t.cog_tolerance_pct : null },
      { name: 'axle_front_x_cm', label: 'Abstützung vorne: Position (cm)', type: 'number', step: 'any', value: t ? t.axle_front_x_cm : null },
      { name: 'axle_rear_x_cm', label: 'Abstützung hinten: Position (cm)', type: 'number', step: 'any', value: t ? t.axle_rear_x_cm : null },
      { name: 'axle_front_empty_kg', label: 'Leergewicht vorne (kg)', type: 'number', step: 'any', min: 0, value: t ? t.axle_front_empty_kg : null },
      { name: 'axle_rear_empty_kg', label: 'Leergewicht hinten (kg)', type: 'number', step: 'any', min: 0, value: t ? t.axle_rear_empty_kg : null },
      { name: 'axle_front_max_kg', label: 'Zulässig vorne (kg)', type: 'number', step: 'any', min: 0, value: t ? t.axle_front_max_kg : null },
      { name: 'axle_rear_max_kg', label: 'Zulässig hinten (kg)', type: 'number', step: 'any', min: 0, value: t ? t.axle_rear_max_kg : null },
      { name: 'note', label: 'Hinweis', value: t ? t.note : '', wide: true },
    ],
    onSubmit: async (v) => {
      if (t && !copy) await put(`/vehicle-types/${t.id}`, v); else await post('/vehicle-types', v);
      toast('Laderaum-Typ gespeichert.', 'ok');
    },
  });
  const vtPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Fahrzeuge & Container für die Ladeplanung (${vtypes.length})`), btn('Typ anlegen', () => vtDialog(null), { icon: 'plus' })),
    h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'Vorlagen sind Richtwerte – Maße, Nutzlast und Achslasten an die eingesetzten Fahrzeuge anpassen. Bestehende Ladepläne behalten die Werte zum Zeitpunkt ihrer Erstellung.')),
    h('div', { class: 'panel-body flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Typ'), h('th', null, 'Innenmaße L × B × H'), h('th', { class: 'num' }, 'Nutzlast'), h('th', null, 'Achsmodell / Schwerpunkt'), h('th', null, ''))),
      h('tbody', null, vtypes.map((t) => h('tr', null,
        h('td', null, h('b', null, t.name), h('div', { class: 'sub' }, state.meta.vehicle_categories[t.category] || t.category), t.note ? h('div', { class: 'sub' }, t.note) : null),
        h('td', { class: 'nowrap' }, `${fmt.num(t.length_cm, 1)} × ${fmt.num(t.width_cm, 1)} × ${fmt.num(t.height_cm, 1)} cm`),
        h('td', { class: 'num' }, t.max_payload_kg ? fmt.kg(t.max_payload_kg) : '–'),
        h('td', { class: 'small' }, t.axle_front_x_cm !== null ? `vorne ${fmt.num(t.axle_front_x_cm, 0)} cm (max. ${t.axle_front_max_kg ? fmt.kg(t.axle_front_max_kg) : '–'}), hinten ${fmt.num(t.axle_rear_x_cm, 0)} cm (max. ${t.axle_rear_max_kg ? fmt.kg(t.axle_rear_max_kg) : '–'})`
          : t.cog_tolerance_pct !== null ? `Schwerpunkt ±${fmt.num(t.cog_tolerance_pct, 1)} %` : '–'),
        h('td', { class: 'nowrap' },
          btn('Bearbeiten', () => vtDialog(t), { cls: 'small ghost' }),
          btn('Kopieren', () => vtDialog(t, true), { cls: 'small ghost' }),
          btn('Löschen', async () => {
            if (!(await confirmDialog(`Typ „${t.name}“ löschen? Bestehende Ladepläne bleiben unverändert.`, { ok: 'Löschen', danger: true }))) return;
            try { await del(`/vehicle-types/${t.id}`); notifyChanged(); } catch (err) { showError(err); }
          }, { cls: 'small ghost danger' })))))))));

  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } },
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Einstellungen'))),
    h('div', { class: 'grid-2' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Allgemein')), h('div', { class: 'panel-body' }, general)),
      printerPanel),
    vtPanel,
    sapPanel,
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Mobile Geräte & Scanner')),
      h('div', { class: 'panel-body' },
        h('p', null, 'Hardware-Scanner (z. B. Zebra, Honeywell) im Tastatur-Modus mit Enter als Abschluss konfigurieren – Scans werden auf jeder Seite erkannt. Kamera-Scan im Browser benötigt HTTPS (Server mit „npm run start:https“ starten); ohne HTTPS kann ein Barcode fotografiert und ausgewertet werden.'),
        h('p', { class: 'hint' }, 'Tipp: Seite „Scannen“ auf dem Mobilgerät zum Startbildschirm hinzufügen.')))));
}

function kpi(label, value, alert) {
  return h('div', { class: `kpi${alert ? ' alert' : ''}` }, h('span', { class: 'label-caps' }, label), h('span', { class: 'v' }, value));
}

function summarize(payload) {
  try {
    const p = JSON.parse(payload);
    return [p.hu, p.material ? `${p.material}${p.qty !== undefined ? ' × ' + fmt.num(p.qty) : ''}` : '', p.delivery, p.pack_status || '', p.ship_status || '', p.status || '']
      .filter(Boolean).join(' · ');
  } catch { return ''; }
}
