# Testanleitung Projektversand – Schritt für Schritt

Diese Anleitung führt mit einem durchgängigen Beispielprojekt durch alle Funktionen der App: vom Import
des Packvorrats über das Verpacken per Scan, Fehlteile, Etiketten und Fotos bis zur Ladeplanung, Verladung,
Nachlieferung und Rückwärtssuche. Zu jedem Schritt steht, was Sie eingeben und **was Sie sehen müssen**.

Alle erwarteten Ergebnisse wurden mit genau diesen Daten auf einer leeren Datenbank nachvollzogen.
Dauer: etwa 45–60 Minuten. Abschnitte, die mit *(optional)* markiert sind, können Sie überspringen.

---

## 0 Vorbereitung

1. Einmalig die Abhängigkeiten installieren (im Projektordner):

   ```bash
   npm install
   ```

2. Den Server mit einem **eigenen Testdatenordner** starten, damit echte Daten unberührt bleiben:

   ```bash
   node server/index.js --data ./data-test
   ```

   *Erwartet:* Die Konsole zeigt am Ende „Einrichtungscode für den Administrator: XXXX-XXXX-XXXX“.
3. Im Browser `http://localhost:8080` öffnen.
   *Erwartet:* Seite **Ersteinrichtung**.
4. Einrichtungscode aus der Konsole eingeben, Benutzername `testperson`, Name `Testperson`, ein Passwort mit
   mindestens 10 Zeichen (zweimal) → **Administrator anlegen**.
   *Erwartet:* Oben rechts steht „Testperson“, daneben ein grüner Punkt (Echtzeit-Verbindung aktiv).
   Weitere Konten und Rollen: siehe Abschnitt 12.

> **Scannen ohne Scanner:** Überall, wo ein Code „gescannt“ wird, können Sie ihn in das Scanfeld tippen und
> **Enter** drücken – die App verhält sich genau wie bei einem Hardware-Scanner. Mit Scanner (Tastatur-Modus mit
> Enter) oder Kamera siehe Abschnitt 11.

> **Neu anfangen:** Server beenden (Strg+C) und den Ordner `data-test` löschen.

### Beispieldaten (Ordner `docs/beispieldaten`)

| Datei | Inhalt | Wofür |
|---|---|---|
| `1_materialstamm.csv` | 8 SAP-Materialien mit Gewicht und vorhandenen Barcodes (Code 128, EAN-13, eines ohne Barcode) | Materialstamm |
| `2_sap_projektbedarf.xlsx` | SAP-Export (CN52N-Stil) mit 3 PSP-Elementen, Vorspann-Zeilen und einer absichtlich fehlerhaften Zeile | Packvorrat aus PSP |
| `3_packliste_elektrik.csv` | Excel-Packliste (deutsches Excel, Windows-Zeichensatz, Umlaute) | Packvorrat aus Excel |
| `4_ladegut_zusatz.csv` | Zusätzliches Ladegut (6 Europaletten, 1 Stahlgestell) | Ladeplanung |

### Das Beispielprojekt

Projekt **P-25001 „TBM S-1400 EPB-Schild“**, Kunde **ARGE Nordtunnel**. Im Verlauf entstehen diese Packstücke:

| Packstück | Art | Inhalt | Besonderheit |
|---|---|---|---|
| P-25001-001 | Kiste | 6 Schneidrollen, 24 Schälmesser | 2 Schneidrollen fehlen (Fehlteil) |
| P-25001-002 | Karton | 4 Dichtungssätze | liegt **in** der Kiste 001 (mehrstufig) |
| P-25001-003 | Palette | 60 m Hydraulikschlauch, 150 m Kabel | |
| P-25001-004 | Kiste | Verschleißbleche, Schrauben, 2 Dichtungssätze | Material ohne Barcode |
| P-25001-005 | Großcolli | Hydraulikaggregat (Lieferantenmaterial) | gewogen, nicht stapelbar |
| P-25001-006 | Kiste | 2 nachgelieferte Schneidrollen | Nachlieferung |

---

## 1 Materialstamm importieren (vorhandene SAP-Barcodes)

