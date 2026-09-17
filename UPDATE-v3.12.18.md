# Update v3.12.18 — Security hardening

This release hardens the public panel, sessions, custom-bot hosting and VPS file handling.

## Added / changed
- Layered per-IP rate limiting for public traffic and state-changing requests.
- Tighter OAuth and custom-bot upload limits; OAuth state expires after 10 minutes.
- HTTP anti-Slowloris timeouts and header/request limits.
- CSP and additional browser security/privacy headers; CSRF-protected form posts also verify same-origin requests.
- Dynamic panel pages are sent with `Cache-Control: no-store`.
- The complete local application database and session storage are encrypted at rest with `APP_ENCRYPTION_KEY` (legacy plaintext files migrate automatically on next write).
- Session cookies use `HttpOnly`, `SameSite=Lax`, `Secure` when HTTPS is configured, `Priority=High`, and the `__Host-` cookie prefix on HTTPS.
- Optional `ADMIN_IP_ALLOWLIST` can restrict admin actions to exact trusted public IPs.
- OAuth provider error details are no longer echoed to the browser.
- Custom bot ZIP uploads reject common secret files such as `.env`, `.npmrc`, `.pypirc`, `.netrc`, SSH private-key filenames and `credentials.json`.
- Custom-bot source/runtime files are written with owner-only permissions.
- Custom bot log output redacts configured ENV values and common token/password patterns before it is shown in the panel.
- Runner authentication uses constant-time secret comparison and its HTTP endpoint has its own rate limits/timeouts.
- Platform dependency versions are top-level pinned and container builds disable dependency install scripts.
- Panel, local status node and runner containers are hardened with read-only root filesystems, dropped Linux capabilities, `no-new-privileges`, PID limits and controlled tmpfs mounts.
- Every approved custom bot gets its own isolated Docker bridge network; existing containers migrate on the next ensure/start.
- Backups are created with restrictive permissions (`0700` directory, `0600` archive).
- Update/setup scripts re-apply restrictive permissions to `.env`, `data/` and `custom-bots/`.
- Included Caddy proxy strips the `Server` header and adds privacy/security headers.

## DDoS note
Application rate limits help against abusive clients and small request floods, but they do not stop volumetric network-layer DDoS attacks. For a public production domain, use an upstream DDoS-capable reverse proxy/CDN and provider firewall in front of the VPS.
