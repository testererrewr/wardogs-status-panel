# Update auf v3.8

Bestehende `.env`, Datenbank, Bots und Node-Tokens bleiben erhalten.

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Danach prüfen:

```bash
docker compose ps
docker compose logs --tail=80 server-status-hub
docker compose logs --tail=80 status-node
docker compose logs --tail=80 runner
```

Im Admin Control Center unter `/admin?tab=settings` können Premium-Preise, PayPal, Discord-Kaufkontakt und Free-Boost-Stufen gepflegt werden.
