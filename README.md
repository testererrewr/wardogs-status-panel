# status-hub.lol v3.12.4

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
- WARDOGS kann optional `Seeding` ab 1 Spieler in die Rotation aufnehmen.
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