1. Menü **Materialstamm** → **Import (SAP / Excel)**.
2. Bei *Datei* `docs/beispieldaten/1_materialstamm.csv` wählen.
   *Erwartet:* Alle sechs Spalten werden automatisch zugeordnet (Materialnummer, Bezeichnung, Basismengeneinheit,
   Gewicht, Barcode, Barcode-Art); die Vorschau zeigt 8 Datenzeilen.
3. **Prüfen**.
   *Erwartet:* „Prüfung: 8 neu, 0 aktualisiert, 0 fehlerhafte Zeile(n).“
4. **Importieren**.
   *Erwartet:* Meldung „Import abgeschlossen: 8 neu, 0 aktualisiert.“ In der Liste:
   - `000000000000200001` erscheint als **200001** (führende Nullen wie in SAP entfernt).
   - 200003 hat den Barcode `4006381333931 · EAN-13 · Etikett`.
   - 200005 zeigt „kein Barcode (Materialnr. wird gedruckt)“ und das Gewicht **1,05 kg**.

## 2 Projekt anlegen und Packvorrat aufbauen

### 2.1 Projekt

1. Menü **Projekte** → **Neues Projekt**.
2. Projektnummer `P-25001`, Bezeichnung `TBM S-1400 EPB-Schild`, Kunde `ARGE Nordtunnel`,
   Zielort `Baustelle Startschacht Nord, Hafenstraße 12, 20457 Hamburg` → **Anlegen**.
   *Erwartet:* Die App öffnet direkt den Reiter **Packvorrat** des Projekts (noch leer).
3. *(optional)* Noch einmal ein Projekt `P-25001` anlegen. *Erwartet:* Fehler „Projekt P-25001 existiert bereits.“

### 2.2 SAP-Export der PSP-Elemente importieren

1. **Import (Excel / SAP)** → Datei `2_sap_projektbedarf.xlsx`.
2. *Art der Liste*: **SAP-Export Projektmaterial (PSP-Elemente, z. B. CN52N)**.
   *Erwartet:* Listenbezeichnung „2_sap_projektbedarf“, Überschriftenzeile **„Zeile 3: PSP-Element | …“**
   (die beiden Vorspann-Zeilen werden übersprungen), alle 7 Spalten automatisch zugeordnet.
3. **Prüfen**.
   *Erwartet:* „Prüfung: 7 neu, 0 aktualisiert, 0 unverändert, 1 fehlerhafte Zeile(n).“
   In der Tabelle ganz oben: **Zeile 11 – Fehler – „Material 299999 ist unbekannt und hat keine Bezeichnung“**.
   Die Zeilennummer entspricht exakt der Zeile in Excel.
4. **Importieren** (fehlerhafte Zeilen werden übersprungen).
   *Erwartet:* „Import abgeschlossen: 7 neu, 0 aktualisiert.“ → Dialog schließen.

> Wird **Importieren** ohne vorheriges **Prüfen** geklickt, zeigt die App zuerst die fehlerhaften Zeilen und
> importiert erst beim zweiten Klick.

### 2.3 Excel-Packliste importieren

1. **Import (Excel / SAP)** → Datei `3_packliste_elektrik.csv`, *Art der Liste* bleibt **Excel-Packliste / Projektübersicht**.
   *Erwartet:* In der Vorschau werden Umlaute richtig dargestellt, z. B. „Kabelbinder 300 mm (Beutel à 100)“.
2. **Importieren**. *Erwartet:* „Import abgeschlossen: 4 neu, 0 aktualisiert.“
   Die unbekannten Materialien 300001–300003 werden dabei als lokale Materialien angelegt.
   *Erwartet in der Überschrift:* „Packvorrat (11 von 11 Positionen)“.

### 2.4 Erneuter Import (Abgleich statt Dubletten)

1. Noch einmal `2_sap_projektbedarf.xlsx` mit Art **SAP-Export …** wählen → **Prüfen**.
   *Erwartet:* „Prüfung: 0 neu, 0 aktualisiert, **7 unverändert**, 1 fehlerhafte Zeile(n).“ → **Abbrechen**.

### 2.5 Lieferantenmaterial ergänzen

