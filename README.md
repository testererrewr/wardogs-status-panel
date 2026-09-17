# status-hub.lol v3.9.5

Multi-user hosting for Discord status bots with WARDOGS, FiveM, GameDig, generic JSON APIs, text rotation, Premium plans, Free Boost, multi-VPS status nodes, managed bot services, donations and approved custom bots.

## v3.9.5

- Public header login now opens Discord OAuth directly on every public page.
- Enabled status bots automatically reconnect after updates and status-node/container restarts.
- Disabled or paused bots stay stopped.

## v3.9.3

- Free Boost now checks the top Discord category named `Powered by status-hub.lol` instead of a text channel.
- The branding category must be the top category and visible to `@everyone`.
- PayPal Sandbox/Live mode, Client ID and Client Secret are configured entirely in Admin -> Settings.
- PayPal Client Secret is encrypted in the panel database; no PayPal `.env` or SSH setup is required.
- PayPal Sandbox displays the same Buy now checkout button as Live so purchases can be tested end-to-end.
- Admins see other users' status/custom bots only in Admin -> All bots. The normal dashboard shows only the admin's own bots.
- Reaching a status/custom bot limit opens a panel popup instead of a plain white 403 page.
- Games & FAQ is fully bilingual for DE/EN, including special GameDig setup notes and provider labels.

## PayPal

Create a PayPal REST application and open:

```text
Admin -> Settings -> Premium & PayPal
```

Enter Sandbox/Live, Client ID, Client Secret, currency, duration and the prices for Premium 5/10/15/20. Then use `Save & automatically set up / test PayPal`. The panel stores the secret encrypted and registers:

```text
https://status-hub.lol/webhooks/paypal
```

A completed payment activates the purchased Premium plan automatically. Refund/reversal handling is also supported for entitlements created by the corresponding PayPal purchase.

## Premium

| Plan | Status bots | Branding |
|---|---:|---|
| Free | 1 to 5 with Free Boost | `Powered by status-hub.lol` |
| Premium 5 | 5 | none |
| Premium 10 | 10 | none |
| Premium 15 | 15 | none |
| Premium 20 | 20 | none |

Custom bot permissions remain separate and can only be granted by an admin.

## Free Boost

Every Free account starts with one status bot. To unlock additional free status bots, at least one hosted status bot must be on a Discord server whose top category is named exactly:

```text
Powered by status-hub.lol
```

The category must be visible to `@everyone`. Member thresholds for 2/3/4/5 total free bots are configured in the admin settings.

## Admin

The Admin Control Center contains:

- All bots: every user's status bots and custom bots
- Nodes: capacities, accept-new-bots, disable, drain and bot moves
- Users & plans: Premium duration, overrides and custom bot slots
- Bot services: managed products
- Settings: PayPal, Free Boost, domain, donations and team IDs

Normal `/` and `/custom-bots` pages show only the logged-in user's own bots, even for admins.

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
https://status-hub.lol/auth/discord/callback
https://status-hub.lol/webhooks/paypal
```
