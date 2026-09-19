# status-hub.lol v3.12.42









## v3.12.42

- WARDOGS Status Bot kann alle gespeicherten Spieler-, Playtime- und Kill-Statistiken als Word-Dokument (`.docx`) exportieren.
- Der Export funktioniert unabhängig vom Bot-Runtime-Status direkt aus den persistent gespeicherten Panel-Daten.

## v3.12.41 – Dynamic Name im WARDOGS Management Bot

Der Management Bot kann den echten WARDOGS-Servernamen jetzt optional dynamisch verwalten. Alle Teilfunktionen sind separat schaltbar: Score-/Stats-Format mit Platzhaltern, ein Seeding-Name für einen frei wählbaren Spielerbereich und eine Rotation zwischen zwei Namen alle X Minuten. Seeding hat Vorrang vor der Stats-Anzeige; die 2-Namen-Rotation kann als Basisname für die Stats dienen. Beim Abschalten des Features oder Stoppen des Management Bots wird der zuvor gespeicherte Originalname wiederhergestellt.

Unterstützte Platzhalter sind unter anderem `{base}`, `{players}`, `{max}`, `{map}`, `{scores}`, `{team1}` bis `{team6}` und `{score1}` bis `{score6}`. Beispiel: `{base} | {score1} | {score2} | {score3}`. Die Änderung erfolgt über das WARDOGS Config-Dokument. Wenn der Hoster `ServerName` per Startparameter fest pinnt, zeigt das Panel stattdessen einen Dynamic-Name-Fehler an.

## v3.12.40 – echte Join-Sessions + robuster Ban-Sync

- Welcome-Whisper wird nicht mehr durch Matchende, Mapwechsel oder einen neuen Matchstart erneut ausgelöst. Bereits verbundene Spieler werden über WARDOGS-Roster-Resets hinweg als dieselbe Session behandelt.
- Matchgrenzen werden anhand von Map/Rotation/Experience/Alternator und zurückgesetzten Faction-Scores erkannt. Zusätzlich bekommt ein komplett leeres `/v1/players`-Roster beim Welcome-Watcher eine längere Grace-Phase, weil WARDOGS die Liste während Matchwechseln kurz neu aufbaut.
- Ein echter Leave + späterer Rejoin bleibt weiterhin ein neuer Join und erzeugt wieder genau einen Welcome-Whisper.
- Ban-Sync behandelt `404 no player matching ...` nicht mehr als defekten Sync: aktuelle WARDOGS-Live-Builds können einen normalen Ban nur anlegen, solange der Spieler auf diesem Zielserver verbunden ist. Solche Einträge bleiben jetzt als **pending** in der Community und werden beim nächsten Join automatisch angewendet.
- `Jetzt synchronisieren` räumt außerdem veraltete Community-Bans auf, wenn der ursprüngliche Quell-Bot den Ban nicht mehr führt, und zeigt getrennt `bereits synchron`, `pending`, `veraltete entfernt` und echte Fehler.

## v3.12.39 – Killfeed nur im Bot-Service WARDOGS Status Bot

- Der bisher sichtbare **WARDOGS Playtime Tracker** heißt jetzt konsequent **WARDOGS Status Bot**. Bestehende Standardnamen werden bei der Datenbankmigration automatisch umbenannt.
- Der WARDOGS Status Bot behält seine Multi-Server-Playtime-Funktionen und bekommt die Killfeed-/Stats-Funktionen direkt in dieselbe Bot-Service-Instanz.
- In den Bot-Einstellungen hat **jeder eingetragene WARDOGS Server** eine eigene Discord Killfeed Channel ID und einen eigenen `Kill Feed konfigurieren`-Button.
- Pro Gameserver bleibt genau **eine feste Discord-Killfeed-Nachricht** bestehen; sie wird in-place aktualisiert und zeigt die letzten **15 Kills dieses Servers**.
- Kill-Statistiken werden innerhalb der Bot-Instanz **global über alle eingebundenen WARDOGS Server** per Steam64ID zusammengezählt.
- Discord-Killfeed-Panels haben `Search player` und `Top kills`; die Suche arbeitet global nach Name, Alias oder Steam64ID, auch für offline Spieler.
- Das Webpanel zeigt globale Kill-Top-25 und Spielersuche sowie pro Server einen Moderations-Killfeed mit den letzten **150 Events**, Distanz, Ursache/Waffe, Map und Kill-Tags.
- Server-Feed-Tokens, Event-Verlauf und Discord-Message-IDs werden pro Server gespeichert. Ein Bot-Neustart erzeugt daher keine neuen Killfeed-Nachrichten.
- Bestehende v3.12.37 Playtime-Tracker-Konfigurationen werden auf Schema 37 migriert; passende bereits vorhandene WARDOGS-Feed-Daten können übernommen werden.

