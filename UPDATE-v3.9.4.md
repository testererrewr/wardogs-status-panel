# Update to v3.9.4

Upload/commit the v3.9.4 repository files to GitHub, then run:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Changes:
- Public header Discord login now opens Discord OAuth directly on every public page.
- Enabled status bots are restored automatically after updates and status-node/container restarts.
- Disabled or paused bots remain stopped.

After updating, verify the node log with:

```bash
docker compose logs --tail=80 status-node
```

You should see `Startup restore complete` after the node reconnects.
