# Update to v3.9.5

Upload/commit the v3.9.5 repository files to GitHub, then run:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Changes:
- Visible service branding uses the configured service domain (`status-hub.lol`) instead of `Server Status Hub`.
- Restart always enables and starts the selected status bot, even if it was stopped before.
- Status-bot quota dialogs and buttons link to Premium instead of Get more.
- Custom-bot quota dialogs remain separate because Premium does not grant custom-bot slots.
- PayPal Sandbox uses the same Buy now button and checkout flow as Live, so the full purchase flow can be tested before switching to Live.
