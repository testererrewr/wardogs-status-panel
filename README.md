# Server Status Hub v3.9

Multi-User Hosting für Discord Status Bots mit WARDOGS, FiveM, GameDig, generischer JSON API, Text-Rotationen, Premium-Plänen, Free-Boost, Multi-VPS Nodes, Bot Services, Donations und freigeschalteten Custom Bots.

## Neu in v3.9

- automatischer PayPal Checkout für Premium 5 / 10 / 15 / 20
- Premium wird nach bestätigter PayPal-Zahlung automatisch freigeschaltet
- sichere serverseitige PayPal Orders API
- verifizierte PayPal Webhooks als Fallback, falls der Käufer nicht zur Website zurückkehrt
- Refund/Reversal kann eine durch denselben Kauf vergebene Premium-Freischaltung automatisch entziehen
- PayPal Client ID und Secret bleiben ausschließlich in `.env`
- PayPal Sandbox/Live Modus
- Preise, Währung und Laufzeit pro Kauf im Adminbereich konfigurierbar
- Browser-Tab bleibt überall exakt `status-hub.lol`

## PayPal automatisch einrichten

Du brauchst eine PayPal REST App in deinem PayPal Developer Account.

Auf dem VPS:

```bash
cd /opt/wardogs-status-panel
bash ./setup-paypal.sh
```

Für echte Zahlungen `live` wählen und die Live Client ID sowie das Live Client Secret eintragen. Für Tests zuerst `sandbox` verwenden.

Danach im Panel:

```text
Admin -> Settings -> Premium & PayPal
```

Dort:

1. automatische PayPal-Freischaltung aktivieren
2. Währung wählen, z. B. `EUR`
3. Laufzeit pro Kauf setzen, standardmäßig `30` Tage
4. PayPal-Beträge für Premium 5 / 10 / 15 / 20 eintragen
5. Einstellungen speichern
6. `PayPal automatisch einrichten / testen` drücken

Das Panel registriert dabei den Webhook:

```text
https://status-hub.lol/webhooks/paypal
```

Ein erfolgreicher Kauf aktiviert den gewählten Premium-Plan automatisch. Ein weiterer Kauf desselben Plans verlängert die Laufzeit, sofern der vorherige Kauf noch aktiv ist.

## Premium

| Plan | Status Bots | Branding |
|---|---:|---|
| Free | 1 bis 5 mit Free-Boost | `Powered by status-hub.lol` |
| Premium 5 | 5 | nein |
| Premium 10 | 10 | nein |
| Premium 15 | 15 | nein |
| Premium 20 | 20 | nein |

Admins können Pläne zusätzlich manuell und zeitlich begrenzt freischalten. Custom-Bot-Rechte bleiben davon unabhängig.

## Free-Boost

Ein Free-Account startet mit 1 Status Bot. Alle Free Status Bots rotieren automatisch `Powered by status-hub.lol` mit.

Für mehr kostenlose Bots muss mindestens einer der Status Bots des Users auf einem Discord-Server laufen, auf dem der Branding-Channel ganz oben steht. Der Channel muss für `@everyone` sichtbar sein. Die Mitgliederstufen werden im Adminbereich konfiguriert und können bis zu 5 kostenlose Bots freischalten.

## Node Manager

Im Adminbereich können Status Nodes für neue Bots gesperrt, deaktiviert, gedraint und in ihrer Kapazität geändert werden. Einzelne oder alle Bots eines Nodes können auf andere Nodes verschoben werden.

Neue Debian-VPS Nodes können mit dem Einzeiler aus dem Node Manager installiert werden.

## Bot Services

Unter `/bot-services` werden einzeln buchbare Spezial-Bots angeboten. Diese Produkte sind getrennt von Status-Bot-Plänen und Custom-Bot-Freigaben.

## Donations und Supporter

Unter `/donate` gibt es eine öffentliche Support-Seite. Supporter können im Adminbereich gepflegt und öffentlich angezeigt werden.

## Text-only Status Bots

Text-only Bots rotieren frei definierte Discord-Status-Texte ohne Gameserver-Abfrage und zählen gegen dasselbe Status-Bot-Limit wie Gameserver-Bots.

## Games

- WARDOGS direkt
- FiveM direkt
- GameDig mit 320+ Game-/Service-Typen
- generische JSON API
- reine Text-Rotation

## Custom Bots

Custom Bots sind Node.js- oder Python-ZIPs. Upload-Slots werden ausschließlich im Adminbereich freigeschaltet. Jeder Upload benötigt zusätzlich Admin-Freigabe und läuft anschließend in einem eingeschränkten Container.

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

## Produktion

```text
https://status-hub.lol
https://status-hub.lol/auth/discord/callback
https://status-hub.lol/webhooks/paypal
```
