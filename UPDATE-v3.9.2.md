# Update v3.9.2

- Fixes invalid CSRF token on Premium & PayPal settings.
- Removes invalid nested form markup from the PayPal setup button.
- PayPal setup now saves the current Premium/PayPal settings before creating/testing the webhook.
- Direct GET/HEAD access through the old IP/port is redirected to PUBLIC_URL.
- Browser CSS cache version bumped to v3.9.2.

Update:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Use the panel through `https://status-hub.lol` after the update.
