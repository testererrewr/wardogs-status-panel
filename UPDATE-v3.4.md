# Update auf v3.4

1. Inhalt der v3.4 ZIP in dein bestehendes GitHub-Repository hochladen und committen.
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

Falls dein System nur `docker-compose` kennt:

```bash
docker-compose ps
```

## Nach dem Update

Im Panel als Admin öffnen:

- `Node Manager`: Nodes sperren, drainen und Bots verschieben
- `Einstellungen`: `status-hub.lol`, Support-Link, Donations, Free-Boost-Stufen und Supporter verwalten
- `Benutzer`: Premium-Laufzeiten und Custom-Bot-Limits verwalten

Die bestehende `PUBLIC_URL` bleibt unverändert. Für die spätere Domain-Umstellung erst DNS/HTTPS einrichten und anschließend `PUBLIC_URL` sowie den Discord OAuth Redirect ändern.
