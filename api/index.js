'use strict';
// Vercel-Einstieg (Demo-Modus): alle Anfragen laufen über diese Funktion.
// Daten liegen im temporären Speicher der Instanz und werden beim Kaltstart mit dem Beispielprojekt neu angelegt.

const { createDemoHost, DEMO_DIR } = require('../server/demo');

const host = createDemoHost(DEMO_DIR);

module.exports = (req, res) => {
  // Vercel stellt req.body teils als verzögert gelesene Eigenschaft bereit. Entfernen, damit Express den
  // Anfrageinhalt selbst liest (JSON, Bilder). Bereits gelesene Inhalte bleiben unverändert.
  const desc = Object.getOwnPropertyDescriptor(req, 'body');
  if (desc && desc.get && desc.configurable) delete req.body;
  return host.handler(req, res);
};

// Für Tests: Zugriff auf die laufende Instanz
module.exports.host = host;
