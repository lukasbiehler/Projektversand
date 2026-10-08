# Demo-Leitfaden Projektversand

Sprechzettel für die Präsentation mit dem Beispielprojekt **P-25001** der Demo-Version. Dauer etwa 15 Minuten, Kurzfassung 5 Minuten (siehe Ende).

Je Station steht: **Klicken** (was Sie tun), **Zeigt sich** (was auf dem Bildschirm erscheinen muss) und **Sagen** (Kernaussage). Alle Eingaben und Anzeigen wurden mit dem frisch geladenen Beispielprojekt nachvollzogen.

## Vor der Präsentation

- Link 2–3 Minuten vorher öffnen, damit die Demo wach ist.
- In der Hinweisleiste oben **Beispielprojekt neu laden** → **Zurücksetzen**. Damit stimmen alle Nummern in diesem Leitfaden.
- Im Dialog „Wer arbeitet an diesem Gerät?“ Ihren Namen eintragen.
- Gescannt wird in der Vorführung per Tastatur: Code ins Scanfeld tippen und **Enter**. Das verhält sich wie ein Hardware-Scanner.
- Optional: ein Smartphone mit demselben Link bereitlegen (Station 9).
- Die Lieferungsnummern enthalten das aktuelle Jahr, z. B. `L202600001`.

## Ablauf im Überblick

| Nr. | Station | Minuten |
|---|---|---|
| 1 | Einstieg und Projektübersicht | 2 |
| 2 | Packvorrat statt Excel-Liste | 1,5 |
| 3 | Live verpacken per Scan | 2 |
| 4 | Packstück: mehrstufig, Etikett, Foto | 1,5 |
| 5 | Ladeplanung in 3D | 2,5 |
| 6 | Verladung nach Ladeplan | 2,5 |
| 7 | Fehlteil und Nachlieferung | 1,5 |
| 8 | Rückwärtssuche | 1 |
| 9 | Abschluss | 0,5 |

## Station 1 – Einstieg und Projektübersicht

- **Sagen:** Heute läuft der Projektversand über Excel-Packlisten, Bildordner und SAP nebeneinander. Niemand sieht in Echtzeit, was verpackt, was offen und was schon unterwegs ist. Diese Demo zeigt den durchgängigen Ablauf an einem Beispielprojekt.
- **Klicken:** Startseite → Karte **P-25001** anklicken.
- **Zeigt sich:** Auf der Karte „1 Fehlteil“, Verpackt **72,9 %**, **8/12** Positionen, **5** Packstücke. In der Übersicht: Offene Fehlteile **1** (gelb), Packstücke (äußere) **5**, Lieferungen **1**, darunter die Statusverteilung für Material und Packstücke.
- **Sagen:** Auf einen Blick: Wie weit ist das Projekt, wo fehlt etwas, was ist versandbereit. Die Zahlen aktualisieren sich bei jeder Buchung auf allen Geräten.

## Station 2 – Packvorrat statt Excel-Liste

- **Klicken:** Reiter **Packvorrat**.
- **Zeigt sich:** 12 Positionen mit Soll, Verpackt, Offen, Fehlmenge und Status. In der Spalte *Quelle* drei Herkünfte: „PSP-Element (SAP)“, „Excel-Packliste“ und „Lieferantenmaterial“. Zeile **200001**: Soll 8, verpackt 6, offen 2, Fehlmenge 2, Status „Fehlteil vorhanden“.
- **Sagen:** Der Packvorrat kommt aus dem SAP-Export der PSP-Elemente, aus bestehenden Excel-Packlisten und aus Lieferantenmaterial. Jede Position zeigt, in welchem Packstück sie liegt.
- **Klicken (optional):** **Import (Excel / SAP)** öffnen, kurz die automatische Spaltenzuordnung zeigen, **Abbrechen**.

## Station 3 – Live verpacken per Scan

