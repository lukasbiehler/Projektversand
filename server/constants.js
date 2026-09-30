'use strict';
// Stammwerte (Status, Verpackungsarten, Bildkategorien …). Werden über /api/meta auch an die Oberfläche geliefert.

/** Standardisierte Status (Demand Kap. 6) – gelten für Packvorrats-Positionen (Material) */
const ITEM_STATUS = {
  ANGELEGT: 'Angelegt',
  ANGEFORDERT: 'Material angefordert',
  KOMMISSIONIERT: 'Kommissioniert',
  FEHLTEIL: 'Fehlteil vorhanden',
  VERPACKUNG_BEGONNEN: 'Verpackung begonnen',
  VERPACKUNG_ABGESCHLOSSEN: 'Verpackung abgeschlossen',
  VERSANDBEREIT: 'Versandbereit',
  VERLADEN: 'Verladen',
  AUSGELIEFERT: 'Ausgeliefert',
};

/** Manuell setzbare Vorstufen einer Position (alle weiteren Status ergeben sich aus dem Verpacken/Versenden) */
const BASE_STATUS = ['ANGELEGT', 'ANGEFORDERT', 'KOMMISSIONIERT'];

/** Gesamtstatus einer Handling Unit (Teilmenge der Status aus Kap. 6) */
const HU_STATUS = {
  ANGELEGT: 'Angelegt',
  VERPACKUNG_BEGONNEN: 'Verpackung begonnen',
  VERPACKUNG_ABGESCHLOSSEN: 'Verpackung abgeschlossen',
  VERSANDBEREIT: 'Versandbereit',
  VERLADEN: 'Verladen',
  AUSGELIEFERT: 'Ausgeliefert',
};
const HU_STATUS_RANK = {
  ANGELEGT: 0,
  VERPACKUNG_BEGONNEN: 1,
  VERPACKUNG_ABGESCHLOSSEN: 2,
  VERSANDBEREIT: 3,
  VERLADEN: 4,
  AUSGELIEFERT: 5,
};

/** Verpackungsstatus einer HU */
const PACK_STATUS = {
  ANGELEGT: 'Leer / angelegt',
  BEGONNEN: 'Verpackung begonnen',
  ABGESCHLOSSEN: 'Verpackung abgeschlossen',
};

/** Versandstatus einer HU */
const SHIP_STATUS = {
  OFFEN: 'Nicht versandbereit',
  VERSANDBEREIT: 'Versandbereit',
  VERLADEN: 'Verladen',
  AUSGELIEFERT: 'Ausgeliefert',
};

const PACKAGING_TYPES = {
  KISTE: 'Kiste',
  PALETTE: 'Palette',
  CONTAINER: 'Container',
  GROSSCOLLI: 'Großcolli',
  GITTERBOX: 'Gitterbox',
  KARTON: 'Karton',
  SONSTIGE: 'Sonstige',
};

const ITEM_SOURCES = {
  PSP: 'PSP-Element (SAP)',
  EXCEL: 'Excel-Packliste',
  MANUELL: 'Manuell ergänzt',
  LIEFERANT: 'Lieferantenmaterial',
};

const DELIVERY_KINDS = {
  HAUPT: 'Hauptlieferung',
  NACHLIEFERUNG: 'Nachlieferung',
};

const DELIVERY_STATUS = {
  GEPLANT: 'Geplant',
  IN_VERLADUNG: 'In Verladung',
  VERLADEN: 'Verladen / Warenausgang',
  AUSGELIEFERT: 'Ausgeliefert',
};

/** Bildkategorien (Demand Kap. 4) */
const PHOTO_PHASES = {
  VERPACKUNG: 'Während Verpackung',
  VERLADUNG: 'Während Verladung',
};
const PHOTO_CATEGORIES = {
  VERPACKUNG: {
    VERPACKUNGSZUSTAND: 'Verpackungszustand',
    INNENAUFNAHME: 'Innenaufnahme Kiste',
    VOLLSTAENDIGKEIT: 'Dokumentierte Vollständigkeit',
    SONSTIGES: 'Sonstiges',
  },
  VERLADUNG: {
    LADUNGSSICHERUNG: 'Ladungssicherung',
    KENNZEICHEN: 'LKW-Kennzeichen',
    VERLADEZUSTAND: 'Verladezustand',
    FAHRZEUGBELEGUNG: 'Fahrzeugbelegung',
    SONSTIGES: 'Sonstiges',
  },
};

/** Unterstützte Barcode-Symbologien (für vorhandene SAP-/Herrenknecht-Barcodes) */
const SYMBOLOGIES = {
  CODE128: 'Code 128',
  EAN13: 'EAN-13',
  EAN8: 'EAN-8',
  CODE39: 'Code 39',
  ITF: 'Interleaved 2 of 5',
  QR: 'QR-Code',
  DATAMATRIX: 'Data Matrix',
};

/** Mengeneinheiten, die nur ganzzahlig verpackt werden dürfen */
const INTEGER_UNITS = ['ST', 'STK', 'STCK', 'STÜCK', 'PC', 'PCS', 'PCE', 'EA', 'PAA', 'SET'];

const MIME_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** Laderaum-Kategorien für die Ladeplanung */
const VEHICLE_CATEGORIES = {
  CONTAINER: 'Container',
  SATTEL: 'Sattelauflieger',
  LKW: 'LKW / Motorwagen',
  GLIEDERZUG: 'Gliederzug',
  TRANSPORTER: 'Transporter',
  SONDER: 'Flat / Sondertransport',
  SONSTIGE: 'Sonstige',
};

