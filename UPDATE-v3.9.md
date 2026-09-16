# Update auf v3.9

## GitHub

ZIP entpacken, den gesamten Inhalt in das bestehende Repository hochladen und committen. `.env`, `data/` und `custom-bots/` nicht hochladen.

## VPS

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

## PayPal API Zugangsdaten

```bash
cd /opt/wardogs-status-panel
bash ./setup-paypal.sh
```

Für Produktion `live` wählen. Danach im Adminbereich unter `Settings -> Premium & PayPal` Preise, Währung und Laufzeit setzen und `PayPal automatisch einrichten / testen` drücken.

Der Webhook wird automatisch auf diese URL registriert:

```text
https://status-hub.lol/webhooks/paypal
```

Nach erfolgreicher PayPal-Zahlung wird Premium automatisch aktiviert.
