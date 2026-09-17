# Update v3.12.0

WARDOGS Warning & Management Bot: strukturierte Regeln, echte Dropdowns und Discord Management Panel.

## Detection Rules

- Die bisherige Freitext-Syntax wurde im Webpanel durch strukturierte Regelzeilen ersetzt.
- Regeltyp per Dropdown: SteamID64, Spielername enthält, Team/Fraktion oder Ping.
- Ping unterstützt `>` und `>=` als Operator.
- Wert und optionaler Warn-/Banngrund werden in eigenen Feldern eingetragen.
- Intern bleibt das bestehende Regelformat kompatibel, damit vorhandene Regeln automatisch übernommen werden.
- Auto-Ban bleibt standardmäßig **AUS**.

## Player / Team Controls

- `Set Team` ist kein Freitextfeld mehr.
- Die Teams werden live aus `status.factionScores` des verbundenen WARDOGS-Servers gelesen und als Dropdown angezeigt.
- Nach einem Teamwechsel wird wie bisher ein Respawn versucht.

## Map Controls

- Map und Lighting bleiben Dropdowns.
- Experiences sind jetzt als aufklappbare Mehrfachauswahl verfügbar.
- Beim Auswählen einer Map lädt das Panel die map-spezifischen Experiences über `/v1/catalog/maps/{map}/experiences`.
- Zone Alternator ist jetzt ein Dropdown und wird map-spezifisch über `/v1/catalog/maps/{map}/alternators` geladen.
- Freitext für Experiences und Zone Alternator wurde entfernt.

## Discord Management Panel

- Optionales Management Panel in einem frei wählbaren Discord-Channel.
- Standardmäßig **AUS** und muss im Webpanel ausdrücklich aktiviert werden.
- Wenn im Channel eine neue Nachricht erscheint, wird das Management Panel automatisch wieder als letzte Nachricht platziert.
- Das Panel aktualisiert regelmäßig Servername, Map, Spielerzahl, Scores sowie Auto-Ban-/Announcement-Status.
- Player-Menü mit Pagination für Server mit mehr als 25 Spielern.
- Spieleraktionen: Whisper, Kick, Ban, Kill/Respawn, Set Team und Steam-Profil.
- Server-Announcement per Discord-Modal.
- Banliste mit Unban sowie manueller Ban per SteamID64.
- Match Restart, Match End, Mapwechsel und Lighting direkt aus Discord.
- Discord-Mapwechsel unterstützt Map, Experiences, Lighting und Zone Alternator.

## Discord Rechte

Im Webpanel können bis zu 20 Freigaben eingetragen werden. Jede Freigabe kann eine Discord-Rolle oder ein einzelner Discord-Benutzer sein. Pro ID können folgende Rechte separat angehakt werden:

- Panel / Spieler ansehen
- Announcements
- Whisper
- Kick
- Ban
- Unban
- Kill / Respawn
- Team setzen
- Match steuern
- Map wechseln
- Lighting

Der Besitzer des Managed Bots und Discord-Mitglieder mit Administrator-Berechtigung haben immer Vollzugriff. Alte Installationen ohne konfigurierte Grants behalten für die bisherigen Alert-Buttons die native Discord-Kick-/Ban-Berechtigungsprüfung als Kompatibilitätsfallback.

## Datenbank

- Datenbankversion **19**.
- Neue Felder für Discord Management Panel, gespeicherte Panel-Nachricht und granulare Discord-Grants.
- Bestehende PayPal Produkt-/Plan-IDs werden nicht verändert.
- Bestehende Bots bekommen das Discord Management Panel nicht automatisch aktiviert.