1. **Lieferantenmaterial** und eingeben:
   Materialnummer `LIEF-9001`, Bezeichnung `Hydraulikaggregat 55 kW`, Menge `1`, PSP-Element `P-25001.02.01`,
   Lieferant `Hydraulik Süd GmbH`, Bestellnummer `4500123456`, Barcode des Lieferanten `HS-55KW-0042` → **Hinzufügen**.
   *Erwartet:* „Position hinzugefügt.“ In der Spalte *Quelle*: „Lieferantenmaterial – Hydraulik Süd GmbH · Best. 4500123456“.

### 2.6 Status „Kommissioniert“ setzen

1. Filter *Quelle* auf **PSP-Element (SAP)** stellen.
2. Die Kopf-Checkbox der Tabelle anhaken (alle 7 sichtbaren Positionen) → **Status setzen** → **Kommissioniert** → **Setzen**.
3. Filter wieder auf **Alle Quellen**.
   *Erwartet:* Die 7 PSP-Positionen stehen auf „Kommissioniert“, die Excel-Positionen auf „Angelegt“,
   das Lieferantenmaterial auf „Angelegt“.

## 3 Verpacken per Scan

### 3.1 Kiste 001 anlegen und befüllen

1. Reiter **Packstücke** → **Neues Packstück**:
   Verpackungsart `Kiste`, Bezeichnung `Kiste Schneidrad-Werkzeuge`, PSP-Element `P-25001.01.01`,
   Lagerplatz `Sammelplatz A1`, Länge `240`, Breite `120`, Höhe `110`, Tara `60` → **Anlegen**.
   *Erwartet:* Die Packstückseite öffnet sich: **P-25001-001**, darunter **HU00000001 · Kiste Schneidrad-Werkzeuge · PSP P-25001.01.01**.
2. *Menge je Scan* `6`, im Scanfeld `200001` + Enter.
   *Erwartet:* grüne Meldung „✓ 6 ST 200001 Schneidrolle 17" Einring verpackt (PSP P-25001.01.01) – offen im Projekt: 2 ST“,
   Ton/Vibration als Bestätigung, Menge springt zurück auf 1, Status wird „Verpackung begonnen“.
3. *Menge je Scan* `24`, Scan `200002`. *Erwartet:* „✓ 24 ST 200002 Schälmesser 250 mm verpackt … offen im Projekt: 0 ST“.

### 3.2 Fehlerfälle beim Scannen

Auf derselben Seite:

| Eingabe | Erwartete Meldung (rot) |
|---|---|
| Menge `10`, Scan `200001` | „Menge 10 ST übersteigt die offene Menge von 2 ST (Material 200001).“ |
| Menge `1`, Scan `XYZ-123` | „Der Code „XYZ-123“ ist keinem Material zugeordnet.“ |
| Scan `200007` | „Material 200007 (Schmierfett EP2 18-kg-Eimer) ist nicht im Packvorrat von Projekt P-25001.“ |

### 3.3 Karton 002 – mehrdeutiges Material

1. Packstücke → **Neues Packstück**: `Karton`, Bezeichnung `Karton Dichtungen`, **kein** PSP-Element,
   Lagerplatz `Sammelplatz A1`, Maße `60` × `40` × `40`, Tara `1` → **Anlegen** (→ P-25001-002).
2. Menge `4`, Scan `4006381333931` (EAN-13 des Dichtungssatzes).
   *Erwartet:* Dialog **„Position auswählen“** – das Material ist für zwei PSP-Elemente offen:
   „P-25001.02.01 · … · offen 4 ST“ und „P-25001.03.01 · … · offen 2 ST“.
3. **P-25001.02.01** wählen. *Erwartet:* „✓ 4 ST 200003 Dichtungssatz Hauptlager verpackt (PSP P-25001.02.01) …“.
4. **Verpackung abschließen**. *Erwartet:* Status „Verpackung abgeschlossen“.

### 3.4 Mehrstufige Verpackung: Karton in die Kiste

1. Kiste **P-25001-001** öffnen (Reiter Packstücke oder `P-25001-001` im Schnellzugriff scannen).
2. Im Scanfeld der Kiste `P-25001-002` scannen.
   *Erwartet:* „✓ Packstück P-25001-002 (HU00000002) in P-25001-001 aufgenommen.“ Unter **Enthaltene Packstücke**
   erscheint der Karton mit 17,8 kg. In der Packstückliste steht er eingerückt unter der Kiste.

