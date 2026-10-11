// Benutzer & Zugriff (nur Administratoren): Konten, Rollen, Zugriffsschlüssel für Fremdsysteme, Sicherheitsprotokoll
import { h, get, post, put, del, btn, fmt, toast, modal, formDialog, confirmDialog, showError, notifyChanged, optionList, state, setScanHandler } from '../core.js';

const LOG_LABELS = {
  ANMELDUNG: 'Anmeldung', ANMELDUNG_FEHLGESCHLAGEN: 'Anmeldung fehlgeschlagen', ABMELDUNG: 'Abmeldung', EINRICHTUNG: 'Ersteinrichtung',
  EINRICHTUNG_ABGELEHNT: 'Einrichtung abgelehnt (falscher Code)', PASSWORT_GEAENDERT: 'Passwort geändert', BENUTZER_ANGELEGT: 'Benutzer angelegt',
  BENUTZER_GEAENDERT: 'Benutzer geändert', ZUGRIFF_VERWEIGERT: 'Zugriff verweigert', SCHLUESSEL_ANGELEGT: 'Zugriffsschlüssel angelegt',
  SCHLUESSEL_WIDERRUFEN: 'Zugriffsschlüssel widerrufen',
};
const LOG_ALERT = new Set(['ANMELDUNG_FEHLGESCHLAGEN', 'EINRICHTUNG_ABGELEHNT', 'ZUGRIFF_VERWEIGERT']);

/** Startpasswort zum Weitergeben: gut lesbar, ohne verwechselbare Zeichen */
function startPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(bytes, (b) => abc[b % abc.length]).join('').replace(/(.{5})(?=.)/g, '$1-');
}

