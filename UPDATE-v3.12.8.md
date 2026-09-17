## v3.12.8 – Full-day activity stats & service-bot deletion

- WARDOGS Playtime Tracker now shows **all 24 hours (00:00–23:00)** in chronological order instead of only the top 12 activity buckets.
- Hours without samples are displayed as `0.0` average players / `0` max players, so the full day is always visible.
- Every managed service-bot instance now has a **Danger Zone** for permanent deletion.
- Deleting a paid instance first cancels its linked PayPal subscription, then removes the bot configuration/statistics immediately.
- The UI clearly warns that **no refund is issued** and any remaining paid runtime is forfeited when an instance is permanently deleted.
- Normal subscription cancellation remains separate: it stops future billing while keeping already-paid access until its recorded expiry when available.

