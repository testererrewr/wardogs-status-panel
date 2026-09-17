# Update v3.11.5

Custom-Bot-Upload wurde gehärtet und auf typische ZIP-Projekte getestet.

- ZIP-Pfade werden kanonisch geprüft; absolute Pfade, Windows-Laufwerkspfade und `..` werden abgelehnt.
- Doppelte Dateipfade im ZIP werden abgelehnt statt still überschrieben.
- Die entpackte Gesamtgröße wird bereits vor dem Entpacken anhand der ZIP-Metadaten auf 100 MB geprüft.
- Ein automatisch erkannter äußerer Projektordner funktioniert jetzt auch, wenn der Benutzer den Entrypoint inklusive dieses Ordners eingibt.
- Node-Entrypoints können zusätzlich aus `package.json` (`main` oder einfachem `npm start`/`node ...`) erkannt werden.
- Weitere übliche Entrypoints wie `run.py`, `server.js`, `.mjs` und `.cjs` werden erkannt.
- Beschädigte ZIP-Dateien und Lesefehler liefern verständlichere Fehlermeldungen und hinterlassen keine halbfertigen Upload-Verzeichnisse.
- Multipart-Uploads haben feste Feld-/Teil-Limits und ein eigenes Fehlerhandling; Uploadfehler landen wieder sauber im Formular.
- Admin-Freigabe bzw. manueller Start setzt `enabled` bei Build-/Startfehlern wieder auf `false`, damit kein falscher Aktiv-Status gespeichert bleibt.
- Generierte Docker-CMDs werden als JSON erzeugt; Python-Container verwenden `python -m pip` sowie unbuffered output.
