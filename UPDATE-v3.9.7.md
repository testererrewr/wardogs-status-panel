# Update v3.9.7

- PayPal Sandbox Buy-Flow funktioniert mit aktivierter PayPal-API auch vor erfolgreicher Webhook-Anlage.
- Status-Bot Restart validiert den Token und aktiviert den Bot.
- Node Manager: alle aktiven Bots eines Nodes gesammelt neu starten.

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```
