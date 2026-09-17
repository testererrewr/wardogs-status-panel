# Update to v3.9.3

Upload/commit the v3.9.3 repository files to GitHub, then run:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

After the update open:

```text
https://status-hub.lol/admin?tab=settings#settings
```

PayPal credentials are now entered in the Admin panel. Existing `.env` PayPal credentials remain supported as a temporary fallback, but are no longer required once credentials are saved in the panel.

Free Boost now requires the top Discord category to be named `Powered by status-hub.lol`.
