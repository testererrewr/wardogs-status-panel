# Update v3.11.8

Custom-Bot Admin Controls und vollständiger WARDOGS Managed Bot Service.

## Custom Bots

- Admins können Custom Bots im Admin-Panel zentral steuern.
- Controls: **Start / Rebuild + Restart**, **Stop**, **Approve / Revoke**, **Logs**, **Source** und **Delete**.

## WARDOGS Warning & Management Bot

- Eigener gehosteter Managed-Bot-Service im Panel.
- Standardpreis: **€3.99 / month**.
- Eigenes PayPal-Produkt und eigener PayPal-Monatsplan pro Bot-Service; unabhängig von Premium-/Status-Bot-Abos.
- Admin-Accounts können ihren eigenen Service kostenlos freischalten.
- Konfiguration im Panel: Discord Bot Token, Alert Channel, Rollen-Ping, WARDOGS API/RCON URL + Passwort, Prüfintervall und Regeln.
- Regeltypen: `steam:SteamID64`, `name:Text`, `faction:Text`, `ping>150` / `ping>=150`.
- Discord-Warnungen bei Regel-Treffern enthalten **Ban**, **Kick** und **Steam Profile**.
- Ban/Kick aus Discord erfordern die entsprechende Discord-Moderationsberechtigung des klickenden Users.
- Optionaler Auto-Ban bei Regel-Treffern. **Auto-Ban ist standardmäßig AUS** und wird nur durch bewusstes Aktivieren im Panel eingeschaltet.
- Bot-Service-Runtime wird automatisch gestartet/gestoppt, wenn Konfiguration oder bezahlter Zugriff sich ändern.
- Pending PayPal Bot-Service-Abos können direkt im Managed-Service-Bereich abgebrochen werden.

## Datenbank

- Datenbankversion **17**.
- Bestehender `wardogs-warning-bot` wird migriert, ohne einen zweiten Service anzulegen.
- Neue Datensätze für Managed-Bot-Instanzen und separate PayPal Bot-Service-Abonnements.
