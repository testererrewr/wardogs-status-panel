# WARDOGS Discord Status Panel v2.1 — GitHub + Single VPS

Diese Version ist für **einen Debian-VPS** gedacht. Auf demselben VPS laufen:

- das Webpanel
- Discord OAuth2 Login
- alle konfigurierten Discord Status-Bots
- die WARDOGS/RCON-Abfragen
- Caddy als Reverse Proxy
- bei Domain-Nutzung automatisch HTTPS

Es gibt **keinen separaten Worker** mehr.

## Was das Panel kann

- Login ausschließlich mit Discord (`identify`)
- Admin-/Viewer-Freigabe über Discord User IDs
- beliebig mehrere Servereinträge / Discord Bot Accounts
- pro Gameserver eigener Discord Bot Token
- WARDOGS Status über `GET /v1/status`
- Spielerzahl und maximale Slots
- aktuelle Map
- rotierende Discord-Aktivitäten, z. B.:
  - `{players}/{max} Spieler online`
  - `Map: {map}`
  - `Server: {server}`
- eigener Wechsel-Timer und eigener RCON-Update-Timer
- Offline-Text, wenn der Gameserver nicht erreichbar ist
- RCON-Test und Bot-Neustart direkt im Panel
- Bot-Einladelink
- Bot Tokens und RCON-Passwörter verschlüsselt in `data/db.json`
- Sessions persistent in `data/sessions.json`
- Docker Restart Policy `unless-stopped`
- Caddy Reverse Proxy
- Backup- und Diagnose-Skripte

---

# Schnellinstallation über GitHub auf Debian

Empfohlen: Debian 12/13 VPS mit Root- oder sudo-Zugang. Das Projekt wird einmal in ein GitHub Repository hochgeladen. Danach muss keine ZIP-Datei mehr auf den VPS kopiert werden.

## 1. Repository klonen + Setup starten

Für ein öffentliches Repository kannst du auf dem VPS direkt diese eine Zeile verwenden:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DEINNAME/wardogs-status-panel.git /opt/wardogs-status-panel && cd /opt/wardogs-status-panel && sudo ./setup-vps.sh
```

`DEINNAME` und den Repository-Namen entsprechend ersetzen. Für ein privates Repository empfiehlt sich ein SSH Deploy Key. Details stehen in `GITHUB-DEPLOY.md`.

## 2. Spätere Updates direkt von GitHub

Nach einem Push zu GitHub genügt auf dem VPS:

```bash
cd /opt/wardogs-status-panel && sudo ./update.sh
```

Das Update-Skript macht `git pull --ff-only` und baut/startet danach den Docker-Stack neu. `.env` und `data/` bleiben lokal auf dem VPS erhalten.

Das Setup fragt dich nach:

1. öffentlicher Panel-URL
2. Discord OAuth Client ID
3. Discord OAuth Client Secret
4. deiner Discord User ID

Secrets für Sessions und Verschlüsselung erzeugt das Skript automatisch.

---

# Panel per IP aufrufen

Beim Setup beispielsweise eingeben:

```text
http://203.0.113.10
```

Danach lautet der Panel-Aufruf:

```text
http://203.0.113.10
```

Discord OAuth Redirect URI:

```text
http://203.0.113.10/auth/discord/callback
```

Diese Redirect URI exakt im Discord Developer Portal eintragen.

**Hinweis:** Für ein dauerhaft öffentlich erreichbares Panel ist der Domain-Modus mit HTTPS deutlich empfehlenswerter.

---

# Panel per Domain + HTTPS aufrufen

Beispiel:

```text
https://bots.example.com
```

Vorher einen DNS `A`-Record setzen:

```text
bots.example.com -> DEINE_VPS_IP
```

Am VPS müssen TCP-Port **80 und 443** erreichbar sein. Caddy holt und erneuert das TLS-Zertifikat automatisch.

Discord OAuth Redirect URI:

```text
https://bots.example.com/auth/discord/callback
```

Diese URI exakt im Discord Developer Portal unter **OAuth2 -> Redirects** eintragen.

---

# Discord-Anwendung für den Panel-Login

Du brauchst eine Discord Application für den Login des Panels.

Im Discord Developer Portal:

1. Application erstellen/öffnen
2. **OAuth2** öffnen
3. unter **Redirects** die Callback-URL eintragen
4. Client ID und Client Secret beim Setup angeben

Das Panel fordert beim Login ausschließlich den Scope `identify` an.

Diese Login-Application ist unabhängig von den Status-Bots. Für jeden Gameserver, der als eigener Bot in Discord erscheinen soll, benötigst du einen regulären Discord Bot Token.

---

# Ersten Gameserver hinzufügen

Nach dem Discord-Login:

**Server hinzufügen** und eintragen:

- Anzeigename
- Discord Bot Token
- WARDOGS RCON URL, z. B. `http://10.0.0.5:7776`
- RCON Passwort
- RCON Update-Intervall
- Status-Wechselintervall
- Statuszeilen
- Offline-Text