### 3.5 Palette 003 und Kiste 004

1. Neues Packstück `Palette`, `Palette Hydraulik & Kabel`, PSP `P-25001.02.01`, Lagerplatz `Halle 4 / Tor 2`,
   Maße `120` × `80` × `120`, Tara `25` (→ P-25001-003).
   Scans: Menge `60` + `HK-200004`, dann Menge `150` + `HK-200008`.
   *Erwartet:* beide Buchungen grün; das Kabel stammt aus der Excel-Liste (ohne PSP) und wird ohne Rückfrage zugeordnet.
2. Neues Packstück `Kiste`, `Kiste Förderschnecke`, PSP `P-25001.03.01`, Lagerplatz `Sammelplatz B2`,
   Maße `200` × `120` × `100`, Tara `80` (→ P-25001-004).
   Scans: Menge `6` + `200006`; Menge `120` + `200005` (Materialnummer ohne Barcode); Menge `2` + `4006381333931`.
   *Erwartet:* Der Dichtungssatz wird jetzt **ohne** Rückfrage P-25001.03.01 zugeordnet (nur noch dort offen).

### 3.6 Großcolli 005 – Lieferantenbarcode und Wiegen

1. Neues Packstück `Großcolli`, `Hydraulikaggregat 55 kW`, PSP `P-25001.02.01`, Lagerplatz `Freilager 3`,
   Maße `180` × `120` × `150`, **keine** Tara (→ P-25001-005). Scan `HS-55KW-0042` (Menge 1).
2. **Verpackung abschließen**.
   *Erwartet:* gelber Hinweis „Für „Versandbereit“ fehlen noch: Bruttogewicht. …“ (das Lieferantenteil hat kein Gewicht).
3. **Versandbereit melden**. *Erwartet:* Fehler „Für die Versandbereitschaft fehlen: Bruttogewicht.“
4. In **Packstückdaten**: *Brutto gewogen* `480`, Haken **stapelbar** entfernen → **Packstückdaten speichern** →
   **Versandbereit melden**. *Erwartet:* Status „Versandbereit“.

### 3.7 Übrige Packstücke abschließen und versandbereit melden

Für **P-25001-001**, **P-25001-003** und **P-25001-004** jeweils **Verpackung abschließen**, dann **Versandbereit melden**.

*Erwartet* (Packstückdaten → Brutto, „berechnet aus Tara + Inhalt“):

| Packstück | Netto berechnet | Brutto |
|---|---|---|
| P-25001-001 | 1.434 kg | 1.511,8 kg (inkl. Karton 002) |
| P-25001-003 | 306 kg | 331 kg |
| P-25001-004 | 362,4 kg | 442,4 kg |

*(optional)* Prüfregeln ausprobieren: Den Karton **P-25001-002** öffnen und **Wieder öffnen** klicken – die App lehnt ab,
weil er in der abgeschlossenen Kiste 001 liegt. Einen Button „Versandbereit melden“ gibt es beim Karton nicht, denn
versandbereit gemeldet wird nur das äußerste Packstück.

### 3.8 Fotos und Etiketten

1. In Kiste **P-25001-001** unter **Bilddokumentation** → **Innenaufnahme Kiste** → Foto aufnehmen (am PC: Bilddatei wählen).
   *Erwartet:* „1 Bild gespeichert: Innenaufnahme Kiste“, Vorschaubild mit Zeit und Name; Klick öffnet die Großansicht.
2. **Etikett drucken**. *Erwartet:* Vorschau 100 × 150 mm mit Projekt, Packstück-Nr., PSP, Versandstatus,
   Gewicht, Maßen, Zielort/Kunde, Code 128 und QR-Code. **Drucken (Browser)** öffnet den Druckdialog,
   **ZPL-Datei** lädt eine Datei für Zebra-Drucker herunter.
3. Im **Packvorrat** mehrere Positionen anhaken (z. B. 200003 und 200005) → **Artikeletiketten**.
   *Erwartet:* Etiketten 100 × 50 mm; 200003 mit dem **EAN-13 aus SAP**, und der Hinweis, dass für ein
   Material kein SAP-Barcode hinterlegt ist (200005 wird mit der Materialnummer als Code 128 gedruckt).