- **Klicken:** Reiter **Packstücke** → **P-25001-006** (Kiste Schaltschrank, Status „Angelegt“).
- **Klicken:** Im Scanfeld `300001` eingeben, **Enter**.
- **Zeigt sich:** Grün „✓ 1 ST 300001 Schaltschrank Steuerung verpackt – offen im Projekt: 0 ST“, Status wechselt auf „Verpackung begonnen“.
- **Klicken:** Noch einmal `300001`, **Enter**.
- **Zeigt sich:** Rot „Material 300001 ist im Projekt bereits vollständig verpackt.“
- **Sagen:** Der Scan ordnet das Material der richtigen Position zu. Zu viel, falsches oder nicht vorgesehenes Material wird sofort abgewiesen. Gescannt werden die vorhandenen SAP-Barcodes, es gibt keine zweite Barcodewelt.
- **Klicken:** **Verpackung abschließen** → **Versandbereit melden**.
- **Zeigt sich:** Status „Versandbereit“, Brutto **490 kg** (berechnet aus Tara + Inhalt).
- **Sagen:** Versandbereit geht nur mit Maßen und vollständigem Gewicht. So entstehen keine Packstücke mit Lücken in den Versanddaten.

## Station 4 – Packstück: mehrstufig, Etikett, Foto

- **Klicken:** Reiter **Packstücke** → **P-25001-001** (Kiste Schneidrad-Werkzeuge).
- **Zeigt sich:** Inhalt mit 2 Positionen, darunter **Enthaltene Packstücke (1)**: Karton **P-25001-002** mit 17,8 kg. Brutto der Kiste **1.511,8 kg** inklusive Karton.
- **Sagen:** Jedes Packstück ist eine Handling Unit mit Nummer, Maßen, Gewicht, Lagerplatz und Status. Verschachtelung funktioniert per Scan des Packstück-Etiketts, zum Beispiel Karton in Kiste in Container.
- **Klicken:** **Etikett drucken**.
- **Zeigt sich:** Vorschau 100 × 150 mm mit Projekt, Packstück-Nr., Gewicht, Maßen, Zielort, Barcode und QR-Code. Danach **Schließen**.
- **Klicken (optional):** Unter **Bilddokumentation** → **Innenaufnahme Kiste** ein Bild wählen. Es erscheint „1 Bild gespeichert: Innenaufnahme Kiste“.
- **Sagen:** Fotos entstehen direkt am Gerät und hängen am Packstück, nicht mehr in einem separaten Bildarchiv.

## Station 5 – Ladeplanung in 3D

- **Klicken:** Projekt **P-25001** → Reiter **Ladeplanung** → **Hauptlieferung Schneidrad & Antrieb**.
- **Zeigt sich:** 3D-Ansicht des Sattelaufliegers mit 11 Teilen, Gewicht **8.665,2 kg** (36,1 % der Nutzlast), vorne 8.367 kg von 11.500 kg, hinten 7.298 kg von 24.000 kg.
- **Sagen:** Die App belädt das gewählte Fahrzeug automatisch und beachtet dabei Maße, Nutzlast, Stapelbarkeit, Auflast und Achslasten.
- **Klicken:** **Packstücke einplanen** → die eben gepackte Kiste P-25001-006 ist vorausgewählt → **Einplanen**.
- **Zeigt sich:** Gelber Hinweis, dass der Plan neu berechnet werden muss.
- **Klicken:** **Optimal beladen**.
- **Zeigt sich:** „12 von 12 Teilen in 1 Laderaum/-räumen verladen.“ Gewicht **9.155,2 kg** (38,1 %), Volumen 47,9 %, 11,64 Lademeter, „Alle Grenzwerte eingehalten.“
- **Klicken:** Ansicht mit der Maus drehen, dann den Schieberegler nach links ziehen und mit **▶** durchklicken.
- **Zeigt sich:** Die Ladung baut sich Schritt für Schritt auf. Schritt 1 ist P-25001-001 vorne links am Boden.
- **Sagen:** Der Verlader bekommt eine feste Reihenfolge mit Position. Passt ein Fahrzeug nicht, ergänzt die App automatisch ein weiteres. Der Plan lässt sich als Bericht drucken und nach Excel exportieren.
- **Klicken (optional):** In der Liste „Stahlgestell Nachläufer“ anklicken. Der Button **90° drehen** ist grau, weil das Teil als nicht drehbar hinterlegt ist.

