# Update auf v3.7

1. Inhalt der v3.7 ZIP in das bestehende GitHub Repository hochladen und committen.
2. Auf dem VPS:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Danach:

```bash
docker compose ps
```

Neu:

- `/bot-services` öffentliche Bot-Services-Seite
- `/admin/bot-services` Verwaltung der Angebote
- WARDOGS Warning Bot als vorbereiteter Coming-Soon-Eintrag

Bestehende Daten, `.env`, Benutzer, Status Bots, Premium-Pläne und Custom Bots bleiben erhalten.