## 4 Fehlteil melden

1. **Packvorrat** → Zeile **200001** → **Fehlteil**.
   *Erwartet:* „… offen: 2 ST …“ im Dialog.
2. Fehlmenge `2`, voraussichtlich verfügbar `20.10.2026`, Grund `Noch in Fertigung (Schleiferei)` → **Speichern**.
   *Erwartet:* Zeile 200001: Soll 8, verpackt 6, offen 2, Fehlmenge **2**, Status **„Fehlteil vorhanden“**.
3. Reiter **Übersicht**. *Erwartet:* Verpackungsfortschritt **72,9 %**, Positionen vollständig verpackt **8 / 12**,
   Offene Fehlteile **1** (gelb hinterlegt), Packstücke (äußere) **4** („5 inkl. verschachtelter“).

## 5 Ladeplanung – LKW optimal beladen

### 5.1 Ladeplan anlegen und berechnen

1. Reiter **Ladeplanung** → **Neuer Ladeplan**:
   Bezeichnung `Hauptlieferung Schneidrad & Antrieb`, Fahrzeug **Sattelauflieger: Sattelauflieger Plane 13,60 m**,
   Haken „Bei Bedarf weitere Fahrzeuge …“ gesetzt lassen, *Packstücke übernehmen*: **Alle versandbereiten …** → **Anlegen**.
   *Erwartet:* Unter **Ladegut** stehen P-25001-001, -003, -004, -005 (der Karton 002 fährt in der Kiste mit).
2. **Excel-Import** → `4_ladegut_zusatz.csv` → **Importieren**.
   *Erwartet:* Spalten automatisch erkannt (inkl. Stapelbar, Drehbar, Entladestelle), „Import abgeschlossen: 2 neu …“;
   Überschrift **„Ladegut (11 Teile)“**.
3. **Optimal beladen**.
   *Erwartet:*
   - Meldung „11 von 11 Teilen in 1 Laderaum/-räumen verladen.“
   - **Auslastung:** Gewicht **8.665,2 kg** (36,1 % der Nutzlast), Volumen 44,5 %, Lademeter 10,62 ldm
   - **Gewichtsverteilung:** Vorne 8.367 kg von 11.500 kg, hinten 7.298 kg von 24.000 kg, „Alle Grenzwerte eingehalten.“
   - Das nicht stapelbare Großcolli trägt nichts; das Stahlgestell (nicht drehbar) liegt in Längsrichtung am Boden.

### 5.2 3D-Ansicht und Schritt für Schritt

1. In der 3D-Ansicht ziehen (drehen), scrollen (zoomen), Buttons **Oben / Seite / Heck / Front / 3D** probieren.
   *Erwartet:* Teile tragen Packstück-Nr. und Schritt, rote Kugel = Schwerpunkt, orange Kegel = Achsen,
   Beschriftung „Stirnwand / Front“ und „Tür / Heck“.
2. Den Schieberegler auf 1 stellen und mit **▶** durchklicken.
   *Erwartet:* Die Ladung baut sich Schritt für Schritt auf; darunter steht z. B.
   „Schritt 1: P-25001-003 – 0–120 cm ab Stirnwand, links (0–80 cm), Boden“.

### 5.3 Manuell anpassen

1. In der **Beladereihenfolge** „Stahlgestell Nachläufer“ anklicken (oder das Teil in 3D).
   *Erwartet:* Es wird blau hervorgehoben; unter **Manuell anpassen** stehen seine Position und Aktionen.
2. *x ab Stirnwand* `0`, *y* `0` → **Position übernehmen**.
   *Erwartet:* Ablehnung „Nicht zulässig: … überschneidet sich mit …“.
3. **10 cm zum Heck →**. *Erwartet:* „Teil verschoben.“, Kennzahlen und Reihenfolge werden neu berechnet.
4. **90° drehen**. *Erwartet:* Button ist ausgegraut – das Stahlgestell ist als „nicht drehbar“ importiert.
5. Zum Zurücksetzen einfach erneut **Optimal beladen**.

### 5.4 Bericht und Excel

1. **Bericht drucken** → Haken „Schritt-für-Schritt-Bilder“ → **Bericht erstellen**.
   *Erwartet:* Druckvorschau mit Kennzahlen, Achslasten, 3D-, Drauf- und Seitenansicht, Beladereihenfolge und je
   Schritt einem Bild (als PDF speicherbar).
