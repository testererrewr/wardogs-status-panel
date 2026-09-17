# Security

## Production baseline
Use HTTPS and a reverse proxy. With the included Caddy setup the panel should normally be bound to `127.0.0.1:3000`, while only ports 80/443 are public. Keep SSH restricted to trusted administration access where possible.

Never publish port 4000. The custom-bot runner is an internal service and has access to the Docker socket, which is intentionally powerful. Each approved custom bot is placed on its own Docker bridge network so custom bots are not peers on one shared bot network.
Custom-bot containers keep strict CPU/RAM/PID limits, dropped capabilities and `no-new-privileges`. Their private container overlay is writable for compatibility with bots that need runtime cache/state files; no host filesystem is mounted into the bot container.

## DDoS protection
The application includes layered IP rate limits and HTTP timeouts. These protect application resources, not the VPS network link. For volumetric attacks place the domain behind a DDoS-capable CDN/reverse proxy and use your VPS/provider firewall.

When a trusted reverse proxy is used, set `TRUST_PROXY=true`. Do not enable it when clients can reach the Node.js panel directly, otherwise forwarded client-IP headers can be spoofed.

## Secrets and data
- `.env`, DB/session files, custom-bot files and backups are restricted on disk.
- The application database, session file, bot tokens, RCON passwords and configured secrets are encrypted at rest with AES-256-GCM through `APP_ENCRYPTION_KEY`.
- Do not upload `.env` or private credentials inside custom-bot ZIPs; the upload rejects common secret-file names. Use the encrypted ENV configuration in the panel instead.
- Backups contain sensitive data. Store them off-site only in encrypted/private storage and never in a public web directory.

A root compromise of the VPS can still access live application secrets. Keep Debian, Docker and the host kernel patched and do not install unrelated services on the same VPS.

## Optional admin IP lock
Set `ADMIN_IP_ALLOWLIST` to a comma-separated list of exact public IP addresses to restrict all `/admin` actions. Leave it empty for normal Discord-admin access. Only use it when your public IP is stable and `TRUST_PROXY` is configured correctly for your reverse proxy.
