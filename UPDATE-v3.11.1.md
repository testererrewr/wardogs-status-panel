# Update v3.11.1

- Footer bleibt bei kurzen Seiten am unteren Fensterrand.
- Free-Accounts zeigen unter Your Account nicht mehr "Permanent" bei Premium an, sondern "Nicht aktiv".
- PayPal Subscription setup zeigt jetzt Disabled / No monthly prices / Not fully set up / Ready mit Plan-Anzahl.
- PayPal Setup verlangt bei aktivierten Monatsabos mindestens einen Monatspreis und meldet den tatsächlichen Setup-Status.

Update:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```