2. **Excel-Export**. *Erwartet:* Datei „Ladeplan P-25001 Hauptlieferung Schneidrad & Antrieb.xlsx“ mit den Blättern
   „Übersicht“ und „Laderaum 1“.

### 5.5 *(optional)* Variante mit kleinem LKW

1. Ladeplanung → **Neuer Ladeplan**, Bezeichnung `Variante 7,5 t`, Fahrzeug **Motorwagen 7,5 t Koffer 6,20 m**,
   *Packstücke übernehmen*: **Keine** → **Anlegen**.
2. **Excel-Import** `4_ladegut_zusatz.csv` → **Optimal beladen**.
   *Erwartet:* „6 von 7 Teilen in 2 Laderaum/-räumen verladen – 1 passt nicht.“ Zwei Reiter (der zweite
   „(zusätzlich 1)“ wurde automatisch ergänzt). Unter **Nicht verladen**: „Stahlgestell Nachläufer – 600 × 220 × 180 cm,
   3.200 kg – Gewicht überschreitet die Nutzlast des Laderaums“.

## 6 Verladung nach Ladeplan (Hauptlieferung)

1. Zurück zum Plan „Hauptlieferung Schneidrad & Antrieb“ → unten **Lieferung / Verladung** → **Neue Lieferung anlegen**.
   *Erwartet:* „Zugeordnet: L**JJJJ**00001 · Hauptlieferung · Geplant“ (JJJJ = aktuelles Jahr). Auf die Lieferungsnummer klicken.
2. *Erwartet* auf der Lieferung, Bereich **Ladeplan**: „0 von 4 Packstücken laut Plan verladen · + 7 zusätzliche Teile ohne Scan“,
   „Nächster Schritt 1: P-25001-003 – …“, 3D-Ansicht mit durchscheinenden (offenen) Teilen.
3. Im Scanfeld **„Packstück zum Verladen scannen“** zuerst `P-25001-001` scannen.
   *Erwartet:* gelbe Meldung „✓ P-25001-001 verladen. Reihenfolge laut Ladeplan: Schritt 1 noch nicht verladen. …“
4. `HU00000003` scannen (HU-Nummer der Palette). *Erwartet:* grün „… Ladeplan Schritt 1: 0–120 cm ab Stirnwand, links …“
5. `P-25001-002` scannen. *Erwartet:* rot „Packstück P-25001-002 ist in P-25001-001 verpackt. Bitte P-25001-001 verladen.“
6. `P-25001-004` und `P-25001-005` scannen. *Erwartet:* „Alle Packstücke des Plans sind verladen.“
7. **Verladung abschließen (Warenausgang)** → **Abschließen**.
   *Erwartet:* Fehler „Bitte zuerst das Kennzeichen (LKW / Container-Nr.) erfassen.“
8. **Verladedokumentation** → **LKW-Kennzeichen** → Foto aufnehmen. *Erwartet:* „1 Bild gespeichert: LKW-Kennzeichen“.
9. **Lieferdaten**: Kennzeichen `HH-NT 2501`, Spedition `Spedition Elbtrans`, Fahrer `K. Beispiel` → **Lieferdaten speichern**.
10. **Verladung abschließen (Warenausgang)** → **Abschließen**. *Erwartet:* Status „Verladen / Warenausgang“,
    Kennzahlen: 4 Packstücke („5 inkl. enthaltener“), Bruttogewicht **2.765,2 kg**.
11. **Packliste drucken**. *Erwartet:* A4-Packliste mit Kopfdaten, Packstücken, Inhalt je Packstück (Karton 002 mit
    „liegt in P-25001-001“) und Unterschriftsfeldern.
12. **Zustellung bestätigen** → Bemerkung `Empfang durch Bauleitung, ohne Schäden` → **Bestätigen**.
    *Erwartet:* Status „Ausgeliefert“. Die Packstücke (auch der Karton in der Kiste) stehen auf „Ausgeliefert“.

## 7 Nachlieferung des Fehlteils