/**
 * Vorlagen (Richtwerte, Innenmaße). Achsmodell: Abstützpunkte ab Stirnwand der Ladefläche
 * (vorne = Königszapfen bzw. Vorderachse, negativ = vor der Ladefläche), Leergewichtsanteile und zulässige Lasten.
 */
const VEHICLE_PRESETS = [
  { name: "20' Standard-Container", category: 'CONTAINER', length_cm: 589, width_cm: 235, height_cm: 239, max_payload_kg: 28200, cog_tolerance_pct: 10, note: 'Innenmaße ISO; Türöffnung ca. 234 × 228 cm' },
  { name: "40' Standard-Container", category: 'CONTAINER', length_cm: 1203, width_cm: 235, height_cm: 239, max_payload_kg: 26700, cog_tolerance_pct: 10, note: 'Innenmaße ISO; Türöffnung ca. 234 × 228 cm' },
  { name: "40' High-Cube-Container", category: 'CONTAINER', length_cm: 1203, width_cm: 235, height_cm: 269, max_payload_kg: 26500, cog_tolerance_pct: 10, note: 'Innenmaße ISO; Türöffnung ca. 234 × 258 cm' },
  { name: "40' Flat Rack", category: 'SONDER', length_cm: 1162, width_cm: 242, height_cm: 195, max_payload_kg: 39000, cog_tolerance_pct: 10, note: 'Höhe als Planungswert – Überhöhe/-breite nach Absprache mit der Reederei' },
  { name: 'Sattelauflieger Plane 13,60 m', category: 'SATTEL', length_cm: 1360, width_cm: 245, height_cm: 270, max_payload_kg: 24000,
    axle_front_x_cm: 160, axle_rear_x_cm: 930, axle_front_empty_kg: 2200, axle_rear_empty_kg: 4800, axle_front_max_kg: 11500, axle_rear_max_kg: 24000,
    note: 'Richtwerte: vorne = Sattellast am Königszapfen, hinten = 3-Achs-Aggregat' },
  { name: 'Megatrailer 13,60 m', category: 'SATTEL', length_cm: 1360, width_cm: 248, height_cm: 300, max_payload_kg: 24000,
    axle_front_x_cm: 160, axle_rear_x_cm: 930, axle_front_empty_kg: 2300, axle_rear_empty_kg: 5000, axle_front_max_kg: 11500, axle_rear_max_kg: 24000,
    note: 'Richtwerte: vorne = Sattellast am Königszapfen, hinten = 3-Achs-Aggregat' },
  { name: 'Tieflader / Plateau 13,50 m', category: 'SONDER', length_cm: 1350, width_cm: 255, height_cm: 300, max_payload_kg: 30000,
    axle_front_x_cm: 150, axle_rear_x_cm: 1000, axle_front_empty_kg: 3000, axle_rear_empty_kg: 6000, axle_front_max_kg: 18000, axle_rear_max_kg: 30000,
    note: 'Richtwerte – an das eingesetzte Fahrzeug anpassen (Genehmigung bei Überbreite/-höhe)' },
  { name: 'Motorwagen 7,5 t Koffer 6,20 m', category: 'LKW', length_cm: 620, width_cm: 245, height_cm: 240, max_payload_kg: 2600,
    axle_front_x_cm: -120, axle_rear_x_cm: 380, axle_front_empty_kg: 2600, axle_rear_empty_kg: 2300, axle_front_max_kg: 3500, axle_rear_max_kg: 5600,
    note: 'Richtwerte – an das eingesetzte Fahrzeug anpassen' },
  { name: 'Gliederzug – Motorwagen 7,30 m', category: 'GLIEDERZUG', length_cm: 730, width_cm: 245, height_cm: 270, max_payload_kg: 9000,
    axle_front_x_cm: -150, axle_rear_x_cm: 480, axle_front_empty_kg: 5000, axle_rear_empty_kg: 4000, axle_front_max_kg: 7500, axle_rear_max_kg: 11500,
    note: 'Richtwerte – Motorwagen und Anhänger als zwei Laderäume planen' },
  { name: 'Gliederzug – Anhänger 7,70 m', category: 'GLIEDERZUG', length_cm: 770, width_cm: 245, height_cm: 270, max_payload_kg: 12000,
    axle_front_x_cm: 150, axle_rear_x_cm: 620, axle_front_empty_kg: 3000, axle_rear_empty_kg: 3000, axle_front_max_kg: 10000, axle_rear_max_kg: 10000,
    note: 'Richtwerte – Motorwagen und Anhänger als zwei Laderäume planen' },
  { name: 'Transporter 3,5 t', category: 'TRANSPORTER', length_cm: 430, width_cm: 178, height_cm: 190, max_payload_kg: 1100,
    axle_front_x_cm: -100, axle_rear_x_cm: 280, axle_front_empty_kg: 1300, axle_rear_empty_kg: 900, axle_front_max_kg: 1650, axle_rear_max_kg: 2100,
    note: 'Richtwerte – an das eingesetzte Fahrzeug anpassen' },
];

module.exports = {
  VEHICLE_CATEGORIES,
  VEHICLE_PRESETS,
  ITEM_STATUS,
  BASE_STATUS,
  HU_STATUS,
  HU_STATUS_RANK,
  PACK_STATUS,
  SHIP_STATUS,
  PACKAGING_TYPES,
  ITEM_SOURCES,
  DELIVERY_KINDS,
  DELIVERY_STATUS,
  PHOTO_PHASES,
  PHOTO_CATEGORIES,
  SYMBOLOGIES,
  INTEGER_UNITS,
  MIME_TYPES,
};