## v3.12.37 – WARDOGS Status Bot: Status + per-server Killfeed + globale Stats

- Der separate **WARDOGS Killfeed & Stats Bot** wurde in den bestehenden **WARDOGS Status Bot** integriert; im öffentlichen Bot-Service-Katalog wird der separate 0,99-€-Service nicht mehr angeboten.
- Jeder WARDOGS Status Bot / Gameserver kann einen eigenen Discord-Killfeed-Channel bekommen. Pro Server bleibt genau **eine feste Killfeed-Nachricht** im Channel und zeigt die letzten 15 Kills dieses Servers.
- Mehrere WARDOGS Server desselben Accounts werden parallel getrackt. Die **Spielerstatistiken sind accountweit global** und summieren Kills/Tode/Headshots/Kill-Ursachen usw. über alle getrackten WARDOGS Status Bots dieses Accounts.
- Discord `Spieler suchen` und `Top Kills` verwenden die globalen Account-Stats, während der sichtbare Killfeed serverbezogen bleibt. Die Suche funktioniert nach Name, Alias und Steam64ID, auch für offline Spieler.
- Neues Webpanel `Killfeed & Stats` pro WARDOGS Status Bot: globale Top 25 + globale Spielersuche sowie die letzten 150 Kills genau dieses Gameservers mit Killer/Victim SteamIDs, Ursache/Waffe, Distanz, Map und Kontext-Tags.
- Der WARDOGS Server Feed wird direkt in den Status-Bot-Einstellungen konfiguriert. Nach `Kill Feed konfigurieren` ist einmal ein Gameserver-Neustart nötig.
- Der Management Bot erhält weiterhin denselben Feed für seinen 150-Event-Moderationsverlauf, auch wenn der Feed über den Status Bot eingerichtet wurde.
- Bereits vorhandene v3.12.36 Killfeed-&-Stats-Daten werden bei passendem Owner + WARDOGS-Serverziel automatisch in den Status Bot übernommen; der alte Service wird danach für neue Käufe ausgeblendet.
- Feste Discord-Killfeed-Message-IDs werden vom Status Node an die Control Plane zurückgespeichert, damit ein Bot-Neustart keine zweite Killfeed-Nachricht erzeugt.
- Database schema version 36.

## v3.12.36 – WARDOGS Killfeed & Stats Bot

- Neuer separater Bot-Service **WARDOGS Killfeed & Stats Bot** für **€0,99 / Monat**.
- Nutzt den offiziellen WARDOGS `WDServerFeed` Push-Feed (`POST /api/ingest/events`) statt Kill-Daten zu erraten.
- Discord-Killfeed bleibt als **eine feste Nachricht** im Channel und wird in-place aktualisiert; angezeigt werden die letzten 15 Kills.
- Persistente All-Time-Statistiken über alle ab Aktivierung getrackten Matches: Kills, Tode, K/D, Headshots, längster Kill, Suicide/Environment sowie Kill-Ursachen.
- Erfasst Distanz und Kontext-Tags wie Headshot, Penetration, Ricochet, Melee, Vehicle Explosion, Roadkill, Falling und Suicide.
- Spieler-Suche nach Name/Steam64ID im **Webpanel** und direkt im **Discord-Panel** per Search-Button/Modal; auch offline Spieler bleiben auffindbar.
- Management Bot erhält einen eigenen Moderations-Killfeed mit den letzten **150** Kills/Toden inkl. SteamIDs, Distanz, Ursache, Map und Tags.
- `Server Feed konfigurieren` schreibt `Url` + Token in `[WDServerFeed]`; WARDOGS lädt diese Einstellung erst nach einem Gameserver-Neustart.
- Mehrere Service-Bots am selben WARDOGS Ziel teilen denselben eingehenden Feed intern, sodass Management und Stats parallel tracken können.
- Assists und Revives werden nicht erfunden: die aktuelle WARDOGS Feed/API-Dokumentation liefert dafür keine auswertbaren Events.
- Database schema version 35.

