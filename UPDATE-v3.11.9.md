# Update v3.11.9

WARDOGS Warning & Management Bot: Ausbau zum Live-Server-Management.

## Live-Spielerliste

- Aktuelle Spieler mit Name, SteamID64, Fraktion, Kills/Deaths, Cash und Ping.
- Direkte Aktionen: **Whisper**, **Kick**, **Ban**, **Kill/Respawn**, **Teamwechsel** und **Steam-Profil**.
- Spieleraktionen laufen direkt über die gespeicherte WARDOGS-RCON-Verbindung.

## Server-Announcements

- Manuelle In-Game-Broadcasts aus dem Panel.
- Optional rotierende automatische Announcements mit frei wählbarem Intervall.
- Automatische Announcements sind bei bestehenden und neuen Bots **standardmäßig AUS**.
- Maximal 50 Nachrichten, jeweils maximal 200 Zeichen.

## Server Management

- Live-Status, Spielerzahl, Health/Uptime und RCON-Build.
- Banliste inklusive manuellem Ban und Unban.
- Match neu starten / Match beenden.
- Mapwechsel mit optionalen Experiences, Lighting und Zone Alternator.
- Lighting direkt ändern.
- Rotation wird im Panel angezeigt.
- WARDOGS Audit Log kann eingesehen werden.
- Join Code / Server-ID wird angezeigt, wenn der Build `/v1/server-id` unterstützt.
- Reserved Slots werden angezeigt; direkte Add/Remove-Controls erscheinen nur bei Builds, die diese Routen wirklich anbieten.
- Capability-Erkennung blendet optionale Player-Aktionen aus, wenn der verbundene Server sie nicht anbietet.

## Datenbank

- Datenbankversion **18**.
- Neue Managed-Bot-Felder für geplante Announcements werden automatisch migriert.
- Bestehende Bots behalten Auto-Ban und automatische Announcements auf ihrem bisherigen Zustand; automatische Announcements werden nicht ungefragt aktiviert.
