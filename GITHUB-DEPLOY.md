# GitHub → Debian VPS Deployment

Dieses Repository ist so vorbereitet, dass **keine ZIP-Datei mehr auf den VPS kopiert werden muss**.

## 1. Repository auf GitHub anlegen

Auf GitHub ein neues Repository erstellen, z. B.:

```text
wardogs-status-panel
```

Den Inhalt dieses Projektordners in das Repository hochladen. Wichtig: **niemals `.env`, `data/db.json`, Backups oder echte Tokens committen**. Diese Dateien sind bereits durch `.gitignore` ausgeschlossen.

## 2. Erstinstallation auf dem VPS

### Öffentliches GitHub-Repository

Auf einem frischen Debian-VPS reicht anschließend:

```bash
sudo apt-get update && sudo apt-get install -y git && sudo git clone https://github.com/DEINNAME/wardogs-status-panel.git /opt/wardogs-status-panel && cd /opt/wardogs-status-panel && sudo ./setup-vps.sh
```

`DEINNAME` durch deinen GitHub-Benutzernamen bzw. deine Organisation ersetzen.

### Privates Repository

Für private Repositories am besten einen SSH Deploy Key verwenden und dann über SSH klonen:

```bash
git clone git@github.com:DEINNAME/wardogs-status-panel.git /opt/wardogs-status-panel
```

Danach:

```bash
cd /opt/wardogs-status-panel
sudo ./setup-vps.sh
```

## 3. Spätere Updates

Wenn du Änderungen zu GitHub gepusht hast, auf dem VPS nur noch:

```bash
cd /opt/wardogs-status-panel && sudo ./update.sh
```

`update.sh` führt automatisch aus:

1. `git pull --ff-only`
2. Docker Images aktualisieren
3. Panel neu bauen
4. Container neu starten

Die lokale `.env` und der Ordner `data/` bleiben dabei erhalten und werden **nicht** aus GitHub überschrieben.

## 4. Status prüfen

```bash
cd /opt/wardogs-status-panel
sudo ./doctor.sh
```

Logs:

```bash
docker compose logs -f wardogs-panel
```

## 5. Backup vor größeren Änderungen

```bash
cd /opt/wardogs-status-panel
sudo ./backup.sh
```

Wichtig: Das Backup enthält auch Material, das zum Entschlüsseln der gespeicherten Bot-/RCON-Secrets notwendig ist. Sicher verwahren.
