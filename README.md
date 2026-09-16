# Server Status Hub v3.7

Multi-User Hosting für Discord Status Bots mit WARDOGS, FiveM, GameDig, generischer JSON API, reinen Text-Rotationen, Premium-Plänen, Free-Boost, Multi-VPS Nodes und freigeschalteten Custom Bots.

## Neu in v3.7

- öffentliche `Bots as a Service`-Seite unter `/bot-services`
- einzelne Managed Bots unabhängig von Status-Bot-Limits anbieten
- Admin-Katalog für Name, Beschreibung, Features, Preis, Status, Kauf-Link, Support-Link und Sichtbarkeit
- vorbereiteter `WARDOGS Warning Bot` als Coming-Soon-Angebot
- Deutsch/Englisch für Bot-Service-Inhalte
- öffentliche Team-Seite unter `/team`
- erster `.env`-Admin als `Founder & Administrator`
- weitere Admins automatisch als `Administrator`
- Discord User `293104788361576448` standardmäßig als Team Member
- Text-only Status Bots, Free-Boost, Premium, Donations, Node Manager und Multi-VPS bleiben enthalten

## Bot Services

Unter `/bot-services` werden einzeln buchbare Spezial-Bots angeboten. Diese Produkte sind getrennt von Status-Bot-Plänen und Custom-Bot-Freigaben.

Der Admin verwaltet Angebote unter `/admin/bot-services`. Ein Angebot kann `Coming soon`, `Available` oder `Paused` sein. Kauf- und Support-Links sind frei konfigurierbar.

Der vorbereitete WARDOGS Warning Bot überwacht Spieler-Joins und kann Discord-Warnungen senden, wenn die eigenen Erkennungsregeln einen Spieler als auffällig markieren. Preis und Kauf-Link werden erst im Adminbereich gesetzt.

## Free-Boost

Ein Free-Account startet mit 1 Status Bot. Alle Free Status Bots rotieren automatisch `Powered by status-hub.lol` mit.

Für mehr kostenlose Bots muss mindestens einer der Status Bots des Users auf einem Discord-Server laufen, auf dem der Branding-Channel ganz oben steht. Der Channel muss für `@everyone` sichtbar sein.

Das Panel prüft die Discord-Server über den vorhandenen Bot-Token. Es verwendet den größten gültigen Server des Users und setzt das Free-Limit anhand der konfigurierten Mitgliederstufen. Die Prüfung läuft regelmäßig erneut. Wird der Channel entfernt, versteckt oder nach unten verschoben, verfällt der Boost nach Ablauf der Verifizierung.

## Premium

| Plan | Status Bots | Branding |
|---|---:|---|
| Free | 1 bis 5 mit Free-Boost | `Powered by status-hub.lol` |
| Premium 5 | 5 | nein |
| Premium 10 | 10 | nein |
| Premium 15 | 15 | nein |
| Premium 20 | 20 | nein |

Admins können Plan und Laufzeit pro User im Backend setzen. Nach Ablauf fällt der User auf Free zurück. Bots oberhalb des neuen Limits werden pausiert, nicht gelöscht.

## Node Manager

Jeder Status Node meldet Kapazität, RAM, Load, Laufzeit und Heartbeat an die Control Plane.

Im Adminbereich können Nodes:

- für neue Bots gesperrt werden
- komplett deaktiviert werden
- gedraint werden
- in der Kapazität geändert werden
- einzelne Bots auf einen anderen Node verschieben
- alle Bots auf einen gewählten Node verschieben

Neue Debian-VPS Nodes können mit einem Einzeiler installiert werden. Remote Nodes sollten nur über eine HTTPS-Control-Plane verwendet werden.

## Donations und Supporter

Unter `/donate` gibt es eine öffentliche Support-Seite. Im Adminbereich können PayPal-, Ko-fi-, Stripe- oder eigene Support-Links gesetzt werden.

Supporter werden im Adminbereich manuell eingetragen und können mit Name, Badge/Betrag, Nachricht, Link und Featured-Status öffentlich angezeigt werden. Ein Payment-Webhook ist noch nicht an einen bestimmten Anbieter gebunden.

## Text-only Status Bots

Neben Gameserver-Bots können Nutzer einen Status-Bot als reine Text-Rotation anlegen. Dabei wird kein Gameserver abgefragt. Jede Zeile ist ein Status-Text und wird im gewählten Intervall durchgeschaltet.

Text-only Bots zählen exakt wie Gameserver-Bots gegen dasselbe Free-/Premium-Limit und werden ebenfalls über die Status Nodes verteilt. Free-Accounts erhalten auch dort das automatische `Powered by status-hub.lol` Branding.

## Games

- WARDOGS direkt
- FiveM direkt
- GameDig mit 320+ Game-/Service-Typen
- generische JSON API

Die Games-&-FAQ-Seite zeigt Suchfeld, Features, Standardports und bekannte Einschränkungen.

## Custom Bots

Custom Bots sind Node.js- oder Python-ZIPs. Ein User kann sie nur hochladen, wenn `customBotLimit > 0` im Adminbereich gesetzt wurde. Jeder Upload benötigt zusätzlich Admin-Freigabe. Premium oder Free-Boost geben niemals automatisch Custom-Bot-Rechte.

Custom Bots laufen in separaten eingeschränkten Docker-Containern.

## Erstinstallation

```bash
cd /opt
git clone https://github.com/testererrewr/wardogs-status-panel.git
cd wardogs-status-panel
bash ./setup-vps.sh
```

## Update

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

`.env`, `data/` und `custom-bots/` gehören nicht auf GitHub.

## Wichtige URLs

Bei direktem IP-Betrieb:

```text
http://DEINE-IP:3000
http://DEINE-IP:3000/auth/discord/callback
```

Später mit Domain:

```text
https://status-hub.lol
https://status-hub.lol/auth/discord/callback
```

Die tatsächliche `PUBLIC_URL` erst umstellen, wenn DNS und HTTPS für die Domain eingerichtet sind. Das Branding kann bereits vorher `status-hub.lol` verwenden.