## v3.12.35 – Ban Sync Community policy

- Renames the visible **Ban Sync Server Browser** to **Community Browser** / **Ban Sync Community**.
- Unbans are synchronized across every connected community member, including automatic expiry of temporary and Dynamic Bans.
- Dynamic Ban policy is now community-wide: the community owner controls Dynamic Ban on/off, the rejoin escalation threshold and the escalation window.
- Every member automatically inherits the owner policy on join, resync and whenever the owner saves new values. Non-owner members see the settings read-only while connected.
- Existing v3.12.34 communities inherit the current owner's Dynamic Ban settings during schema migration and propagate them to all members.
- Database schema version 34.

## v3.12.34 – Multi-server Ban Sync rooms + Management Bot naming

- Replaces the old one-to-one BOT-ID Ban Sync UI with password-protected **Ban Sync Servers**.
- A Ban Sync Server can contain up to 100 WARDOGS Management Bots / game servers.
- Users can browse available Ban Sync Servers, create one with a password, or join one with its password.
- Existing bans are merged when a room is created/joined; future permanent, temporary and Dynamic Bans as well as unbans are mirrored to all room members.
- Temporary and Dynamic Bans preserve the original expiry time across every member and are never extended by syncing.
- Leaving a room stops future synchronization but intentionally leaves already-applied bans local on that game server.
- Ban Sync Server passwords are stored as salted scrypt hashes; plaintext passwords are never stored or displayed.
- The old directional BOT-ID sync is retired during migration so no hidden legacy link remains active.
- The visible service name is now consistently **WARDOGS Management Bot**. Existing default names such as `WARDOGS Warning & Management Bot #2` are migrated automatically.
- Database schema version 33.

## v3.12.33 – Custom Bot `.env` file uploads

- Custom Bot file-browser uploads now allow `.env` and `.env.*` files, both as loose files and inside ZIP overlays. Existing files with the same path are overwritten like any other project file.
- Generated Custom Bot Docker build contexts no longer exclude `.env`, so bots that explicitly load a local `.env` file receive it after **Start/rebuild**.
- `.env` files are included in the bot source/file browser just like other project files. Only the bot owner and panel administrators can manage/download that bot source.
- Other sensitive credential files such as SSH private keys, `.npmrc`, `.pypirc`, `.netrc` and `credentials.json` remain blocked, as do path traversal, dependency/cache folders and oversized uploads.

## v3.12.32 – Dynamic Ban player message

- Dynamic Ban remains an internal enforcement mode and is no longer exposed to players in the kick reason.
- The initial Dynamic Ban kick now uses the same formatted temporary-ban message as a normal ban: remaining duration, configured reason, and optional Discord invite.
- Every later rejoin kick also uses that normal ban format with the current remaining time. The original Dynamic Ban expiry and escalation logic are unchanged.

## v3.12.31 – Ban Sync BOT ID visibility

- The current management bot's own **BOT ID** is now shown directly above the Ban Sync target field.
- The field is read-only and can be clicked to select the full ID for easy copying into another bot's Ban Sync target.


## v3.12.30 – Ban Sync, Dynamic Bans, Audit Log & Custom Bot Files

