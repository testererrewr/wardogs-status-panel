# Update v3.12.4

This release fixes duplicate WARDOGS warnings and the managed-bot Start/Stop lifecycle.

- Only one Discord client instance can run per managed bot. Start, restart, stop and background sync operations are serialized.
- Stop writes `enabled=false` before disconnecting and stale sync snapshots re-read the current database state, so a stopped bot cannot be resurrected by an older sync.
- The management page and admin bot table show **Start** whenever the bot is stopped.
- Detection is baseline-only on bot start/restart and screens a Steam64ID once per join session.
- Temporary/incomplete player-list snapshots no longer make all online players look like fresh joins. A player has to be absent from three consecutive successful snapshots before a later return becomes a new join.
- Poll cycles cannot overlap. A slow Steam or WARDOGS request therefore cannot start a second detection pass at the same time.
- No database migration is required.
