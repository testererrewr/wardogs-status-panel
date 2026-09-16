# GitHub + Debian Deployment v3.6

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

## Spätere Domain status-hub.lol

Solange DNS/HTTPS noch nicht eingerichtet ist, bleibt `PUBLIC_URL` auf der aktuellen IP/Domain. Die Branding-Domain kann unabhängig davon bereits `status-hub.lol` sein.
