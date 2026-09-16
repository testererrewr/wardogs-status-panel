# GitHub + Debian Deployment v3.9

## Repository aktualisieren

Die ZIP entpacken und den gesamten Inhalt über GitHub `Add file -> Upload files` in das bestehende Repository hochladen. Danach committen.

Nicht hochladen:

```text
.env
data/
custom-bots/
```

## VPS aktualisieren

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

## Neuen Status Node installieren

Den fertigen Einzeiler im Adminbereich unter `Node Manager` verwenden. Für Remote Nodes sollte die Control Plane über HTTPS erreichbar sein.

## Domain

Produktiv wird `PUBLIC_URL=https://status-hub.lol` verwendet. Discord OAuth nutzt `https://status-hub.lol/auth/discord/callback`. PayPal Webhooks nutzen `https://status-hub.lol/webhooks/paypal`.
