# Update v3.9.1

Fixes the admin layout and Discord profile menu.

- Admin Control Center uses a stable left sidebar on desktop.
- Discord avatars are forced to a fixed size.
- Profile menu opens reliably by click and hover.
- Logout stays inside the profile dropdown.
- CSS is cache-busted so updated layouts are loaded immediately.
- Static CSS no longer uses the previous one-hour browser cache.

Update:

```bash
cd /opt/wardogs-status-panel
git config core.fileMode false
git pull --ff-only
bash ./update.sh
```

Then reload the page once. A normal reload is enough because v3.9.1 uses a new stylesheet URL.
