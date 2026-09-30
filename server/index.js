'use strict';
// Startpunkt: node server/index.js [--port 8080] [--https] [--data ./data]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createApp } = require('./app');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function loadOrCreateCert(dataDir) {
  const certFile = path.join(dataDir, 'cert.pem');
  const keyFile = path.join(dataDir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  }
  const selfsigned = require('selfsigned');
  const altNames = [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, { type: 7, ip: '127.0.0.1' }];
  for (const ip of lanAddresses()) altNames.push({ type: 7, ip });
  const pems = await selfsigned.generate([{ name: 'commonName', value: os.hostname() }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
  });
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(keyFile, pems.private);
  console.log(`Selbstsigniertes Zertifikat erzeugt: ${certFile}`);
  return { cert: pems.cert, key: pems.private };
}

async function main() {
  const dataDir = path.resolve(String(arg('data', process.env.DATA_DIR || path.join(__dirname, '..', 'data'))));
  const useHttps = !!arg('https', process.env.HTTPS === '1');
  const port = Number(arg('port', process.env.PORT || (useHttps ? 8443 : 8080)));
  fs.mkdirSync(dataDir, { recursive: true });

  const { app, domain, close } = createApp({ dataDir });
  domain.sap.start();

  const server = useHttps ? https.createServer(await loadOrCreateCert(dataDir), app) : http.createServer(app);
  server.listen(port, () => {
    const proto = useHttps ? 'https' : 'http';
    console.log('Projektversand läuft:');
    console.log(`  ${proto}://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  ${proto}://${ip}:${port}   (für Scanner / Mobilgeräte im Netz)`);
    console.log(`Daten: ${dataDir}`);
    if (!useHttps) console.log('Hinweis: Kamera-Scan auf Mobilgeräten benötigt HTTPS → "npm run start:https"');
  });

  const shutdown = () => {
    close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
