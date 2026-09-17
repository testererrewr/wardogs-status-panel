# status-hub.lol v3.10.0

Multi-user hosting for Discord status bots with WARDOGS, FiveM, GameDig, generic JSON APIs, text rotation, Premium plans, Free Boost, multi-VPS status nodes, managed bot services, donations and approved custom bots.

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