export async function render(ctx) {
  setScanHandler(null);
  const [data, tokens, log] = await Promise.all([get('/users'), get('/api-tokens'), get('/auth-log?limit=150')]);
  const me = state.session.user;
  const roleOptions = optionList(data.roles);

  // ---------------------------------------------------------------- Benutzer
  const createUser = () => formDialog({
    title: 'Benutzer anlegen',
    intro: h('p', { class: 'hint' }, 'Das Startpasswort geben Sie der Person persönlich weiter. Bei der ersten Anmeldung muss sie ein eigenes Passwort vergeben.'),
    fields: [
      { name: 'username', label: 'Benutzername', required: true, autofocus: true, placeholder: 'z. B. m.mueller', hint: 'Kleinbuchstaben, Ziffern, Punkt, Bindestrich' },
      { name: 'display_name', label: 'Name (erscheint im Protokoll)', required: true, placeholder: 'z. B. Maria Müller' },
      { name: 'role', label: 'Rolle', type: 'select', options: roleOptions, value: 'VERPACKER' },
      { name: 'password', label: 'Startpasswort', required: true, value: startPassword(), hint: `Mindestens ${data.password_min} Zeichen` },
    ],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => { await post('/users', v); toast(`Benutzer ${v.username} angelegt.`, 'ok'); },
  });
  const editUser = (u) => formDialog({
    title: `Benutzer ${u.username}`,
    fields: [
      { name: 'display_name', label: 'Name (erscheint im Protokoll)', value: u.display_name, required: true, autofocus: true },
      { name: 'role', label: 'Rolle', type: 'select', options: roleOptions, value: u.role, hint: 'Nach einem Rollenwechsel muss sich die Person neu anmelden.' },
    ],
    onSubmit: async (v) => { await put(`/users/${u.id}`, v); toast('Benutzer gespeichert.', 'ok'); },
  });
  const resetPassword = (u) => formDialog({
    title: `Passwort zurücksetzen: ${u.username}`,
    intro: h('p', { class: 'hint' }, 'Alle Anmeldungen dieser Person werden beendet. Mit dem Startpasswort muss sie sofort ein eigenes Passwort vergeben.'),
    fields: [{ name: 'password', label: 'Neues Startpasswort', required: true, value: startPassword(), autofocus: true }],
    submitLabel: 'Zurücksetzen',
    onSubmit: async (v) => { await put(`/users/${u.id}`, v); toast('Passwort zurückgesetzt.', 'ok'); },
  });
  const setActive = async (u, active) => {
    if (!active && !(await confirmDialog(`${u.display_name} (${u.username}) sperren? Die Person wird sofort abgemeldet. Ihre Buchungen bleiben im Protokoll erhalten.`, { ok: 'Sperren', danger: true }))) return;
    try { await put(`/users/${u.id}`, { active }); toast(active ? 'Konto entsperrt.' : 'Konto gesperrt.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
  };
  const userPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Benutzer (${data.users.filter((u) => u.active).length} aktiv)`), btn('Benutzer anlegen', createUser, { icon: 'plus', cls: 'primary' })),
    h('div', { class: 'panel-body flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Benutzername'), h('th', null, 'Rolle'), h('th', null, 'Status'), h('th', null, 'Letzte Anmeldung'), h('th', null, ''))),
      h('tbody', null, data.users.map((u) => h('tr', null,
        h('td', null, h('b', null, u.display_name), u.id === me.id ? h('div', { class: 'sub' }, 'Ihr Konto') : null),
        h('td', { class: 'mono' }, u.username),
        h('td', null, u.role_label),
        h('td', null, !u.active ? h('span', { class: 'tag warn' }, 'gesperrt') : u.must_change_password ? h('span', { class: 'tag' }, 'Startpasswort') : h('span', { class: 'tag ok' }, 'aktiv')),
        h('td', { class: 'small nowrap' }, u.last_login_at ? fmt.dt(u.last_login_at) : 'noch nie'),
        h('td', { class: 'nowrap' },
          btn('Bearbeiten', () => editUser(u), { cls: 'small ghost' }),
          btn('Passwort zurücksetzen', () => resetPassword(u), { cls: 'small ghost' }),
          u.id === me.id ? null : u.active ? btn('Sperren', () => setActive(u, false), { cls: 'small ghost danger' }) : btn('Entsperren', () => setActive(u, true), { cls: 'small ghost' }))))))),
    h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'Konten werden nicht gelöscht, sondern gesperrt – so bleibt nachvollziehbar, wer was gebucht hat.'))));

  // ---------------------------------------------------------------- Rollen und Rechte
  const roles = Object.keys(data.roles);
  const rolePanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Rollen und Rechte')),
    h('div', { class: 'panel-body flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Berechtigung'), roles.map((r) => h('th', { class: 'center' }, data.roles[r])))),
      h('tbody', null, Object.entries(data.permissions).map(([p, label]) => h('tr', null,
        h('td', null, label),
        roles.map((r) => h('td', { class: 'center' }, data.role_permissions[r].includes(p) ? '✓' : '–')))))))),
    h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'Die Rechte prüft der Server bei jeder einzelnen Buchung. Die Oberfläche blendet lediglich aus, was ein Konto nicht darf.')));

  // ---------------------------------------------------------------- Zugriffsschlüssel
  const createToken = () => formDialog({
    title: 'Zugriffsschlüssel anlegen',
    intro: h('p', { class: 'hint' }, 'Für Fremdsysteme wie SAP, die Materialstamm oder Projektbedarf an die Eingangsschnittstellen senden (/api/integration/…). Der Schlüssel gibt nichts anderes frei.'),
    fields: [{ name: 'name', label: 'Bezeichnung', required: true, autofocus: true, placeholder: 'z. B. SAP Produktiv' }],
    submitLabel: 'Anlegen',
    onSubmit: async (v) => {
      const t = await post('/api-tokens', v);
      const box = h('input', { class: 'mono', readonly: true, value: t.token, 'aria-label': 'Zugriffsschlüssel', onfocus: (e) => e.target.select() });
      modal({
        title: `Zugriffsschlüssel „${t.name}“`,
        body: [
          h('p', { class: 'notice warn' }, 'Der Schlüssel wird nur jetzt angezeigt. Bitte sofort im Fremdsystem hinterlegen – gespeichert wird hier nur ein Prüfwert.'),
          box,
          h('p', { class: 'hint' }, 'Verwendung im Aufruf: Kopfzeile „Authorization: Bearer <Schlüssel>“.'),
        ],
        actions: [
          { label: 'Kopieren', onClick: async () => { await navigator.clipboard.writeText(t.token); toast('In die Zwischenablage kopiert.', 'ok'); } },
          { label: 'Schließen', cls: 'primary' },
        ],
      });
    },
  });
  const tokenPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, `Zugriffsschlüssel für Fremdsysteme (${tokens.length})`), btn('Schlüssel anlegen', createToken, { icon: 'plus' })),
    h('div', { class: 'panel-body flush' }, tokens.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Bezeichnung'), h('th', null, 'Angelegt'), h('th', null, 'Zuletzt verwendet'), h('th', null, ''))),
      h('tbody', null, tokens.map((t) => h('tr', null,
        h('td', null, h('b', null, t.name)),
        h('td', { class: 'small nowrap' }, fmt.dt(t.created_at), h('div', { class: 'sub' }, t.created_by)),
        h('td', { class: 'small nowrap' }, t.last_used_at ? fmt.dt(t.last_used_at) : 'noch nie'),
        h('td', null, btn('Widerrufen', async () => {
          if (!(await confirmDialog(`Schlüssel „${t.name}“ widerrufen? Das Fremdsystem kann danach nichts mehr senden.`, { ok: 'Widerrufen', danger: true }))) return;
          try { await del(`/api-tokens/${t.id}`); toast('Schlüssel widerrufen.', 'ok'); notifyChanged(); } catch (err) { showError(err); }
        }, { cls: 'small ghost danger' }))))))) : h('div', { class: 'empty' }, 'Kein Zugriffsschlüssel vorhanden.')));

  // ---------------------------------------------------------------- Sicherheitsprotokoll
  const logPanel = h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Sicherheitsprotokoll')),
    h('div', { class: 'panel-body flush' }, h('div', { class: 'table-wrap', style: { maxHeight: '420px', overflow: 'auto' } }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Zeit'), h('th', null, 'Konto'), h('th', null, 'Vorgang'), h('th', null, 'Betrifft'), h('th', null, 'Adresse'))),
      h('tbody', null, log.map((x) => h('tr', null,
        h('td', { class: 'small nowrap' }, fmt.dt(x.at)),
        h('td', { class: 'mono' }, x.actor || '–'),
        h('td', null, h('span', { class: `tag${LOG_ALERT.has(x.action) ? ' warn' : ''}` }, LOG_LABELS[x.action] || x.action)),
        h('td', { class: 'small' }, [x.target, x.details].filter(Boolean).join(' · ') || '–'),
        h('td', { class: 'small mono' }, x.ip || '–'))))))),
    h('div', { class: 'panel-body' }, h('p', { class: 'hint' }, 'Die letzten 150 Einträge. Fachliche Buchungen stehen im Verlauf des jeweiligen Projekts.')));

  ctx.show(h('div', { class: 'stack', style: { gap: '18px' } },
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Benutzer & Zugriff'),
      h('p', { class: 'muted' }, 'Konten, Rollen, Schlüssel für Fremdsysteme und Sicherheitsprotokoll'))),
    userPanel, rolePanel, tokenPanel, logPanel));
}
