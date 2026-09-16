# Update auf v3.6

Dateien auf GitHub aktualisieren und danach auf dem VPS:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Neu:

- öffentliche Team-Seite `/team`
- erster `.env`-Admin als Founder & Administrator
- weitere Admins automatisch auf der Team-Seite
- `293104788361576448` standardmäßig als Team Member
- zusätzliche Team-IDs unter Admin > Einstellungen

Bestehende `.env`, Daten, Bots und Freischaltungen bleiben erhalten.