- **Ban Sync:** a WARDOGS Management Bot can be configured with the target BOT ID that should receive its bans. The target owner gets an incoming request in the panel and must explicitly accept it before existing/new bans are mirrored. Disconnecting or changing the target removes the tracked mirrored bans from the old target.
- **Dynamic Ban:** optional temporary-ban mode that avoids a game ban at first. A blocked player is kicked again on every new join for the configured duration. After a configurable number of joins inside a configurable time window, it escalates to a normal WARDOGS ban, but that escalation is still removed at the original Dynamic Ban expiry and never extends the selected duration.
- Dynamic Ban expiry cleanup also runs while the Discord management bot is stopped, so an escalated game ban is not intentionally left behind beyond its configured timer.
- **Audit Log:** per-management-bot audit history for bans/unbans, Dynamic Ban enforcement, Ban Sync, whispers, broadcasts, team/map/lighting/match actions, detection ignore changes and bot/config actions. The latest 500 entries are retained.
- **Explicit Discord panel permissions:** bot ownership and ordinary Discord Kick/Ban permissions no longer grant management-panel access automatically. Non-administrators must be explicitly added as a Discord user or role grant in the bot settings; Discord guild Administrators keep their admin bypass.
- **Custom Bot file browser:** every Custom Bot now has a Files view with individual-file downloads plus loose-file and ZIP overlay uploads. Matching project paths are overwritten, new files are added, and unrelated existing files remain untouched. `source.zip` and the generated runtime files are rebuilt after changes.
- Custom Bot file uploads reject path traversal, secret files, dependency/cache folders and oversized projects. Source changes by a non-admin stop the bot and reset approval to pending so an approved bot cannot bypass the review process by changing code afterward.
- Database schema version 32.

## v3.12.29 – Minute-based temporary bans

- Temporary bans can now be entered directly in **minutes**, e.g. 5, 30 or 90 minutes.
- Minute selection is available in the web BAN dialog, ban templates, temporary-ban detection rules and the Discord management panel.
- Existing hour/day/permanent durations remain supported. Stored durations are still persisted internally as exact minutes, so automatic unban timing stays precise.
- Non-whole-hour durations such as 90 minutes are now shown/editable as minutes instead of a decimal hour value.

## v3.12.28 – Welcome only after real team selection / spawn

- Welcome whispers no longer treat any non-empty faction string as proof that the player selected a team.
- The watcher now validates the player faction against the real faction catalog from `/v1/status.factionScores`.
- A welcome requires an observed post-join team-selection transition: menu/unassigned → real faction, or a real faction change after join. A faction already present in the first join snapshot does not trigger the message by itself.
- The selected faction must remain stable for two watcher polls, followed by a 5-second spawn settle before the private whisper is sent.
- Welcome polling runs every 2 seconds so the menu → team transition is much less likely to be missed.
- Seeding / `Waiting for Players` is still supported; match state is intentionally not used as a gate.
- Expanded placeholder-faction filtering and regression tests for premature welcome delivery.

## v3.12.27 – WARDOGS request-body transport fix

- Fixed HTTP 501 `The request could not be parsed.` on WARDOGS actions that send a body.
- Hardened HTTP transport now sends an explicit byte-accurate `Content-Length` instead of implicit `Transfer-Encoding: chunked`.
- This central fix covers welcome/manual/faction whispers, broadcast, lighting, map/settings actions, bans, faction moves and config writes.
- Added regression tests that emulate a WARDOGS-like listener rejecting chunked JSON/text bodies.


## v3.12.21 – Save/Origin fix & management cleanup

- Fixed legitimate HTTPS form saves behind Caddy/reverse proxies being rejected as `Ungültige Request-Origin.` while keeping CSRF and same-host checks enabled.
- Removed the WARDOGS Management Bot `JOIN Seeding` server-name feature from runtime, settings, config import/export and the public feature list.
- Existing v3.12.20 bots perform a one-time cleanup of a leftover `JOIN Seeding` suffix on next start.
- Fixed custom bots going offline after the security hardening when their runtime needs writable cache/state files; existing read-only custom-bot containers are migrated automatically.

