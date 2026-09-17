# Update v3.12.3

- WARDOGS detection is now strictly **join-only**.
- The first successful `/v1/players` poll after bot start/restart only establishes the online-player baseline; already-online players are not screened or alerted again.
- A player is screened exactly once when their Steam64ID first appears after being absent from the previous player snapshot.
- Polling, Discord management-panel refreshes and bot configuration restarts do not retrigger detection for players who are already online.
- Steam API failures no longer remove a player from the seen set, preventing repeated detection attempts/alerts for the same join.
- After a player leaves and later appears again, that new join can be screened once again.
