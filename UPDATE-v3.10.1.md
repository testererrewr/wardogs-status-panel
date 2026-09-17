# Update v3.10.1

- Discord OAuth can now be managed from Admin -> Settings.
- Client/Application ID, encrypted Client Secret, login enabled/disabled and public registration are configurable.
- The current OAuth redirect URL is shown in the panel.
- `Save & test Discord login` performs a real Discord OAuth login and returns to Settings.
- Existing `.env` OAuth credentials remain a fallback, so current installations keep working.

## Update

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```
