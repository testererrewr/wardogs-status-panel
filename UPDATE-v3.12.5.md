# Update v3.12.5

## Multiple instances of the same Bot Service

Users can now own multiple instances of the same managed bot service. For the WARDOGS Warning & Management Bot, every instance is independent:

- separate PayPal monthly subscription
- separate Discord bot token and channels
- separate WARDOGS/RCON server connection
- separate detection rules, permissions and ignore list
- separate hosted runtime and start/stop controls

The Bot Services page now shows the number of instances and offers **Add another bot**. The management page contains an instance switcher. Cancelling a subscription only affects the bot instance linked to that subscription.

To avoid accidental double-click purchases, only one not-yet-completed PayPal service checkout may be open at a time. Existing active subscriptions do not block buying another bot.

Admins can create multiple free instances.

Database version: **22**. Existing v3.12.4 data is migrated automatically.
