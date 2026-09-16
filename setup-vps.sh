#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Bitte als root ausführen: ./setup-vps.sh"; exit 1; fi
cd "$(dirname "$0")"
echo "=== Server Status Hub - Debian VPS Setup ==="

if ! command -v git >/dev/null 2>&1; then apt-get update && apt-get install -y git; fi
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose ca-certificates openssl
  systemctl enable --now docker
fi
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else apt-get update && apt-get install -y docker-compose; COMPOSE=(docker-compose); fi

if [[ -f .env ]]; then
  read -r -p ".env existiert bereits. Neu erstellen? [j/N] " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[jJyY]$ ]]; then
    if ! grep -q '^RUNNER_SHARED_SECRET=' .env; then echo "RUNNER_SHARED_SECRET=$(openssl rand -hex 48)" >> .env; fi
    if ! grep -q '^RUNNER_URL=' .env; then echo 'RUNNER_URL=http://runner:4000' >> .env; fi
    if ! grep -q '^ALLOW_PUBLIC_REGISTRATION=' .env; then echo 'ALLOW_PUBLIC_REGISTRATION=true' >> .env; fi
    if ! grep -q '^DEFAULT_STATUS_BOT_LIMIT=' .env; then echo 'DEFAULT_STATUS_BOT_LIMIT=1' >> .env; fi
    if ! grep -q '^CUSTOM_UPLOAD_MAX_MB=' .env; then echo 'CUSTOM_UPLOAD_MAX_MB=5' >> .env; fi
    if ! grep -q '^PANEL_BIND=' .env; then echo 'PANEL_BIND=0.0.0.0:3000' >> .env; fi
    if [[ -f compose.override.yaml ]] && grep -q 'wardogs-panel' compose.override.yaml; then mv compose.override.yaml "compose.override.yaml.v2-backup-$(date +%Y%m%d-%H%M%S)"; fi
    mkdir -p data custom-bots
    chown -R 1000:1000 data custom-bots
    chmod 750 data custom-bots
    "${COMPOSE[@]}" up -d --build --remove-orphans
    "${COMPOSE[@]}" ps
    exit 0
  fi
fi

echo
cat <<TXT
Zugriffsmodus:
  1) Direkt über VPS-IP:3000  (empfohlen wenn Port 80/443 schon belegt ist)
  2) Domain + HTTPS über eingebautes Caddy (benötigt freie Ports 80/443)
TXT
read -r -p "Modus [1]: " MODE
MODE=${MODE:-1}

if [[ "$MODE" == "2" ]]; then
  read -r -p "Domain, z.B. bots.example.com: " DOMAIN
  DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%/}
  PUBLIC_URL="https://${DOMAIN}"
  PANEL_BIND="127.0.0.1:3000"
  COMPOSE_PROFILES="proxy"
  TRUST_PROXY=true
  COOKIE_SECURE=true
else
  GUESS_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  read -r -p "Öffentliche VPS-IP [${GUESS_IP}]: " VPS_IP
  VPS_IP=${VPS_IP:-$GUESS_IP}
  PUBLIC_URL="http://${VPS_IP}:3000"
  PANEL_BIND="0.0.0.0:3000"
  COMPOSE_PROFILES=""
  TRUST_PROXY=false
  COOKIE_SECURE=false
fi

read -r -p "Discord OAuth Client ID: " DISCORD_OAUTH_CLIENT_ID
read -r -s -p "Discord OAuth Client Secret: " DISCORD_OAUTH_CLIENT_SECRET; echo
read -r -p "Deine Discord User ID (Admin): " ADMIN_DISCORD_IDS
if [[ -z "$DISCORD_OAUTH_CLIENT_ID" || -z "$DISCORD_OAUTH_CLIENT_SECRET" ]]; then echo "OAuth Daten fehlen."; exit 1; fi
if [[ ! "$ADMIN_DISCORD_IDS" =~ ^[0-9]{17,20}(,[0-9]{17,20})*$ ]]; then echo "Ungültige Discord User ID."; exit 1; fi

SESSION_SECRET=$(openssl rand -hex 48)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
RUNNER_SHARED_SECRET=$(openssl rand -hex 48)
cat > .env <<ENVEOF
PUBLIC_URL=${PUBLIC_URL}
PORT=3000
PANEL_BIND=${PANEL_BIND}
SESSION_SECRET=${SESSION_SECRET}
APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}
RUNNER_SHARED_SECRET=${RUNNER_SHARED_SECRET}
RUNNER_URL=http://runner:4000
DISCORD_OAUTH_CLIENT_ID=${DISCORD_OAUTH_CLIENT_ID}
DISCORD_OAUTH_CLIENT_SECRET=${DISCORD_OAUTH_CLIENT_SECRET}
ADMIN_DISCORD_IDS=${ADMIN_DISCORD_IDS}
ALLOW_PUBLIC_REGISTRATION=true
DEFAULT_STATUS_BOT_LIMIT=1
CUSTOM_UPLOAD_MAX_MB=5
TRUST_PROXY=${TRUST_PROXY}
COOKIE_SECURE=${COOKIE_SECURE}
COMPOSE_PROFILES=${COMPOSE_PROFILES}
ENVEOF
chmod 600 .env
mkdir -p data custom-bots
# Panel läuft als node UID 1000. Host-Bind-Mounts müssen ihm gehören.
chown -R 1000:1000 data custom-bots
chmod 750 data custom-bots
touch data/.gitkeep custom-bots/.gitkeep || true

echo
echo "Discord OAuth Redirect URI:"
echo "  ${PUBLIC_URL}/auth/discord/callback"
echo "Diese URI exakt im Discord Developer Portal -> OAuth2 -> Redirects eintragen."
read -r -p "Redirect URI eingetragen? [j/N] " READY
if [[ ! "$READY" =~ ^[jJyY]$ ]]; then echo "Konfiguration gespeichert. Danach starten mit: ${COMPOSE[*]} up -d --build"; exit 0; fi

"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
echo
echo "Fertig: ${PUBLIC_URL}"
echo "Logs: ${COMPOSE[*]} logs -f server-status-hub"
