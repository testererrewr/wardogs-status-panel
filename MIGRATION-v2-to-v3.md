# Upgrade vom bisherigen WARDOGS Panel v2.x

Die bestehende Datenbank wird automatisch migriert. Alte WARDOGS-Einträge bleiben erhalten und werden dem ersten Account aus `ADMIN_DISCORD_IDS` zugeordnet.

## 1. Neue Dateien nach GitHub pushen

Ersetze den Repository-Inhalt durch diese v3-Dateien. `.env`, `data/` und `custom-bots/` nicht hochladen.

## 2. VPS aktualisieren

Im bestehenden Clone:

```bash
cd /opt/wardogs-status-panel
./update.sh
```

`update.sh` erledigt automatisch:

- `git pull --ff-only`
- ergänzt fehlende Runner-Konfiguration in der bestehenden `.env`
- deaktiviert das alte `compose.override.yaml` aus dem früheren Port-3000-Fix
- setzt `data/` und `custom-bots/` auf UID/GID `1000:1000`
- baut Panel + sicheren Custom-Bot-Runner neu
- entfernt alte Compose-Orphans

Danach:

```bash
docker compose ps
```

bzw. auf Systemen mit altem Compose-Befehl:

```bash
docker-compose ps
```

Deine bisherige `PUBLIC_URL` und Discord OAuth-Konfiguration bleiben erhalten.
