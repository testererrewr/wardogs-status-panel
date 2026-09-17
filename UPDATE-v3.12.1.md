# Update v3.12.1

- Fix: saving only Discord Management Panel settings no longer fails because of an empty default detection rule.
- Detection rules now focus on Steam risk checks: VAC bans, game bans, low playtime, new account age, recent bans, Community ban, Economy ban and private profile.
- Per-bot encrypted Steam Web API key with optional global `STEAM_WEB_API_KEY` fallback.
- Steam App ID field for game-specific playtime checks.
- Steam risk details are shown in Discord warning embeds when available.
- Migration DB 19 -> 20 clears legacy SteamID/name/faction/ping rules and disables Auto-Ban so no old rule can unexpectedly ban after the update.
