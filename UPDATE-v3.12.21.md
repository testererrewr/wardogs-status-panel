# Update v3.12.21 — Origin save fix & JOIN Seeding removal

- Fixed legitimate HTTPS form submissions behind Caddy/reverse proxies being blocked with `Ungültige Request-Origin.`.
- CSRF tokens remain mandatory; request origins must still match the configured public host and HTTPS cannot be downgraded when `PUBLIC_URL` is HTTPS.
- Removed the WARDOGS Management Bot `JOIN Seeding` server-name feature completely from settings, runtime, config export/import and the service feature list.
- Existing v3.12.20 management bots attempt a one-time cleanup of a leftover ` JOIN Seeding` suffix when they next start.
- Database schema version: 31.

- Fixed the v3.12.18 custom-bot hardening regression that could leave arbitrary uploaded bots offline when they need to write cache/state files at runtime.
- Custom bots keep isolated per-bot Docker networks, CPU/RAM/PID limits, dropped capabilities and `no-new-privileges`, but their private container overlay is writable again for compatibility.
- Existing read-only custom-bot containers are detected and recreated automatically on the next ensure/start after updating.