- Join welcome whispers now use a dedicated 5-second join/spawn watcher instead of relying on the slower detection poll. Existing online players remain baseline-only; a real leave/rejoin gets one fresh welcome.
- Spawn-ready welcome delivery retries clear WARDOGS readiness errors for up to two minutes and only marks a welcome complete after a successful whisper response.
- WARDOGS Playtime Tracker: one tracker instance can monitor up to 12 WARDOGS servers at once, each with its own encrypted RCON password.
- Playtime dashboard adds per-server stats plus player search by name or Steam64ID with total playtime, sessions, last activity and a server-by-server breakdown.
- Legacy single-server tracker data migrates automatically into the first tracker server.
- Database schema version 29.

## v3.12.18 – Security hardening

- Layered request/write/OAuth/upload rate limiting and HTTP anti-Slowloris timeouts.
- Browser hardening with CSP, HSTS on HTTPS, privacy headers and no-store responses for dynamic panel pages.
- Full local DB and session files encrypted at rest with `APP_ENCRYPTION_KEY`.
- Custom-bot ZIPs reject common secret files; custom-bot logs redact configured ENV secrets and common credential patterns.
- Main panel, status node and runner containers use read-only root filesystems, dropped capabilities, `no-new-privileges` and PID limits.
- Backups, `.env`, database and custom-bot files use stricter filesystem permissions.
- Included `SECURITY.md` and `security-check.sh` for production hardening checks.
- Application-level protection does not replace upstream/provider DDoS mitigation for volumetric attacks.

## v3.12.17 – Service feature-list cleanup

- Removed the redundant “redundant Discord moderation-buttons” bullet from the WARDOGS Warning & Management Bot service card.
- The Discord moderation buttons themselves remain fully available in the bot.

- WARDOGS Management Bot has a dedicated **Ban messages** settings block with an optional Discord server/invite link.
- The invite is appended automatically to permanent and temporary bans, including manual bans, ban templates and detection-rule bans.
- Temporary bans keep the duration at the front, for example: `Ban duration: 1 day | Teamkilling | Discord: https://discord.gg/example`.
- Ban durations can be selected as **Permanent**, **Minutes**, **Hours** or **Days**. This applies to the web panel, ban templates, detection-rule temporary bans and the Discord management panel ban flow.
- Config export/import includes the non-secret invite setting.
- Database schema version 26.

## v3.12.14 – Temporary-ban duration in ban message

- Temporary WARDOGS bans now include their duration directly in the actual ban reason sent to the game server.
- Applies to manual temporary bans, ban templates and detection-rule temporary bans.
- Discord confirmations and detection-action labels use human-readable durations.


## v3.12.13 – Moderation toolkit & auto recovery

- WARDOGS Management Bot: temporary bans with automatic unban after the configured duration.
- Reusable ban templates with reason and optional duration.
- Detection rules can independently choose Alert, Kick, Permanent Ban or Temporary Ban.
- Safe managed-bot config export/import; secrets, ownership, billing data and runtime statistics are never exported.
- Auto-Recovery for WARDOGS Management Bot and Playtime Tracker with guarded reconnect/restart attempts and exponential backoff.
- Temporary-ban expiry is processed even while the Discord bot itself is stopped, as long as the service instance still exists and WARDOGS is configured.
- Database schema version 25.
- Multi-Server Dashboard is recorded as a future roadmap idea only; it is not implemented in this release.


## v3.12.12 – Reliable WARDOGS join welcome whisper

- Fixed the join welcome whisper being marked as completed before WARDOGS actually accepted the whisper.
- A welcome is now considered delivered only after a successful `POST /v1/players/{steamId}/message` response.
- Welcome whispers are sent privately on every observable join session, including returning players; faction/team assignment is no longer required before the first send attempt.
- Spawn/player-readiness HTTP errors are retried up to four times on later polls for the same join session; successful delivery is still exactly once per join.
- Authentication, unsupported-route and ambiguous transport failures are not blindly retried, preventing duplicate whispers.
- Faction detection now also tolerates object-shaped faction data while keeping unassigned/no-team states pending.
- No database migration is required.
## v3.12.8 – Full-day activity stats & service-bot deletion

