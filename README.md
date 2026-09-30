# Projektversand – Verpacken & Versenden

Web-Anwendung für den digitalen, scannergestützten Projektversand gemäß Demand
„SOMA Verpacken & Versenden für Projektversand“ (260924). Sie ersetzt Excel-Packlisten und
manuelle Bildablage durch einen durchgängigen Ablauf: **Packvorrat → Verpacken per Scan →
Handling Units → Bilddokumentation → Etiketten → Verladung → Zustellung**, mit Echtzeit-Status
und Rückwärtssuche.

Ein Server läuft zentral (PC/Server im Werksnetz). Arbeitsplätze, Tablets, Smartphones und
Scanner-Handhelds (z. B. Zebra) greifen über den Browser zu, eine Installation auf den Geräten ist
nicht nötig.

## Start

Voraussetzung: [Node.js](https://nodejs.org) ab Version 22.13 (entwickelt und getestet mit 26.1).

```bash
npm install
```

```bash
npm start
```

Aufruf unter `http://localhost:8080`. Die Konsole zeigt zusätzlich die Adressen für Mobilgeräte im Netz.

Für den **Kamera-Scan auf Mobilgeräten** ist HTTPS nötig (Vorgabe der Browser):

```bash
npm run start:https
```

Beim ersten Start wird ein selbstsigniertes Zertifikat in `data/` erzeugt (Browser-Warnung einmalig
bestätigen). Ein Firmenzertifikat kann als `data/cert.pem` / `data/key.pem` abgelegt werden.
Optionen: `--port 9000`, `--data D:\Versanddaten`.

Eine Schritt-für-Schritt-Testanleitung mit Beispieldaten steht in [docs/TESTANLEITUNG.md](docs/TESTANLEITUNG.md).

Tests: `npm test` (34 Tests: Geschäftsregeln, Schnittstellen und Beladungsalgorithmus mit unabhängiger Regelprüfung).

## Abdeckung der Anforderungen

| Demand | Umsetzung |
|---|---|
| **1 Packvorrat** statt Excel | Packvorrat je Projekt. Übernahme von Projektmaterial aus PSP-Elementen (SAP-Export, z. B. CN52N, oder Push über die Eingangsschnittstelle), Excel-Packlisten/Projektübersichten (XLSX, XLS, CSV mit automatischer Spaltenerkennung), Lieferantenmaterial (Lieferant, Bestellung, Lieferanten-Barcode), manuelle Ergänzung. Soll, verpackt, offen und Fehlmenge je Position jederzeit sichtbar. Fehlteile werden gemeldet (Menge, Grund, Termin) und beim späteren Verpacken automatisch aufgelöst. Erneuter Import derselben Liste gleicht Mengen ab statt Dubletten anzulegen und meldet entfallene Positionen. |
| **2 Scannergestützt** | Hardware-Scanner (Tastatur-Modus mit Enter, auf jeder Seite aktiv), Kamera-Scan (Code 128, Code 39, EAN, ITF, QR, Data Matrix) und Foto-Auswertung als Rückfall. Materialscan bucht in die passende Position, bei Mehrdeutigkeit wird gefragt. Überverpackung, nicht ganzzahlige Stückmengen und Material außerhalb des Packvorrats werden abgewiesen. Jede Buchung geht sofort in die SAP-Warteschlange (siehe unten). |
| **3 Digitale HU** | Jedes Packstück ist eine Handling Unit mit HU-Nummer, Packstücknummer, Bezeichnung, Art (Kiste, Palette, Container, Großcolli, Gitterbox, Karton), Maßen, Tara/Netto/Brutto (gewogen oder berechnet aus Tara + Materialgewichten + enthaltenen HUs), Lager-/Sammelplatz, Projekt/PSP, Verpackungs- und Versandstatus. Mehrstufig (z. B. Palette → Kiste → Container) per Scan des Packstück-Etiketts; Kreise und unzulässige Schachtelung werden verhindert. |
| **4 Bilddokumentation** | Aufnahme direkt mit der Gerätekamera, gespeichert am Packstück bzw. an der Lieferung. Kategorien Verpackung (Verpackungszustand, Innenaufnahme Kiste, Vollständigkeit) und Verladung (Ladungssicherung, LKW-Kennzeichen, Verladezustand, Fahrzeugbelegung). Nach dem Warenausgang nicht mehr löschbar. |
| **5 Etiketten** | Ebene 1 Einzelartikel (100 × 50 mm): Materialnummer, Bezeichnung, Projekt/PSP, Menge, **vorhandener SAP-Barcode** (in der hinterlegten Symbologie), Status. Ebene 2 HU (100 × 150 mm): HU-Nr., Projekt, PSP, Packstücknummer und -bezeichnung, Gewicht, Maße, Code 128 + QR-Code, Versandstatus, Zielort/Kunde. Druck über den Druckdialog (stationär und mobil), direkt an ZPL-Netzwerk-/WLAN-Drucker (Port 9100) oder als ZPL-Datei. Ein Barcode gehört genau zu einem Material, es entsteht keine parallele Barcodewelt. |
| **6 Status** | Angelegt, Material angefordert, Kommissioniert, Fehlteil vorhanden, Verpackung begonnen, Verpackung abgeschlossen, Versandbereit, Verladen, Ausgeliefert. Vorstufen werden gesetzt, alle weiteren Status ergeben sich zwangsläufig aus Verpacken, Abschließen, Versandbereitschaft (nur mit Maßen und vollständigem Gewicht), Verladung (nur versandbereite, äußere Packstücke) und Zustellung. |
| **7 Rückwärtssuche** | Suche (projektbezogen oder übergreifend) nach Material, Barcode, PSP-Element, Packstück, HU, Lieferung, Kennzeichen. Ergebnis: Verpack- und Lieferstatus, Packstück, Lagerplatz, Lieferung mit Kennzeichen und Zeitpunkten, Bilder, Kennzeichnung von Nachlieferungen. |

Weitere Punkte aus der Ausgangssituation: Echtzeit-Transparenz (alle Geräte aktualisieren sich
sofort), lückenloses Protokoll jeder Buchung mit Benutzer und Zeit (Rückverfolgbarkeit je
Packstück), Projekt-Cockpit mit Fortschritt, Fehlteilliste und Nachlieferungen (die erste Lieferung
eines Projekts ist die Hauptlieferung, jede weitere nach dem Warenausgang automatisch eine
Nachlieferung), druckbare Packliste je Lieferung.

## Ladeplanung (LKW / Container optimal beladen)

Ergänzend zum Demand, angelehnt an Ladeplanungs-Software wie EasyCargo (Projekt → Reiter „Ladeplanung“):

- **Laderäume**: Vorlagen für 20'/40'/40'-HC-Container, Flat Rack, Sattelauflieger, Megatrailer, Tieflader,
  7,5-t-LKW, Gliederzug (Motorwagen + Anhänger), Transporter. Eigene Typen mit Innenmaßen, Nutzlast,
  Achsmodell (Abstützpunkte, Leergewichtsanteile, zulässige Lasten) oder Schwerpunktfenster unter *Einstellungen*.
  Die Vorlagen sind **Richtwerte** und an die tatsächlich eingesetzten Fahrzeuge anzupassen.
- **Ladegut**: Packstücke des Projekts (Maße, Gewicht und Eigenschaften immer aktuell aus der Packstückverwaltung)
  sowie zusätzliche Positionen manuell oder per Excel-Import. Eigenschaften je Teil: stapelbar, drehbar, kippbar,
  maximale Auflast, Entladestelle.
- **Optimierung** („Optimal beladen“): 3D-Anordnung nach Extreme-Point-Heuristik mit mehreren Strategien; es gewinnt
  die Lösung mit den wenigsten nicht verladenen Teilen, ohne Grenzwertverletzungen und mit den wenigsten Fahrzeugen.
  Beachtet werden Laderaummaße, Nutzlast, Mindest-Auflagefläche, Stapelbarkeit, Auflast (auch über ganze Stapel),
  Drehen/Kippen, Entladestellen (später entladene Teile vorne) und Achslasten bzw. Schwerpunkt (bei Bedarf wird die
  Ladung längs verschoben, der Freiraum wird als Sicherungshinweis ausgegeben). Reicht der Platz nicht, werden
  automatisch weitere Fahrzeuge des gewählten Typs ergänzt.
- **Ergebnis**: interaktive 3D-Ansicht (drehen, zoomen, Ansichten 3D/Oben/Seite/Heck/Front, Beschriftung auf den
  Teilen, Schwerpunkt- und Achsmarkierung), Schritt-für-Schritt-Beladung, Auslastung (Volumen, Gewicht, Lademeter,
  Bodenfläche), Gewichtsverteilung (Achslasten inkl. Leergewicht, Längs-/Querschwerpunkt), Beladereihenfolge mit
  Positionsangabe, Liste nicht verladener Teile mit Grund.
- **Manuelle Anpassung**: Teil verschieben, drehen, absenken, herausnehmen oder automatisch neu platzieren – jede
  Änderung wird auf Überschneidung, Auflage, Stapelbarkeit, Auflast und Nutzlast geprüft und sonst abgelehnt.
- **Bericht und Export**: druckbarer Bericht (auch als PDF) mit Ansichten, Kennzahlen, Reihenfolge und optional
  Schritt-für-Schritt-Bildern; Excel-Export des Ladeplans.
- **Verladung nach Plan**: Ein Laderaum wird einer Lieferung zugeordnet (oder legt sie an). Beim Verladen per Scan
  zeigt die Lieferung Fortschritt, nächsten Schritt mit Position und die 3D-Ansicht; wird außer der Reihe oder ein
  nicht eingeplantes Packstück gescannt, erscheint ein Hinweis.

Die Berechnung ist eine Heuristik: Sie liefert gültige, gute Ladepläne, aber nicht garantiert das mathematische
Optimum. Ladungssicherung, tatsächliche Achslasten (Verwiegung) und Genehmigungen bei Übermaß bleiben in der
Verantwortung des Verladers.

## Ablauf in der Praxis

1. **Projekt anlegen** und Packvorrat importieren (Projekt → Packvorrat → Import).
2. **Materialstamm** mit SAP-Materialnummern und vorhandenen Barcodes importieren, damit die
   bestehenden Artikeletiketten scannbar sind. Ohne hinterlegten Barcode wird die Materialnummer
   selbst erkannt (führende Nullen wie in SAP).
3. **Packstück anlegen** (Kiste, Palette …), Etikett drucken, Material hineinscannen. Ein
   gescanntes Packstück-Etikett packt dieses Packstück hinein (mehrstufige Verpackung).
4. Fotos aufnehmen, **Verpackung abschließen**, Maße und Gewicht erfassen, **versandbereit melden**.
5. **Lieferung anlegen**, Packstücke per Scan verladen, Verladefotos und Kennzeichen erfassen,
   **Verladung abschließen** (Warenausgang), später **Zustellung bestätigen**.

## SAP-Schnittstelle

### Rückmeldung an SAP (ausgehend)

Jede Buchung erzeugt in derselben Datenbanktransaktion eine Nachricht in einer
Ausgangswarteschlange. Ist unter *Einstellungen → SAP-Rückmeldung* ein Endpunkt eingetragen und
eingeschaltet, wird sofort per `HTTP POST` (JSON, optional mit `Authorization`-Header) übertragen.
Die Reihenfolge bleibt garantiert: Schlägt eine Nachricht fehl, warten alle folgenden, bis sie
übertragen ist (automatischer Neuversuch alle 15 Sekunden). Ohne Verbindung gehen keine Buchungen
verloren. Sie können zusätzlich als JSON exportiert werden.

```json
{
  "messageId": 42,
  "type": "HU_ITEM_PACKED",
  "createdAt": "2026-09-28T17:08:12.345Z",
  "payload": { "hu": "HU00000001", "package_number": "P-24017-001", "project": "P-24017", "psp": "P-24017.01.01",
               "packaging_type": "KISTE", "material": "100001", "qty": 2, "unit": "ST", "item_psp": "P-24017.01.01",
               "user": "M. Muster", "timestamp": "2026-09-28T17:08:12.345Z" }
}
```

Nachrichtentypen: `HU_CREATED`, `HU_UPDATED`, `HU_DELETED`, `HU_ITEM_PACKED`, `HU_ITEM_UNPACKED`,
`HU_NESTED`, `HU_UNNESTED`, `HU_STATUS`, `HU_LOADED`, `HU_UNLOADED`, `DELIVERY_GOODS_ISSUE`,
`DELIVERY_GOODS_ISSUE_REVERSAL`, `DELIVERY_DELIVERED`, `MATERIAL_STATUS`, `MATERIAL_SHORTAGE`.
Der Empfänger (z. B. ein SOMA- oder SAP-Gateway-Service, der HUs bzw. Lieferungen in SAP bucht)
muss auf SAP-Seite bereitgestellt werden. Er quittiert mit einem HTTP-Status 2xx.

### Eingang aus SAP

```http
POST /api/integration/psp-materials
{ "project_number": "P-24017", "project_name": "TBM S-1310", "list_name": "SAP-Projektbedarf",
  "items": [ { "psp": "P-24017.01.01", "psp_description": "Schneidrad", "material": "100001",
               "description": "Schneidrad-Segment", "qty": 4, "unit": "ST", "ref": "Reservierung 0001" } ] }
```

```http
POST /api/integration/materials
{ "materials": [ { "material_number": "100001", "description": "Schneidrad-Segment", "unit": "ST",
                   "weight_kg": 125.5, "barcodes": [ { "barcode": "100001", "symbology": "CODE128" } ] } ] }
```

Beide Aufrufe akzeptieren `"dry_run": true` (nur prüfen) und `"skip_errors": true`. Erneute
Übertragung gleicht Mengen ab (keine Dubletten).

## Geräte

- **Scanner-Handhelds**: Tastatur-Emulation (z. B. Zebra DataWedge „Keystroke output“) mit Enter als
  Suffix. Scans werden auf jeder Seite erkannt und dem aktuellen Vorgang zugeordnet.
- **Etikettendrucker**: unter *Einstellungen → Etikettendrucker* IP-Adresse und Auflösung eintragen
  (ZPL, Port 9100). Alternativ über den Druckdialog des Geräts. Etikettenformate 100 × 150 mm (HU)
  und 100 × 50 mm (Artikel).
- **Barcode-Muster**: Enthalten bestehende Etiketten zusammengesetzte Codes, extrahiert ein
  regulärer Ausdruck die Materialnummer (Einstellungen).

## Daten und Sicherung

Alle Daten liegen im Ordner `data/`: `projektversand.db` (SQLite) und `photos/`. Zur Sicherung den
Ordner bei gestopptem Server kopieren.

## Grenzen

- Das Werkzeug ist eine eigenständige Anwendung und ersetzt nicht die SOMA-Fiori-Apps. SAP wird über
  die beschriebenen Schnittstellen angebunden; der Empfangsservice auf SAP-Seite ist nicht Teil
  dieses Projekts.
- Benutzer werden per Name je Gerät erfasst (für das Protokoll). Eine Anmeldung mit Passwort bzw.
  Rollen gibt es nicht. Betrieb daher nur im internen Netz.
- Das selbstsignierte Zertifikat muss auf jedem Gerät einmal bestätigt werden. Ein Firmenzertifikat
  vermeidet das.