## Station 6 – Verladung nach Ladeplan

- **Klicken:** Im Ladeplan ganz unten bei **Lieferung / Verladung** auf die Lieferungsnummer `L…00001`.
- **Zeigt sich:** Bereich **Ladeplan**: „0 von 5 Packstücken laut Plan verladen“, „Nächster Schritt 1: P-25001-001 …“, offene Teile durchscheinend.
- **Klicken:** Absichtlich falsch: `P-25001-003` scannen.
- **Zeigt sich:** Gelb „✓ P-25001-003 verladen. Reihenfolge laut Ladeplan: Schritt 1, 2 noch nicht verladen. …“
- **Klicken:** `P-25001-001` scannen.
- **Zeigt sich:** Grün „… Ladeplan Schritt 1: 0–240 cm ab Stirnwand, links (0–120 cm), Boden.“
- **Klicken:** `P-25001-002` scannen (der Karton in der Kiste).
- **Zeigt sich:** Rot „Packstück P-25001-002 ist in P-25001-001 verpackt. Bitte P-25001-001 verladen.“
- **Klicken:** Nacheinander `P-25001-004`, `P-25001-005`, `P-25001-006` scannen.
- **Zeigt sich:** „Alle Packstücke des Plans sind verladen.“
- **Klicken:** **Verladung abschließen (Warenausgang)** → **Abschließen**.
- **Zeigt sich:** Rot „Bitte zuerst das Kennzeichen (LKW / Container-Nr.) erfassen.“
- **Klicken:** Unter **Lieferdaten** Kennzeichen `HH-NT 2501` → **Lieferdaten speichern** → erneut **Verladung abschließen (Warenausgang)** → **Abschließen**.
- **Zeigt sich:** Status „Verladen / Warenausgang“, 5 Packstücke („6 inkl. enthaltener“), Bruttogewicht **3.255,2 kg**.
- **Klicken (optional):** **Packliste drucken** zeigen, dann **Zustellung bestätigen** → **Bestätigen**. Status wird „Ausgeliefert“.
- **Sagen:** Verladen wird per Scan. Die App führt durch die Reihenfolge, verhindert Fehlverladungen und meldet den Warenausgang. Kennzeichen und Ladungsfotos gehören zur Lieferung.

## Station 7 – Fehlteil und Nachlieferung

- **Klicken:** Projekt → Reiter **Fehlteile & Nachlieferungen**.
- **Zeigt sich:** Offenes Fehlteil **200001**, Fehlmenge 2 ST, Grund „Noch in Fertigung (Schleiferei)“, erwartet 20.10.2026.
- **Sagen:** Fehlteile sind sichtbar, mit Grund und Termin. Die Hauptlieferung ist trotzdem raus.
- **Klicken:** Reiter **Packstücke** → **Neues Packstück**: `Kiste`, Bezeichnung `Kiste Nachlieferung Schneidrollen`, Maße `120` × `80` × `60`, Tara `40` → **Anlegen**.
- **Klicken:** Menge je Scan `2`, Scan `200001`.
- **Zeigt sich:** „✓ 2 ST 200001 … offen im Projekt: 0 ST“.
- **Klicken:** **Verpackung abschließen** → **Versandbereit melden**.
- **Klicken:** Reiter **Lieferungen** → **Neue Lieferung**, Kennzeichen `HH-NT 2519` → **Anlegen**.
- **Zeigt sich:** „Lieferung L…00002 angelegt (Nachlieferung).“
- **Klicken:** `P-25001-007` scannen → **Verladung abschließen (Warenausgang)** → **Abschließen**.
- **Klicken:** Reiter **Übersicht**.
- **Zeigt sich:** Verpackungsfortschritt **83,3 %**, **10 / 12** Positionen, Offene Fehlteile **0**, Lieferungen **2**, „davon 1 Nachlieferung(en)“.
- **Sagen:** Die App erkennt selbst, dass es eine Nachlieferung ist, und löst das Fehlteil beim Verpacken auf.

