# Update auf v3.2

v3.2 fügt Premium-Pläne, Free-Branding und das Multi-VPS Status-Node-System hinzu.

## 1. Neue Dateien nach GitHub hochladen

Den Inhalt der v3.2 ZIP über das bestehende Repository hochladen und committen. `.env` und `data/` niemals hochladen.

## 2. VPS aktualisieren

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git restore backup.sh bootstrap.sh doctor.sh setup-vps.sh start.sh update.sh 2>/dev/null || true
git pull --ff-only
bash ./update.sh
```

`update.sh` ergänzt bei einer alten `.env` automatisch:

- `STATUS_NODE_JOIN_SECRET`
- `LOCAL_STATUS_NODE_MAX_BOTS=50`
- Node Lease/Heartbeat-Werte
- `STATUS_NODE_MIN_FREE_MB=150`
- `SERVICE_DOMAIN` aus der bisherigen `PUBLIC_URL`
- `NODE_INSTALL_SCRIPT_URL`

Danach startet zusätzlich der Service `status-node` auf dem Haupt-VPS.

## 3. Prüfen

```bash
docker compose ps
bash ./doctor.sh
```

Im Adminpanel sollte der Menüpunkt **Status Nodes** erscheinen und `Main VPS` nach wenigen Sekunden `online` sein.

## 4. Service-Domain festlegen

Für Free-Branding am besten eine echte Domain setzen:

```bash
nano /opt/wardogs-status-panel/.env
```

```env
SERVICE_DOMAIN=status.deinedomain.tld
```

Danach:

```bash
docker compose up -d --force-recreate server-status-hub status-node
```

## 5. Remote Worker

Für zusätzliche VPS zuerst die Control Plane über HTTPS bereitstellen. Danach im Adminpanel **Status Nodes** den automatisch generierten Einzeiler kopieren und auf dem neuen Debian-VPS als root ausführen.
