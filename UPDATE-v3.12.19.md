# Update v3.12.19 — Welcome reliability, JOIN Seeding & multi-server playtime

## WARDOGS Management Bot
- Added optional/managed **JOIN Seeding** Discord nickname suffix. The suffix is appended **after the configured bot name** only while 1–20 players are online.
- At 0 players or 21+ players the suffix is removed and the configured bot name is restored.
- Existing WARDOGS management bots migrate with JOIN Seeding enabled; it remains configurable in the web panel.
- Join welcome whispers now use a dedicated 5-second join watcher, separate from detection-rule polling.
- Current players at bot startup are only used as a baseline and do not receive a late welcome.
- A confirmed new join is queued until a faction is present; WARDOGS player-message readiness errors are retried for up to two minutes.
- A welcome is marked delivered only after a successful `POST /v1/players/{steamId}/message` response.

## WARDOGS Playtime Tracker
- One tracker instance can monitor up to 12 WARDOGS servers simultaneously.
- Every tracked server has its own label, URL and encrypted RCON/API password.
- Existing single-server trackers migrate automatically without losing playtime history.
- Added player search by player name or Steam64ID. Results show combined playtime, session count, last activity and a per-server playtime breakdown.
- Dashboard adds a per-server overview while Top 25 and total playtime remain aggregated across the tracker instance.
- Config export includes server labels/URLs but continues to exclude passwords/secrets.

## Migration
Database schema upgrades automatically from 28 to 29. Existing PayPal service/product/plan identifiers are preserved.