- WARDOGS Playtime Tracker now shows **all 24 hours (00:00–23:00)** in chronological order instead of only the top 12 activity buckets.
- Hours without samples are displayed as `0.0` average players / `0` max players, so the full day is always visible.
- Every managed service-bot instance now has a **Danger Zone** for permanent deletion.
- Deleting a paid instance first cancels its linked PayPal subscription, then removes the bot configuration/statistics immediately.
- The UI clearly warns that **no refund is issued** and any remaining paid runtime is forfeited when an instance is permanently deleted.
- Normal subscription cancellation remains separate: it stops future billing while keeping already-paid access until its recorded expiry when available.

## v3.12.7 – WARDOGS Playtime Tracker & complete Node load stats

- New **WARDOGS Playtime Tracker** managed service for **€1.99/month**.
- Tracks each player by Steam64ID from the configured WARDOGS server and stores per-player server playtime.
- Dashboard includes Top 25, total player-hours, current online count, peak hours and common leading clan tags such as `[AUT]`.
- Optional Discord Top-25 channel updates one persistent leaderboard message every 6 hours; manual refresh is available in the web panel.
- Discord is optional for the tracker and only required when the Discord leaderboard is configured.
- Managed bot services now support categories and the public catalog has a category filter; the first category is **WARDOGS**.
- Service-bot purchases now use a dedicated checkout page before PayPal, showing the selected bot, monthly price and the fact that each purchase creates one separate instance/subscription.
- Node Manager capacity/load now includes active **Status Bots + Managed Service Bots + approved Custom Bots**, with a per-type breakdown.
- Database version 23 adds tracker storage/settings while preserving existing service subscription catalog IDs.

## v3.12.6 – WARDOGS seeding range

- The normal WARDOGS status bot shows the automatic **Seeding** presence only at **1-20 players**.
- At **0 players** and **21+ players**, Seeding is removed from the status rotation.

## v3.12.5 – Multiple instances per managed bot service

- Users can purchase the same managed bot service multiple times.
- Every instance has its own configuration, Discord bot token, WARDOGS target, runtime and PayPal subscription.
- Active instances no longer block purchasing another instance.
- One unfinished PayPal checkout at a time is allowed to prevent accidental duplicate subscriptions.
- Admins can create multiple free managed-bot instances as well.
- Database version 22 preserves existing managed bots and links legacy paid instances to their existing service-subscription records.

Multi-user hosting for Discord status bots with WARDOGS, FiveM, GameDig, generic JSON APIs, text rotation, Premium plans, Free Boost, multi-VPS status nodes, managed bot services, donations and approved custom bots.




## v3.12.4

- Managed-bot lifecycle operations are serialized per bot so concurrent sync/restart/stop requests cannot create duplicate Discord clients.
- Stop persists `enabled=false` before disconnecting, preventing a stale background sync from immediately bringing the bot back online.
- Stopped WARDOGS managed bots now show an explicit **Start** button in both the user management page and admin bot controls.
- Detection uses a session-aware join tracker: the startup snapshot is baseline-only and each Steam64ID is screened once per confirmed join session.
- A player must be absent from three consecutive successful player snapshots before a later appearance counts as a new join, protecting against temporary empty/incomplete `/v1/players` responses.
- Overlapping polling cycles are blocked so slow Steam/RCON requests cannot run duplicate detection passes.

## v3.12.3

- WARDOGS player Steam64 IDs are fetched automatically from the live player list; join/reconnect detection uses those IDs without manual player-ID input.
- Steam ban/account lookups are batched and WARDOGS playtime uses the fixed Steam App ID `1867240`; users no longer configure an App ID.
- The WARDOGS Discord management panel, modals and action feedback are English.
- Detection alerts include an **Ignore** button. Ignored players produce no further detection alerts or auto-bans until removed from the web panel's Detection Ignore List.
- Discord role/user grants include a dedicated Ignore permission.
- Database version 21 stores the ignore list while preserving existing managed-service and PayPal data.


## v3.12.1

- WARDOGS Detection Rules redesigned around Steam risk signals: VAC bans, game bans, low playtime, new accounts, recent bans, Community/Economy bans and private profiles.
- Empty default rule removed, so management-panel-only changes no longer fail rule validation.
- Optional encrypted Steam Web API key per managed bot, with `STEAM_WEB_API_KEY` environment fallback.
- Configurable Steam App ID for low-playtime checks.
- Legacy v3.12.0 SteamID/name/faction/ping rules are cleared during migration and Auto-Ban is switched OFF for safety until new rules are configured.

