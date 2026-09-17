# Update v3.12.7

## WARDOGS Playtime Tracker

A second managed bot service is available: **WARDOGS Playtime Tracker** for **€1.99/month**.

- Tracks server playtime for every player by Steam64ID from the configured WARDOGS `/v1/players` endpoint.
- Stores a per-player leaderboard and total tracked player-hours.
- Web dashboard shows Top 25 players, total playtime, currently online players, peak hours and frequently used leading clan tags such as `[AUT]`.
- Optional Discord Top-25 channel uses one persistent message and refreshes automatically every six hours.
- Statistics can be refreshed manually from the web panel; Discord publishing is a separate manual action when a channel is configured.
- Discord integration is optional. A Discord bot token is only required when the Discord Top-25 channel is enabled.
- Each tracker instance has its own WARDOGS target, statistics, Discord integration and separate PayPal subscription.
- Admins can create free tracker instances just like the existing WARDOGS Warning & Management Bot.

## Service bot checkout

- Clicking **Get bot** now opens a dedicated service-bot checkout page instead of starting PayPal immediately.
- The checkout clearly shows the selected service, monthly price, included features and that every purchase creates exactly one separate instance with its own subscription.
- Existing instances remain visible and do not block buying another instance; only a still-pending PayPal checkout blocks a duplicate checkout.

## Service categories

- Managed bot services now have categories.
- The public Bot Services page has a category filter.
- The initial category is **WARDOGS**; more categories can be added later from the service catalog/admin configuration.

## Node capacity / stats

- Status Bots, Managed Service Bots and approved Custom Bots now all count toward Status Node capacity statistics.
- Node Manager load shows a breakdown of **Status / Service / Custom** bot instances.
- Node detail pages list all three bot classes under the assigned node.
- Disabled/inactive bots do not consume active node capacity.

## Database

Database version is **23**. Existing WARDOGS Warning & Management Bot PayPal product/plan IDs are preserved during migration, and the Playtime Tracker is added as a separate service catalog entry.
