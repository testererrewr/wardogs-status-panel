# Update v3.12.13

## WARDOGS moderation

- Temporary bans with a local expiry timer and automatic WARDOGS unban.
- Ban templates with reusable reasons and optional durations.
- Per-rule Detection Actions: Alert only, Kick, Permanent Ban, Temporary Ban.
- Web and Discord manual bans accept a temporary duration.
- Server ban list shows temporary-ban expiry where tracked by status-hub.

## Config portability

- Managed service bots can export/import a safe JSON config.
- Tokens, passwords, ownership, subscriptions and runtime statistics are intentionally excluded.

## Auto-Recovery

- WARDOGS Management Bot and Playtime Tracker can automatically recover from failed starts and Discord disconnects.
- Recovery retries use increasing delays up to five minutes.
- Auto-Recovery can be disabled per bot.

## Migration

- Database schema 24 -> 25.
- Existing bots get Auto-Recovery enabled by default; no existing detection rule is changed automatically.

## Roadmap only

- Multi-Server Dashboard is documented as a future idea and is not implemented in this release.