## v3.12.0

- Detection rules for the WARDOGS managed bot now use structured dropdowns and input fields instead of raw rule syntax.
- Player team changes use the live factions reported by WARDOGS as a dropdown.
- Map management uses dropdown-driven map, lighting, map-specific experiences and zone alternators.
- Optional persistent Discord management panel that automatically moves back to the bottom of its configured channel.
- Discord panel supports live players, Whisper, Kick, Ban, Kill/Respawn, Set Team, Steam profile, server announcements, ban management, match controls, map changes and lighting.
- Granular Discord role/user grants can be configured by Discord ID for View, Announcement, Whisper, Kick, Ban, Unban, Kill, Set Team, Match, Map and Lighting permissions.
- Database version 19 migrates existing managed bots safely; the Discord panel remains OFF until explicitly enabled.


## v3.11.9

- Admin panel now exposes start/rebuild, stop, approve/revoke, logs, source and delete controls for Custom Bots.
- WARDOGS Warning & Management Bot is now a hosted managed service with its own configuration page.
- Separate PayPal monthly subscription per managed bot service; WARDOGS service defaults to €3.99/month and does not consume Premium status-bot slots.
- Admin accounts can activate their own WARDOGS managed bot for free.
- Rule-based join alerts support optional automatic bans. Auto-ban is OFF by default and must be explicitly enabled.
- Discord warning messages include Ban, Kick and Steam Profile buttons.
- Managed bot access and runtime are synchronized automatically when a subscription expires or configuration changes.

- Live WARDOGS management dashboard with current server status, health, build, players and ban list.
- Player controls from the panel: Whisper, Kick, Ban, Kill/Respawn, faction change and Steam profile.
- Manual in-game server announcements plus optional rotating scheduled announcements (OFF by default).
- Match restart/end, map change and lighting controls.
- Read-only rotation, reserved-slot and WARDOGS audit-log views, plus join code when available.
- Capability-aware controls hide optional actions unsupported by the connected WARDOGS build.

## v3.10.0 Lifecycle

- Premium endet: 1 Bot bleibt online, weitere Bots 7 Tage pausiert, danach gelöscht.
- Premium innerhalb von 7 Tagen erneuert: pausierte Bots kommen automatisch zurück.
- Free: alle 14 Tage Renew im Account-Dashboard; danach 7 Tage Pause, dann Löschung.
- Admin kann Free-Renew pro User ausnehmen.
- User können Status-Bots selbst offline/online schalten.
- WARDOGS kann optional `Seeding` bei 1 bis 20 Spielern in die Rotation aufnehmen.
- Cookie-Consent ist eingebaut; optionale Kategorien werden erst nach Einwilligung aktiviert. Aktuell sind keine optionalen Tracker integriert.


## v3.10.0

- Premium can be purchased as a one-time PayPal payment or a monthly PayPal subscription.
- New `Your Account` page shows the current plan, billing type, expiry and PayPal subscription state.
- Users can cancel their monthly PayPal subscription from `Your Account`.
- Cancelling stops future PayPal charges while Premium remains available until the already-paid period ends.
- PayPal subscription products and monthly billing plans are created automatically from Admin -> Settings.
- Monthly prices are configured in the backend for Premium 5/10/15/20.
- Subscription renewals are processed through verified PayPal webhooks.
- Premium branding is non-destructive: user-authored status text is never changed. Free branding is appended dynamically at runtime and disappears automatically while Premium is active.

## Premium

| Plan | Status bots | Branding |
|---|---:|---|
| Free | 1 to 5 with Free Boost | `Powered by status-hub.lol` |
| Premium 5 | 5 | none |
| Premium 10 | 10 | none |
| Premium 15 | 15 | none |
| Premium 20 | 20 | none |

Each Premium plan can offer both:

- one-time access for the configured number of days
- a recurring monthly PayPal subscription

