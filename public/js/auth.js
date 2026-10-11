// Anmeldung: Anmeldemaske, Ersteinrichtung, Passwort ändern, Benutzermenü
import { h, state, get, post, btn, modal, toast, showError } from './core.js';

export async function loadSession() {
  state.session = await get('/auth/session');
  return state.session;
}

const field = (label, input, hint) => h('label', { class: 'field wide' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
const pwInput = (id, autocomplete) => h('input', { type: 'password', id, name: id, autocomplete, required: true, maxlength: 200 });

/** Formular mit Fehlerzeile; onSubmit darf werfen */
function authForm({ fields, submitLabel, onSubmit, extra }) {
  const err = h('p', { class: 'notice bad', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary big' }, submitLabel);
  const form = h('form', { class: 'form-grid' }, fields, err, h('div', { class: 'row wide' }, submit, extra || null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      await onSubmit();
    } catch (ex) {
      err.textContent = ex.message || String(ex);
      err.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function card(title, intro, body) {
  return h('div', { class: 'login' }, h('section', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h1', null, title)),
    h('div', { class: 'panel-body stack' }, intro ? h('p', { class: 'muted' }, intro) : null, body)));
}

function newPasswordFields(prefix) {
  const pw = pwInput(`${prefix}-new`, 'new-password');
  const rep = pwInput(`${prefix}-repeat`, 'new-password');
  return {
    nodes: [field('Neues Passwort', pw, 'Mindestens 10 Zeichen. Länge zählt mehr als Sonderzeichen – ein Satz aus mehreren Wörtern ist gut.'), field('Neues Passwort wiederholen', rep)],
    read() {
      if (pw.value !== rep.value) throw new Error('Die beiden Eingaben des neuen Passworts stimmen nicht überein.');
      return pw.value;
    },
  };
}

/** Anmeldung bzw. Ersteinrichtung in root anzeigen; onDone wird mit gültiger Sitzung aufgerufen */
export function renderLogin(root, onDone) {
  const done = (session) => {
    state.session = session;
    if (session.user.must_change_password) renderForcedPassword(root, onDone);
    else onDone();
  };

  const showSetup = () => {
    const code = h('input', { id: 'setup-code', autocomplete: 'off', required: true, placeholder: 'XXXX-XXXX-XXXX', autocapitalize: 'characters', spellcheck: 'false' });
    const user = h('input', { id: 'setup-user', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
    const name = h('input', { id: 'setup-name', autocomplete: 'name' });
    const np = newPasswordFields('setup');
    root.replaceChildren(card('Ersteinrichtung',
      'Legen Sie das Administrator-Konto an. Den Einrichtungscode zeigt der Server beim Start in seiner Konsole – so kann nur einrichten, wer Zugriff auf den Server hat.',
      authForm({
        fields: [
          field('Einrichtungscode', code),
          field('Benutzername', user, 'Kleinbuchstaben, Ziffern, Punkt, Bindestrich – z. B. m.mueller'),
          field('Name (erscheint im Protokoll)', name),
          np.nodes,
        ],
        submitLabel: 'Administrator anlegen',
        onSubmit: async () => {
          const password = np.read();
          done(await post('/auth/setup', { code: code.value, username: user.value, display_name: name.value, password }));
        },
        extra: state.session.setup_required ? null : btn('Zur Anmeldung', showLogin, { cls: 'ghost' }),
      })));
    code.focus();
  };

  const showLogin = () => {
    const user = h('input', { id: 'login-user', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
    const pw = pwInput('login-password', 'current-password');
    root.replaceChildren(card('Anmelden', 'Bitte mit Ihrem Projektversand-Konto anmelden.',
      authForm({
        fields: [field('Benutzername', user), field('Passwort', pw)],
        submitLabel: 'Anmelden',
        onSubmit: async () => {
          try {
            done(await post('/auth/login', { username: user.value, password: pw.value }));
          } catch (err) {
            pw.value = '';
            pw.focus();
            throw err;
          }
        },
        extra: state.session.setup_available ? btn('Administrator per Einrichtungscode anlegen', showSetup, { cls: 'ghost' }) : null,
      }),
    ), h('p', { class: 'muted small login-foot' }, 'Passwort vergessen? Ein Administrator kann es zurücksetzen.'));
    user.focus();
  };

  if (state.session.setup_required) showSetup(); else showLogin();
}

function passwordForm({ onDone, submitLabel = 'Passwort ändern', currentLabel = 'Aktuelles Passwort' }) {
  const cur = pwInput('pw-current', 'current-password');
  const np = newPasswordFields('pw');
  // Verstecktes Benutzerfeld, damit Passwort-Manager den Eintrag dem richtigen Konto zuordnen
  const user = h('input', { type: 'text', autocomplete: 'username', value: state.session.user.username, hidden: true, readonly: true });
  return authForm({
    fields: [user, field(currentLabel, cur), np.nodes],
    submitLabel,
    onSubmit: async () => {
      const password = np.read();
      state.session = await post('/auth/password', { current: cur.value, password });
      toast('Passwort geändert. Andere Geräte wurden abgemeldet.', 'ok');
      onDone();
    },
  });
}

/** Erstes Anmelden oder nach Zurücksetzen: eigenes Passwort erzwingen */
export function renderForcedPassword(root, onDone) {
  root.replaceChildren(card('Eigenes Passwort vergeben',
    `Hallo ${state.session.user.display_name}, Ihr Konto hat ein Startpasswort. Bitte vergeben Sie jetzt ein eigenes – erst danach geht es weiter.`,
    passwordForm({ onDone, submitLabel: 'Passwort speichern', currentLabel: 'Startpasswort' })),
  h('p', { class: 'login-foot' }, btn('Abmelden', logout, { cls: 'ghost small' })));
  document.getElementById('pw-current')?.focus();
}

export async function logout() {
  try { await post('/auth/logout'); } catch (err) { showError(err); return; }
  location.hash = '#/';
  location.reload();
}

/** Klick auf den Benutzer oben rechts */
export function openUserMenu() {
  const u = state.session.user;
  const m = modal({
    title: u.display_name,
    body: [
      h('dl', { class: 'kv' },
        h('dt', null, 'Benutzername'), h('dd', { class: 'mono' }, u.username),
        h('dt', null, 'Rolle'), h('dd', null, u.role_label)),
      h('p', { class: 'hint' }, 'Jede Buchung wird mit diesem Konto protokolliert. An gemeinsam genutzten Geräten bitte nach der Arbeit abmelden.'),
    ],
    actions: [
      { label: 'Passwort ändern', onClick: (close) => {
        close();
        const d = modal({ title: 'Passwort ändern', body: [] });
        d.body.append(passwordForm({ onDone: () => d.close() }));
        setTimeout(() => document.getElementById('pw-current')?.focus(), 40);
      } },
      { label: 'Abmelden', cls: 'primary', onClick: () => logout() },
    ],
  });
  return m;
}
