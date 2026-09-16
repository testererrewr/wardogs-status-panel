#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Run as root: bash ./setup-paypal.sh"; exit 1; fi
cd "$(dirname "$0")"
[[ -f .env ]] || { echo ".env not found"; exit 1; }
read -r -p "PayPal mode [sandbox/live] [sandbox]: " MODE
MODE=${MODE:-sandbox}
[[ "$MODE" == "live" || "$MODE" == "sandbox" ]] || { echo "Invalid mode"; exit 1; }
read -r -p "PayPal Client ID: " CLIENT_ID
read -r -s -p "PayPal Client Secret: " CLIENT_SECRET; echo
[[ -n "$CLIENT_ID" && -n "$CLIENT_SECRET" ]] || { echo "Credentials missing"; exit 1; }
set_env(){
  local key="$1" value="$2" escaped
  escaped=${value//\\/\\\\}; escaped=${escaped//&/\\&}; escaped=${escaped//#/\\#}
  if grep -q "^${key}=" .env; then sed -i "s#^${key}=.*#${key}=${escaped}#" .env; else printf '%s=%s\n' "$key" "$value" >> .env; fi
}
set_env PAYPAL_MODE "$MODE"
set_env PAYPAL_CLIENT_ID "$CLIENT_ID"
set_env PAYPAL_CLIENT_SECRET "$CLIENT_SECRET"
chmod 600 .env
if docker compose version >/dev/null 2>&1; then docker compose up -d --force-recreate server-status-hub; else docker-compose up -d --force-recreate server-status-hub; fi
echo "PayPal credentials saved. Open Admin > Settings and run PayPal setup/test."