Custom bot permissions remain separate and can only be granted by an admin.

## PayPal

Create a PayPal REST application and open:

```text
Admin -> Settings -> Premium & PayPal
```

Configure Sandbox/Live, Client ID, Client Secret, currency, one-time prices, monthly subscription prices and the one-time duration. Then use:

```text
Save & automatically set up / test PayPal
```

The panel stores the PayPal secret encrypted, registers the webhook and creates the PayPal subscription product/plans automatically. No PayPal SSH or `.env` configuration is required.

Webhook URL:

```text
https://status-hub.lol/webhooks/paypal
```

PayPal subscription cancellation is available to the customer under:

```text
https://status-hub.lol/account
```

## Branding behavior

Status templates saved by users are never modified when a plan changes.

For Free users, the node materializes the runtime status list as:

```text
user text 1
user text 2
Powered by status-hub.lol
```

For Premium users, it materializes only:

```text
user text 1
user text 2
```

No custom text is deleted and no replacement text is added during a Premium purchase.

## Free Boost

Every Free account starts with one status bot. To unlock additional free status bots, at least one hosted status bot must be on a Discord server whose top category is named exactly:

```text
Powered by status-hub.lol
```

The category must be visible to `@everyone`. Member thresholds for 2/3/4/5 total free bots are configured in Admin -> Settings.

## Admin

The Admin Control Center contains:

- All bots
- Nodes
- Users & plans
- Bot services
- Settings
- PayPal one-time and monthly subscription configuration

Normal user pages show only the logged-in user's own bots.

## Install

```bash
cd /opt
git clone https://github.com/testererrewr/wardogs-status-panel.git
cd wardogs-status-panel
bash ./setup-vps.sh
```

## Update

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

`.env`, `data/` and `custom-bots/` must never be committed.

## Production URLs

```text
https://status-hub.lol
https://status-hub.lol/account
https://status-hub.lol/auth/discord/callback
https://status-hub.lol/webhooks/paypal
```


## Discord OAuth settings

Discord OAuth can be changed in **Admin -> Settings**. Existing `.env` credentials are kept as a fallback. The Discord Client Secret is encrypted with `APP_ENCRYPTION_KEY` when stored in the panel database.

## Stripe

Stripe can be configured completely in **Admin → Settings**. The panel supports Test/Live secret keys, automatic webhook setup, one-time Premium purchases, monthly subscriptions, automatic entitlement updates, and cancellation from **Your Account**. Stripe credentials and webhook secrets are encrypted in the panel database.


## v3.11.1

Sticky footer, clearer Free account expiry display and improved PayPal subscription setup status.


## v3.11.2

WARDOGS supports live faction scores from `/v1/status`. Available status tags: `{score}`, `{team1}`, `{score1}`, `{team2}`, `{score2}`. The WARDOGS form also has an optional automatic score rotation entry. Custom status texts are not changed.


## v3.11.3

- Premium uses a dedicated checkout page: **Buy → Checkout → one-time/subscription → PayPal/Stripe**.
- PayPal subscription setup now distinguishes saved prices from PayPal billing plans and persists created plans before webhook setup.
- Custom-bot ZIP uploads accept the common outer-folder layout, can auto-detect common entrypoints, default to a 25 MB upload limit and keep a successful upload even when the subsequent Docker build fails.


## v3.11.4

- Custom-bot ZIP uploads ignore dependency/cache folders such as `node_modules`, `.git`, `venv`, `.venv` and `__pycache__`.
- Up to 5,000 relevant source files and 20,000 raw ZIP entries are accepted, with a 100 MB unpacked-size limit.

## v3.11.5

- Custom-bot ZIP validation now rejects unsafe/duplicate paths and checks the 100 MB expanded-size limit before extraction.
- Outer project folders work with both automatic and manually entered entrypoints.
- Node entrypoints can be detected from `package.json`; additional common Node/Python entry filenames are recognized.
- Multipart upload errors return cleanly to the upload form and upload fields/parts have explicit limits.
- Failed build/start attempts no longer leave custom bots marked as enabled.