## Station 8 – Rückwärtssuche

- **Klicken:** Menü **Rückwärtssuche**, `200001` eingeben → **Suchen**.
- **Zeigt sich:** Material 200001, Status „Verladen“, Vermerk „war Fehlteil“. Zwei Packstücke: P-25001-001 mit 6 ST auf Lieferung `L…00001` (HH-NT 2501) und P-25001-007 mit 2 ST auf `L…00002`, markiert als **Nachlieferung** (HH-NT 2519).
- **Sagen:** Die Frage „Wo ist dieses Teil?“ ist in Sekunden beantwortet: Packstück, Lagerplatz, Lieferung, Kennzeichen, Zeitpunkt und Bilder.

## Station 9 – Abschluss

- **Klicken (optional):** Auf dem Smartphone denselben Link öffnen und zeigen, dass dort derselbe Stand steht. Reiter **Verlauf** zeigt jede Buchung mit Name und Zeit.
- **Sagen:** Ein durchgängiger Ablauf ohne Medienbrüche, jede Buchung nachvollziehbar. Das hier ist eine Demo: Anmeldung, dauerhafte Datenhaltung und die Anbindung an SAP kommen bei einer Freigabe dazu.

## Kurzfassung in 5 Minuten

- Station 1: Projektkarte und Übersicht zeigen.
- Station 3: `300001` in Kiste P-25001-006 scannen, abschließen, versandbereit melden.
- Station 5: Ladeplan öffnen, Kiste einplanen, **Optimal beladen**, 3D drehen.
- Station 6: Zwei Scans an der Lieferung (`P-25001-003` mit Warnung, dann `P-25001-001`).
- Station 8: Rückwärtssuche nach `200003` (Dichtungssatz in zwei Packstücken). Diese Suche funktioniert auch ohne die Schritte aus Station 7.

## Wenn etwas hakt

| Beobachtung | Abhilfe |
|---|---|
| Nummern weichen ab oder Daten fehlen plötzlich | **Beispielprojekt neu laden** in der Hinweisleiste, an der passenden Station wieder einsteigen |
| Seite lädt beim ersten Aufruf langsam | Die Demo war im Ruhezustand. Einige Sekunden warten, dann neu laden |
| Scan reagiert nicht | Ins Scanfeld klicken, Code tippen, **Enter** |
| 3D-Ansicht bleibt leer | Seite neu laden. Der Browser braucht WebGL (Chrome, Edge, Firefox, Safari aktuell) |
| Druckdialog stört | Mit **Abbrechen** schließen, die Vorschau reicht für die Demo |

## Fragen, die kommen können

- **Ist das schon an SAP angebunden?** Nein. Jede Buchung wird als Nachricht vorbereitet (Einstellungen → SAP-Rückmeldung zeigt die Warteschlange). Der Empfang auf SAP-Seite muss noch gebaut werden.
- **Wer darf was?** Die Demo hat keine Anmeldung, nur einen Namen je Gerät für das Protokoll. Benutzerkonten und Rollen kommen bei einer Freigabe.
- **Bleiben die Daten erhalten?** In der Demo nicht, sie wird regelmäßig zurückgesetzt. Im Betrieb läuft die App auf einem Server mit dauerhafter Datenbank.
- **Geht das mit unseren Scannern und Etiketten?** Hardware-Scanner im Tastatur-Modus und Kamera-Scan sind vorgesehen, Etiketten gehen über den Druckdialog oder als ZPL-Datei für Zebra-Drucker. Mit echten Geräten ist es noch nicht getestet.
- **Wie gut ist der Ladeplan?** Er ist gültig und gut, aber nicht garantiert das rechnerische Optimum. Die Fahrzeugdaten sind Richtwerte und müssen an die eingesetzten Fahrzeuge angepasst werden.