1. **Packstücke** → **Neues Packstück**: `Kiste`, `Kiste Nachlieferung Schneidrollen`, PSP `P-25001.01.01`,
   Lagerplatz `Sammelplatz A1`, Maße `120` × `80` × `60`, Tara `40` (→ **P-25001-006**).
2. Menge `2`, Scan `200001`. *Erwartet:* „… offen im Projekt: 0 ST“ – die Fehlteilmeldung ist damit erledigt.
3. **Verpackung abschließen** → **Versandbereit melden**.
4. Reiter **Lieferungen** → **Neue Lieferung**, Kennzeichen `HH-NT 2519` → **Anlegen**.
   *Erwartet:* „Lieferung L**JJJJ**00002 angelegt (**Nachlieferung**).“ – automatisch, weil die erste Lieferung bereits
   den Warenausgang hat.
5. `P-25001-006` scannen → **Verladung abschließen (Warenausgang)** → **Abschließen**.
6. Reiter **Fehlteile & Nachlieferungen**.
   *Erwartet:* „Keine offenen Fehlteile.“, eine Nachlieferung L…00002, und unter **Erledigte Fehlteile**:
   200001 mit „P-25001-001 6 ST · L…00001 (Hauptlieferung)“ und „P-25001-006 2 ST · L…00002 (Nachlieferung)“.

## 8 Rückwärtssuche und Scan-Seite

1. Menü **Rückwärtssuche**, Suchbegriff `200001` → **Suchen**.
   *Erwartet:* „Erkannt: Material 200001 …“, Status „Verladen“, Vermerk „war Fehlteil“, zwei Packstücke mit Lagerplatz,
   Lieferung, **Nachlieferung**, Kennzeichen, Verlade- und Zustellzeit sowie das Kennzeichen-Foto unter **Bilder**.
2. Suchbegriff `4006381333931` (Barcode). *Erwartet:* Material 200003 mit **beiden** PSP-Positionen
   (P-25001.02.01 im Karton 002, P-25001.03.01 in Kiste 004).
3. Suchbegriff `HH-NT 2501`. *Erwartet:* Lieferung L…00001, Hauptlieferung, Ausgeliefert, mit Foto.
4. Menü **Scannen**, `HU00000002` scannen. *Erwartet:* Die Seite des Kartons öffnet sich: Status „Ausgeliefert“,
   „liegt in: P-25001-001 (Kiste)“.

## 9 Echtzeit mit zwei Geräten

1. Ein zweites Browserfenster (oder ein Smartphone im selben Netz, Adresse aus der Server-Konsole) auf
   **Projekte → P-25001 → Packvorrat** öffnen.
2. Im ersten Fenster eine Position ändern oder ein Packstück anlegen.
   *Erwartet:* Das zweite Fenster aktualisiert sich innerhalb einer Sekunde ohne Neuladen. Tippt man dort gerade in
   ein Formular, erscheint stattdessen oben „Es liegen neue Daten von anderen Geräten vor. [Aktualisieren]“.

## 10 Protokoll und SAP-Rückmeldung

1. Projekt → Reiter **Verlauf**. *Erwartet:* Jede Buchung mit Zeit, Benutzer „Testperson“, Objekt und Details.
2. Auf einer Packstückseite unten **Verlauf dieses Packstücks** (lückenlose Rückverfolgung).
3. Menü **Einstellungen** → **SAP-Rückmeldung**. *Erwartet:* Einige Dutzend Nachrichten „wartet“ (Übertragung ist
   ausgeschaltet), z. B. `HU_CREATED`, `HU_ITEM_PACKED`, `HU_STATUS`, `HU_LOADED`, `DELIVERY_GOODS_ISSUE`.
   **Offene als JSON exportieren** lädt sie als Datei herunter.
4. *(optional)* Einen Test-Endpunkt eintragen (z. B. einen HTTP-Mock) und die Übertragung einschalten →
   die Nachrichten wechseln auf „übertragen“; bei Fehlern zeigt die App den letzten Fehler und sendet später erneut.

## 11 *(optional)* Scanner, Kamera und Drucker

- **Hardware-Scanner** (z. B. Zebra, Tastatur-Modus mit Enter): Im Packvorrat Artikeletiketten drucken und in einer
  offenen Kiste scannen – es muss kein Eingabefeld angeklickt sein.
