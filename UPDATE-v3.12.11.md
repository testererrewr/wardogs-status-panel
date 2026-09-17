# Update v3.12.11

- Added an opt-in **join welcome whisper** to the WARDOGS Warning & Management Bot.
- Newly joined players are queued until WARDOGS reports a faction (spawned), then receive one configured whisper for that join session.
- Players already online when the bot starts/restarts are baseline only and are not greeted again.
- Templates support `{player}`, `{steamid}` and `{faction}`.
- The feature is **OFF by default** for existing and new instances.
- Database version: 24.
