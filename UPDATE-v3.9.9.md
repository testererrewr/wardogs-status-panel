# Update to v3.9.9

Upload the v3.9.9 repository files to GitHub and run on the main VPS:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Then open:

```text
https://status-hub.lol/admin?tab=settings
```

Under Premium & PayPal:

1. keep Sandbox while testing
2. enter the PayPal Sandbox Client ID and Client Secret
3. set one-time prices
4. enable monthly subscriptions
5. set monthly prices
6. click `Save & automatically set up / test PayPal`

The setup creates/updates the PayPal webhook, subscription product and monthly billing plans.

Users can manage and cancel monthly subscriptions at:

```text
https://status-hub.lol/account
```

Premium never edits stored custom status text. It only removes the dynamically generated `Powered by status-hub.lol` entry while the Premium entitlement is active.
