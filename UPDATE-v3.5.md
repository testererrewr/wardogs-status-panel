# Update auf v3.5

1. Inhalt der v3.5 ZIP in dein bestehendes GitHub-Repository hochladen und committen.
2. Auf dem VPS:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

3. Prüfen:

```bash
docker compose ps
```

Falls nur `docker-compose` verfügbar ist:

```bash
docker-compose ps
```

## Neu

- Node Manager: neue Bots sperren, Disable, Drain, Einzel-Move und Move-All
- Free-Boost über einen sichtbaren Top-Channel `Powered by status-hub.lol`, bis zu 5 Gratis-Bots nach Servergröße
- `Get more` Seite mit manueller Verifizierung und Support-Link
- Donations-Seite und öffentliche Supporter-Liste
- Deutsch/Englisch Umschalter
- Text-only Status Bots mit frei rotierenden Texten; zählen im selben Status-Bot-Limit
- Premium 5/10/15/20 und zeitliche Freischaltung bleiben getrennt von Custom-Bot-Rechten

Die bestehende `PUBLIC_URL` wird nicht automatisch auf `status-hub.lol` geändert.