Beispiel für die Statusrotation:

```text
{players}/{max} Spieler online
Map: {map}
```

Dann wechselt Discord beispielsweise zwischen:

```text
24/100 Spieler online
```

und:

```text
Map: Carentan
```

Unterstützte Platzhalter:

```text
{players}
{max}
{map}
{server}
```

---

# Docker-Verwaltung

Status:

```bash
docker compose ps
```

Logs des Panels und der Bots:

```bash
docker compose logs -f wardogs-panel
```

Caddy/HTTPS Logs:

```bash
docker compose logs -f caddy
```

Neustart:

```bash
docker compose restart wardogs-panel
```

Kompletten Stack neu bauen/starten:

```bash
docker compose up -d --build
```

Stoppen:

```bash
docker compose down
```

Die Bot-Konfiguration bleibt in `./data` erhalten.

---

# Diagnose

```bash
./doctor.sh
```

Das prüft u. a.:

- Docker
- Docker Compose
- `.env`
- PUBLIC_URL
- OAuth Client ID
- Admin-ID
- Compose-Konfiguration
- Containerstatus
- letzte Panel-Logs

---

# Backup

```bash
./backup.sh
```

Das sichert:

- `.env`
- `data/db.json`
- `data/sessions.json`

in `./backups/`.

**Wichtig:** `APP_ENCRYPTION_KEY` aus `.env` wird zum Entschlüsseln der gespeicherten Bot Tokens/RCON-Passwörter benötigt. Deshalb gehört `.env` unbedingt ins Backup, aber niemals öffentlich auf GitHub.

---

# Update

Neue Projektdateien über die vorhandenen kopieren, `.env` und `data/` behalten und anschließend:

```bash
./update.sh
```

---

# Firewall

Für Domain/HTTP(S)-Zugriff benötigt der VPS eingehend:

```text
TCP 80
TCP 443
UDP 443 optional (HTTP/3)
```

Port 3000 wird **nicht öffentlich veröffentlicht**. Er ist nur innerhalb des Docker-Netzwerks zwischen Caddy und dem Panel erreichbar.

Der VPS benötigt ausgehend Zugriff auf:

- Discord API/Gateway
- deine WARDOGS RCON-Adressen

---

# Verzeichnisstruktur

```text
wardogs-status-panel-v2.0/
├── Caddyfile
├── compose.yaml
├── Dockerfile
├── setup-vps.sh
├── doctor.sh
├── backup.sh
├── update.sh
├── .env.example
├── data/
├── public/
└── src/
```

---

# Sicherheit

- Login ausschließlich per Discord OAuth2
- Login-CSRF-Schutz über OAuth `state`
- Formular-CSRF-Schutz
- Login-/Request-Rate-Limits
- HTTP Security Header via Helmet
- Bot Tokens/RCON-Passwörter AES-256-GCM verschlüsselt
- `.env` wird mit Dateirechten `600` erstellt
- Datenverzeichnis wird mit restriktiven Rechten angelegt
- Status-Bots sind normale Discord Bot Accounts, keine Self-Bots
- bei Domain-Nutzung HTTPS via Caddy

