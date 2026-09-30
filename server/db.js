'use strict';
// Datenbank (SQLite über das in Node eingebaute Modul node:sqlite)

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  customer    TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  hu_seq      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS psp_elements (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS materials (
  material_number TEXT PRIMARY KEY,
  description     TEXT NOT NULL DEFAULT '',
  unit            TEXT NOT NULL DEFAULT 'ST',
  weight_kg       REAL,
  origin          TEXT NOT NULL DEFAULT 'SAP'
);

CREATE TABLE IF NOT EXISTS material_barcodes (
  barcode         TEXT PRIMARY KEY,
  material_number TEXT NOT NULL REFERENCES materials(material_number) ON DELETE CASCADE ON UPDATE CASCADE,
  symbology       TEXT NOT NULL DEFAULT 'CODE128',
  is_primary      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_barcodes_material ON material_barcodes(material_number);

CREATE TABLE IF NOT EXISTS pack_items (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  psp_id           INTEGER REFERENCES psp_elements(id),
  material_number  TEXT NOT NULL REFERENCES materials(material_number) ON UPDATE CASCADE,
  description      TEXT NOT NULL DEFAULT '',
  qty_required     REAL NOT NULL CHECK (qty_required > 0),
  unit             TEXT NOT NULL DEFAULT 'ST',
  source           TEXT NOT NULL,
  source_ref       TEXT NOT NULL DEFAULT '',
  supplier         TEXT NOT NULL DEFAULT '',
  purchase_order   TEXT NOT NULL DEFAULT '',
  base_status      TEXT NOT NULL DEFAULT 'ANGELEGT',
  qty_missing      REAL NOT NULL DEFAULT 0 CHECK (qty_missing >= 0),
  missing_reason   TEXT NOT NULL DEFAULT '',
  missing_expected TEXT NOT NULL DEFAULT '',
  was_missing      INTEGER NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_items_project ON pack_items(project_id);
CREATE INDEX IF NOT EXISTS ix_items_material ON pack_items(material_number);

CREATE TABLE IF NOT EXISTS deliveries (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'HAUPT',
  destination   TEXT NOT NULL DEFAULT '',
  carrier       TEXT NOT NULL DEFAULT '',
  truck_plate   TEXT NOT NULL DEFAULT '',
  trailer_plate TEXT NOT NULL DEFAULT '',
  driver        TEXT NOT NULL DEFAULT '',
  planned_date  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'GEPLANT',
  loaded_at     TEXT,
  delivered_at  TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_deliveries_project ON deliveries(project_id);

CREATE TABLE IF NOT EXISTS handling_units (
  id             INTEGER PRIMARY KEY,
  hu_number      TEXT NOT NULL UNIQUE,
  package_number TEXT NOT NULL UNIQUE,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  psp_id         INTEGER REFERENCES psp_elements(id),
  packaging_type TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  length_cm      REAL,
  width_cm       REAL,
  height_cm      REAL,
  tare_kg        REAL,
  net_kg         REAL,
  gross_kg       REAL,
  location       TEXT NOT NULL DEFAULT '',
  destination    TEXT NOT NULL DEFAULT '',
  parent_id      INTEGER REFERENCES handling_units(id),
  pack_status    TEXT NOT NULL DEFAULT 'ANGELEGT',
  ship_status    TEXT NOT NULL DEFAULT 'OFFEN',
  delivery_id    INTEGER REFERENCES deliveries(id),
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL DEFAULT '',
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_hus_project ON handling_units(project_id);
CREATE INDEX IF NOT EXISTS ix_hus_parent ON handling_units(parent_id);
CREATE INDEX IF NOT EXISTS ix_hus_delivery ON handling_units(delivery_id);

CREATE TABLE IF NOT EXISTS hu_contents (
  id           INTEGER PRIMARY KEY,
  hu_id        INTEGER NOT NULL REFERENCES handling_units(id) ON DELETE CASCADE,
  pack_item_id INTEGER NOT NULL REFERENCES pack_items(id),
  qty          REAL NOT NULL CHECK (qty > 0),
  packed_at    TEXT NOT NULL,
  packed_by    TEXT NOT NULL DEFAULT '',
  UNIQUE (hu_id, pack_item_id)
);
CREATE INDEX IF NOT EXISTS ix_contents_item ON hu_contents(pack_item_id);

CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY,
  hu_id       INTEGER REFERENCES handling_units(id) ON DELETE CASCADE,
  delivery_id INTEGER REFERENCES deliveries(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,
  category    TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  taken_at    TEXT NOT NULL,
  taken_by    TEXT NOT NULL DEFAULT '',
  CHECK (hu_id IS NOT NULL OR delivery_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_photos_hu ON photos(hu_id);
CREATE INDEX IF NOT EXISTS ix_photos_delivery ON photos(delivery_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  user       TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  ref        TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_events_entity ON events(entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_events_project ON events(project_id);

CREATE TABLE IF NOT EXISTS sap_outbox (
  id         INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_status ON sap_outbox(status);

CREATE TABLE IF NOT EXISTS vehicle_types (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'SONSTIGE',
  length_cm           REAL NOT NULL,
  width_cm            REAL NOT NULL,
  height_cm           REAL NOT NULL,
  max_payload_kg      REAL,
  axle_front_x_cm     REAL,
  axle_rear_x_cm      REAL,
  axle_front_empty_kg REAL,
  axle_rear_empty_kg  REAL,
  axle_front_max_kg   REAL,
  axle_rear_max_kg    REAL,
  cog_tolerance_pct   REAL,
  note                TEXT NOT NULL DEFAULT '',
  builtin             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS load_plans (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  spaces      TEXT NOT NULL DEFAULT '[]',
  settings    TEXT NOT NULL DEFAULT '{}',
  assignments TEXT NOT NULL DEFAULT '{}',
  result      TEXT,
  stale       INTEGER NOT NULL DEFAULT 1,
  computed_at TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_load_plans_project ON load_plans(project_id);

CREATE TABLE IF NOT EXISTS load_plan_items (
  id              INTEGER PRIMARY KEY,
  plan_id         INTEGER NOT NULL REFERENCES load_plans(id) ON DELETE CASCADE,
  hu_id           INTEGER REFERENCES handling_units(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  length_cm       REAL,
  width_cm        REAL,
  height_cm       REAL,
  weight_kg       REAL,
  qty             INTEGER NOT NULL DEFAULT 1,
  stackable       INTEGER NOT NULL DEFAULT 1,
  rotatable       INTEGER NOT NULL DEFAULT 1,
  tiltable        INTEGER NOT NULL DEFAULT 0,
  max_top_load_kg REAL,
  stop            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (plan_id, hu_id)
);

CREATE TABLE IF NOT EXISTS printers (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 9100,
  dpi  INTEGER NOT NULL DEFAULT 203
);
`;

function openDatabase(dataDir) {
  let file;
  if (dataDir === ':memory:') {
    file = ':memory:';
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'projektversand.db');
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Spalten nachrüsten (bestehende Datenbanken früherer Versionen) */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(handling_units)').all().map((c) => c.name));
  const add = (name, def) => { if (!cols.has(name)) db.exec(`ALTER TABLE handling_units ADD COLUMN ${name} ${def}`); };
  add('stackable', 'INTEGER NOT NULL DEFAULT 1');
  add('rotatable', 'INTEGER NOT NULL DEFAULT 1');
  add('tiltable', 'INTEGER NOT NULL DEFAULT 0');
  add('max_top_load_kg', 'REAL');
}

/** Führt fn in einer Transaktion aus (verschachtelte Aufrufe laufen in der äußeren Transaktion mit). */
function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* bereits zurückgerollt */ }
    throw err;
  }
}

module.exports = { openDatabase, transaction };
