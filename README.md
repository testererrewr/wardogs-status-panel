# Server Status Hub v3.0

Multi-User Discord Status-Bot Hosting für einen Debian-VPS.

## Funktionen

- Anmeldung/Registrierung ausschließlich über Discord OAuth2 (`identify`)
- jeder neue Benutzer erhält standardmäßig **1 kostenlosen Status-Bot**
- Admin kann pro Benutzer das Status-Bot-Limit erhöhen oder auf 0 setzen
- Status-Bots gehören immer ihrem Benutzer; normale User sehen nur eigene Bots
- Servertypen:
  - **FiveM** (`dynamic.json` / `players.json`)
  - **WARDOGS** (`GET /v1/status`, Bearer/RCON Passwort)
  - **GameDig** (300+ Games; Game-ID + Host/Port)
  - **Generische JSON API** mit konfigurierbaren JSON-Pfaden
- rotierende Discord Presence-Texte mit `{players}`, `{max}`, `{map}`, `{server}`, `{game}`, `{ping}`
- Bot-Tokens und Query-Secrets AES-256-GCM verschlüsselt
- öffentliche User dürfen standardmäßig keine privaten/LAN/localhost-Ziele abfragen (SSRF-Schutz)
- Admin kann private Ziele pro Status-Bot erlauben

### Custom Bot Hosting

Custom Bot Uploads sind standardmäßig **gesperrt** (`customBotLimit = 0`). Ein Admin kann einem Benutzer im Bereich **Benutzer** Upload-Slots geben.

- ZIP Upload
- Node.js 22 oder Python 3.13
- ENV-Variablen verschlüsselt gespeichert
- normale User-Uploads bleiben zuerst `pending`
- **Admin muss jeden Upload freigeben**, bevor er laufen kann
- Bot läuft danach in einem eigenen Docker-Container
- 256 MB RAM, 0.5 CPU, PID-Limit
- read-only Root-FS + kleine tmpfs-Bereiche
- `cap-drop ALL`, `no-new-privileges`
- keine Host-Verzeichnisse und kein Docker-Socket im hochgeladenen Bot
- Logs im Panel

Der interne `runner` besitzt für die Containerverwaltung Zugriff auf den Docker-Socket. Er ist **nicht öffentlich erreichbar** und akzeptiert nur Requests mit einem zufälligen Shared Secret vom Panel. Trotzdem gilt: fremden Code vor der Freigabe prüfen.

## Installation auf Debian VPS

Repo klonen:

```bash
cd /opt
git clone https://github.com/DEINNAME/wardogs-status-panel.git server-status-hub
cd server-status-hub
chmod +x *.sh
./setup-vps.sh
```

Das Setup bietet zwei Modi:

1. **Direkt über IP:3000** – sinnvoll wenn 80/443 bereits belegt sind.
2. **Domain + HTTPS über Caddy** – benötigt freie Ports 80/443.

Bei Direktmodus lautet die URL z. B.:

```text
http://159.195.109.20:3000
```

Discord Redirect:

```text
http://159.195.109.20:3000/auth/discord/callback
```

Bei Domainmodus z. B.:

```text
https://status.example.com/auth/discord/callback
```

## Discord OAuth Application

Im Discord Developer Portal eine Application für den Panel-Login verwenden. Unter OAuth2 -> Redirects exakt die vom Setup ausgegebene Callback-URL eintragen. Das Panel fordert nur `identify` an.

Die Status-Bots selbst sind separate reguläre Discord Bot Accounts. Jeder Status-Bot benötigt seinen eigenen Bot Token.

## User-Modell

Erster Login eines neuen Discord Accounts:

```text
role = user
statusBotLimit = 1
customBotLimit = 0
```

Accounts in `ADMIN_DISCORD_IDS` werden automatisch Admins.

Im Adminbereich `/users` kannst du z. B. setzen:

```text
User A: Status 1 / Custom 0
User B: Status 5 / Custom 1
User C: Status 10 / Custom 3
```

## FiveM

Basis-URL z. B.:

```text
http://1.2.3.4:30120
```

Das Panel liest `dynamic.json` und `players.json`.

## WARDOGS

Basis-URL z. B.:

```text
http://1.2.3.4:7776
```

Dazu RCON/Bearer-Passwort. Abfrage: `/v1/status`.

## GameDig

Beispiel Minecraft:

```text
Game-ID: minecraft
Host: play.example.com
Port: 25565
```

GameDig unterstützt sehr viele Game-Query-Protokolle. Je nach Spiel ist statt des Gameports ein Query-Port nötig.

## Generische JSON API

Beispiel JSON:

```json
{
  "players": { "current": 12, "max": 64 },
  "map": "Arena",
  "serverName": "EU #1"
}
```

Standardpfade:

```text
players.current
players.max
map
serverName
```

Optional kann ein Bearer Token gespeichert werden.

## Custom Bot ZIP Format

Node Beispiel:

```text
my-bot.zip
├── index.js
└── package.json
```

Entrypoint: `index.js`

Python Beispiel:

```text
my-bot.zip
├── bot.py
└── requirements.txt
```

Entrypoint: `bot.py`

Secrets nicht in die ZIP packen. Im Panel als ENV eintragen:

```text
DISCORD_TOKEN=...
API_KEY=...
```

## Update von GitHub

```bash
cd /opt/server-status-hub
./update.sh
```

Das Skript führt `git pull --ff-only` aus, korrigiert die Rechte für `data/` und `custom-bots/` und baut den Stack neu.

Wenn dein bestehender Clone noch `/opt/wardogs-status-panel` heißt, ist das ebenfalls okay:

```bash
cd /opt/wardogs-status-panel
./update.sh
```

## Rechte-Fix

Das Setup und `update.sh` setzen automatisch:

```text
data/        -> UID/GID 1000:1000
custom-bots/ -> UID/GID 1000:1000
```

Damit tritt der frühere Fehler `EACCES: permission denied, open '/app/data/db.tmp'` nicht mehr auf.

## Diagnose / Backup

```bash
./doctor.sh
./backup.sh
```

Backup enthält `.env`, Datenbank und Custom-Bot-Uploads und damit sensible Daten. Nicht öffentlich hochladen.

## Architektur

```text
Internet
   |
   +--> :3000 direkt ODER Caddy :80/:443
                |
          Server Status Hub
            |        |
            |        +--> Discord Status Bots
            |        +--> FiveM/WARDOGS/GameDig/JSON Queries
            |
            +--> interner Runner ----> Docker Socket
                      |
                      +--> isolierter Custom Bot #1
                      +--> isolierter Custom Bot #2
```

`data/`, `custom-bots/` und `.env` sind in `.gitignore` und dürfen nicht nach GitHub gepusht werden.
