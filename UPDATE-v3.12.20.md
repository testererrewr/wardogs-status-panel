# Update v3.12.20 — JOIN Seeding server-name fix

- Fixed JOIN Seeding target: the suffix now changes the actual WARDOGS game-server name, never the Discord bot nickname.
- At 1–20 players the server name becomes `<original name> JOIN Seeding`.
- At 0 or 21+ players the exact suffix is removed again.
- Uses the WARDOGS `/v1/config` document with revision protection and respects hosts where `ServerName` is pinned/read-only.
- Cleans up the legacy Discord guild nickname suffix left by v3.12.19.
- Re-checks the game-server name periodically so a WARDOGS server restart cannot leave the suffix out of sync.
- Welcome whispers now address the exact player identifier returned by `/v1/players`, while retaining Steam64ID for join-session tracking.
- DB version 30 refreshes the public service feature wording. No payment/subscription data is changed.
