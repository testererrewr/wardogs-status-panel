# Update auf v3.1

v3.1 ist datenbankkompatibel zu v3.0. Bestehende Benutzer, Status-Bots, Tokens und Custom Bots bleiben erhalten.

Neu:

- durchsuchbare GameDig-Spielauswahl
- Standard-/Query-Port aus der installierten GameDig-Spieledefinition
- `/games` Seite mit Suche, Features, Ports, Protokollen und FAQ
- spezielle GameDig-Felder für ausgewählte Spiele mit zusätzlichen Anforderungen
- GameDig-Secrets weiterhin verschlüsselt gespeichert
- `update.sh` ignoriert reine Git-Dateirechte (`core.fileMode=false`), damit ein früheres `chmod +x *.sh` Updates nicht mehr blockiert

Nach dem Commit auf GitHub auf dem VPS:

```bash
cd /opt/wardogs-status-panel
bash ./update.sh
```

Falls dein Clone anders heißt, entsprechend in dessen Ordner wechseln.
