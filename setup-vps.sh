#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root: bash ./setup-vps.sh"; exit 1; fi
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
  read -r -p ".env already exists. Recreate it? [y/N] " OVERWRITE
  if [[ ! "$OVERWRITE" =~ ^[jJyY]$ ]]; then bash ./update.sh; exit 0; fi
fi
echo
printf '%s\n' "Access mode:" "  1) VPS IP:3000" "  2) Domain + HTTPS with included Caddy"
read -r -p "Mode [1]: " MODE
MODE=${MODE:-1}
if [[ "$MODE" == "2" ]]; then
  read -r -p "Domain, e.g. panel.example.com: " DOMAIN
  DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%/}
  PUBLIC_URL="https://${DOMAIN}"
  PANEL_BIND="127.0.0.1:3000"
  COMPOSE_PROFILES="proxy"
  TRUST_PROXY=true
  COOKIE_SECURE=true
else
  GUESS_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  read -r -p "Public VPS IP [${GUESS_IP}]: " VPS_IP
  VPS_IP=${VPS_IP:-$GUESS_IP}
  PUBLIC_URL="http://${VPS_IP}:3000"
  PANEL_BIND="0.0.0.0:3000"
  COMPOSE_PROFILES=""
  TRUST_PROXY=false
  COOKIE_SECURE=false
fi
read -r -p "Service branding domain [status-hub.lol]: " SERVICE_DOMAIN
SERVICE_DOMAIN=${SERVICE_DOMAIN:-status-hub.lol}
read -r -p "Max status bots on this main VPS [50]: " LOCAL_STATUS_NODE_MAX_BOTS
LOCAL_STATUS_NODE_MAX_BOTS=${LOCAL_STATUS_NODE_MAX_BOTS:-50}
read -r -p "Discord OAuth Client ID: " DISCORD_OAUTH_CLIENT_ID
read -r -s -p "Discord OAuth Client Secret: " DISCORD_OAUTH_CLIENT_SECRET; echo
read -r -p "Your Discord User ID (Admin): " ADMIN_DISCORD_IDS
if [[ -z "$DISCORD_OAUTH_CLIENT_ID" || -z "$DISCORD_OAUTH_CLIENT_SECRET" ]]; then echo "OAuth data missing."; exit 1; fi
if [[ ! "$ADMIN_DISCORD_IDS" =~ ^[0-9]{17,20}(,[0-9]{17,20})*$ ]]; then echo "Invalid Discord User ID."; exit 1; fi
SESSION_SECRET=$(openssl rand -hex 48)
APP_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
RUNNER_SHARED_SECRET=$(openssl rand -hex 48)
STATUS_NODE_JOIN_SECRET=$(openssl rand -hex 48)
cat > .env <<ENVEOF
PUBLIC_URL=${PUBLIC_URL}
PORT=3000
PANEL_BIND=${PANEL_BIND}
SESSION_SECRET=${SESSION_SECRET}
APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}
RUNNER_SHARED_SECRET=${RUNNER_SHARED_SECRET}
RUNNER_URL=http://runner:4000
STATUS_NODE_JOIN_SECRET=${STATUS_NODE_JOIN_SECRET}
LOCAL_STATUS_NODE_ID=local-main
LOCAL_STATUS_NODE_NAME=Main VPS
LOCAL_STATUS_NODE_MAX_BOTS=${LOCAL_STATUS_NODE_MAX_BOTS}
STATUS_NODE_SYNC_SECONDS=10
STATUS_NODE_DEAD_SECONDS=45
STATUS_NODE_LEASE_SECONDS=30
STATUS_NODE_MIN_FREE_MB=150
SERVICE_DOMAIN=${SERVICE_DOMAIN}
SUPPORT_URL=
DONATE_PAYPAL_URL=
DONATE_KOFI_URL=
DONATE_STRIPE_URL=
NODE_INSTALL_SCRIPT_URL=https://raw.githubusercontent.com/testererrewr/wardogs-status-panel/main/install-node.sh
DISCORD_OAUTH_CLIENT_ID=${DISCORD_OAUTH_CLIENT_ID}
DISCORD_OAUTH_CLIENT_SECRET=${DISCORD_OAUTH_CLIENT_SECRET}
ADMIN_DISCORD_IDS=${ADMIN_DISCORD_IDS}
ALLOW_PUBLIC_REGISTRATION=true
CUSTOM_UPLOAD_MAX_MB=5
TRUST_PROXY=${TRUST_PROXY}
COOKIE_SECURE=${COOKIE_SECURE}
COMPOSE_PROFILES=${COMPOSE_PROFILES}
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
ENVEOF
chmod 600 .env
mkdir -p data custom-bots
chown -R 1000:1000 data custom-bots
chmod 750 data custom-bots
touch data/.gitkeep custom-bots/.gitkeep || true
echo
echo "Discord OAuth Redirect URI:"
echo "  ${PUBLIC_URL}/auth/discord/callback"
read -r -p "Redirect URI added in Discord Developer Portal? [y/N] " READY
if [[ ! "$READY" =~ ^[jJyY]$ ]]; then echo "Configuration saved. Start later with: ${COMPOSE[*]} up -d --build"; exit 0; fi
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
echo "Ready: ${PUBLIC_URL}"
