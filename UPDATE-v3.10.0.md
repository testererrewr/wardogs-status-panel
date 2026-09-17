# Update v3.10.0

## Neu

- Premium-Ablauf: genau ein Status-Bot bleibt online, weitere Bots werden 7 Tage pausiert. Wird Premium innerhalb dieser Frist reaktiviert, kommen die pausierten Bots automatisch zurück. Danach werden die überzähligen Status-Bots gelöscht.
- Free-Renew: Free-Accounts müssen alle 14 Tage im Account-Dashboard verlängern. Ohne Verlängerung werden Status-Bots 7 Tage pausiert und danach gelöscht.
- Admin kann pro Benutzer `Kein 14-Tage-Renew` aktivieren.
- Benutzer können Status-Bots manuell offline schalten und wieder starten.
- Donate ist nur noch im Footer.
- Cookie-Consent mit notwendigen/optionalen Kategorien, Ablehnen/Akzeptieren und jederzeit änderbaren Einstellungen.
- WARDOGS: optionaler `Seeding`-Status ab mindestens einem Spieler online.

## Update

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Danach einmal `Strg+F5`.
