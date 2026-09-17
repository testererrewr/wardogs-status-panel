#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root: bash ./update.sh"; exit 1; fi
if ! command -v openssl >/dev/null 2>&1; then apt-get update && apt-get install -y openssl; fi
if [[ -d .git ]]; then
  git config core.fileMode false
  if ! git diff --quiet -- . ':(exclude).env' ':(exclude)data' ':(exclude)custom-bots' ':(exclude)compose.override.yaml'; then
    echo "Tracked local changes found. Run git status first."; exit 1
  fi
  echo "==> GitHub update"
  git pull --ff-only
fi
if [[ -f compose.override.yaml ]] && grep -q "wardogs-panel" compose.override.yaml; then mv compose.override.yaml "compose.override.yaml.v2-backup-$(date +%Y%m%d-%H%M%S)"; fi
[[ -f .env ]] || { cp .env.example .env; echo "Missing .env. Template created; fill it before starting."; exit 1; }
if ! grep -q '^RUNNER_SHARED_SECRET=' .env; then echo "RUNNER_SHARED_SECRET=$(openssl rand -hex 48)" >> .env; fi
if ! grep -q '^RUNNER_URL=' .env; then echo 'RUNNER_URL=http://runner:4000' >> .env; fi
if ! grep -q '^ALLOW_PUBLIC_REGISTRATION=' .env; then echo 'ALLOW_PUBLIC_REGISTRATION=true' >> .env; fi
if grep -q '^CUSTOM_UPLOAD_MAX_MB=5$' .env; then sed -i 's/^CUSTOM_UPLOAD_MAX_MB=5$/CUSTOM_UPLOAD_MAX_MB=25/' .env; elif ! grep -q '^CUSTOM_UPLOAD_MAX_MB=' .env; then echo 'CUSTOM_UPLOAD_MAX_MB=25' >> .env; fi
if ! grep -q '^PANEL_BIND=' .env; then echo 'PANEL_BIND=0.0.0.0:3000' >> .env; fi
if ! grep -q '^STATUS_NODE_JOIN_SECRET=' .env; then echo "STATUS_NODE_JOIN_SECRET=$(openssl rand -hex 48)" >> .env; fi
if ! grep -q '^LOCAL_STATUS_NODE_MAX_BOTS=' .env; then echo 'LOCAL_STATUS_NODE_MAX_BOTS=50' >> .env; fi
if ! grep -q '^STATUS_NODE_SYNC_SECONDS=' .env; then echo 'STATUS_NODE_SYNC_SECONDS=10' >> .env; fi
if ! grep -q '^STATUS_NODE_DEAD_SECONDS=' .env; then echo 'STATUS_NODE_DEAD_SECONDS=45' >> .env; fi
if ! grep -q '^STATUS_NODE_LEASE_SECONDS=' .env; then echo 'STATUS_NODE_LEASE_SECONDS=30' >> .env; fi
if ! grep -q '^STATUS_NODE_MIN_FREE_MB=' .env; then echo 'STATUS_NODE_MIN_FREE_MB=150' >> .env; fi
if ! grep -q '^SERVICE_DOMAIN=' .env; then echo 'SERVICE_DOMAIN=status-hub.lol' >> .env; fi
if ! grep -q '^SUPPORT_URL=' .env; then echo 'SUPPORT_URL=' >> .env; fi
if ! grep -q '^DONATE_PAYPAL_URL=' .env; then echo 'DONATE_PAYPAL_URL=' >> .env; fi
if ! grep -q '^DONATE_KOFI_URL=' .env; then echo 'DONATE_KOFI_URL=' >> .env; fi
if ! grep -q '^DONATE_STRIPE_URL=' .env; then echo 'DONATE_STRIPE_URL=' >> .env; fi
if ! grep -q '^NODE_INSTALL_SCRIPT_URL=' .env; then echo 'NODE_INSTALL_SCRIPT_URL=https://raw.githubusercontent.com/testererrewr/wardogs-status-panel/main/install-node.sh' >> .env; fi
if ! grep -q '^STEAM_WEB_API_KEY=' .env; then echo 'STEAM_WEB_API_KEY=' >> .env; fi
mkdir -p data custom-bots
chown -R 1000:1000 data custom-bots
chmod 750 data custom-bots
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else COMPOSE=(docker-compose); fi
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
echo "==> Update complete"
echo "==> Enabled status bots restore automatically when the status node reconnects"