- **Kamera am Smartphone:** Server mit `npm run start:https` starten (Adresse aus der Konsole, Zertifikatswarnung einmal
  bestätigen). Im Scanfeld das Kamera-Symbol antippen. Ohne HTTPS: Barcode fotografieren und auswerten lassen.
- **Etikettendrucker:** Einstellungen → Etikettendrucker → IP-Adresse eintragen → **Testdruck**. Danach bietet der
  Etikettendialog **An Drucker senden** an.

## 12 Anmeldung und Rollen

1. Menü **Benutzer** → **Benutzer anlegen**: Benutzername `p.packer`, Name `Paul Packer`, Rolle **Verpackung**,
   das vorgeschlagene Startpasswort notieren → **Anlegen**.
   *Erwartet:* Zeile „Paul Packer“ mit Status **Startpasswort**. Die Tabelle **Rollen und Rechte** zeigt, was jede Rolle darf.
2. Oben rechts auf den eigenen Namen klicken → **Abmelden**. *Erwartet:* Anmeldemaske, das Menü ist ausgeblendet.
3. Mit `p.packer` und einem falschen Passwort anmelden. *Erwartet:* „Benutzername oder Passwort ist falsch.“
4. Mit dem Startpasswort anmelden. *Erwartet:* Seite **Eigenes Passwort vergeben**; erst nach dem Speichern eines
   eigenen Passworts öffnet sich die App.
5. Als Paul Packer das Projekt öffnen.
   *Erwartet:* Im Menü fehlen **Einstellungen** und **Benutzer**. Packstücke lassen sich anlegen und verpacken;
   „Neues Projekt“, der Import des Packvorrats, „Neue Lieferung“ und die Bearbeitung der Ladeplanung fehlen.
   Auf einer Lieferung sind die Lieferdaten gesperrt, das Scanfeld zum Verladen fehlt.
6. Ein Packstück scannen bzw. Material verpacken, dann Reiter **Verlauf**. *Erwartet:* Die Buchung steht unter „Paul Packer“.
7. Abmelden, als Administrator anmelden → **Benutzer** → bei Paul Packer **Sperren**.
   *Erwartet:* Status „gesperrt“; eine Anmeldung mit diesem Konto ist nicht mehr möglich. Unten im
   **Sicherheitsprotokoll** stehen Anmeldungen, der Fehlversuch und die Kontoänderungen.
8. *(optional)* **Schlüssel anlegen** mit Bezeichnung `SAP Test`. *Erwartet:* Der Zugriffsschlüssel wird einmalig
   angezeigt. Er gilt nur für die Eingangsschnittstellen (`/api/integration/…`).

---

## Abdeckung der Anforderungen

| Anforderung | Abschnitte |
|---|---|
| 1 Packvorrat (PSP, Excel, Lieferant, manuell, Fehlteile, Mengen) | 2, 4 |
| 2 Scannergestützter Verpackungsprozess, Fehlervermeidung | 3.1–3.6, 6, 11 |
| 3 Digitale Handling Units, mehrstufige Verpackung | 3, 3.4, 3.7 |
| 4 Mobile Bilddokumentation (Verpackung, Verladung) | 3.8, 6.8 |
| 5 Etiketten mit vorhandenen SAP-Barcodes | 1, 3.8 |
| 6 Standardisierte Status | 2.6, 3, 4, 6, 7 |
| 7 Rückwärtssuche | 8 |
| Echtzeit, Rückverfolgbarkeit, SAP-Rückmeldung | 9, 10 |
| Ladeplanung (LKW/Container optimal beladen) | 5, 6 |

## Wenn etwas nicht wie beschrieben aussieht

- **Andere Packstück-/HU-Nummern:** Die Anleitung geht von einer leeren Datenbank aus (Ordner `data-test` löschen).
- **Lieferungsnummer:** enthält das aktuelle Jahr (z. B. L202600001).
- **Import erkennt Spalten nicht:** Datei aus `docs/beispieldaten` unverändert verwenden; Excel speichert CSV-Dateien
  beim Öffnen und Speichern teils in anderem Format.
- **Keine 3D-Ansicht:** Der Browser muss WebGL unterstützen (aktuelle Versionen von Chrome, Edge, Firefox, Safari).
