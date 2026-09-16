#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Bitte als root ausführen: sudo ./setup-vps.sh"
  exit 1
fi

cd "$(dirname "$0")"

echo "=== WARDOGS Status Panel - Debian VPS Setup ==="
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker fehlt. Installiere Docker aus den Debian-Paketquellen ..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose ca-certificates openssl
  systemctl enable --now docker
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose fehlt. Installiere docker-compose ..."
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
  COMPOSE=(docker-compose)
fi

read -r -p "Öffentliche Panel-URL (z.B. http://1.2.3.4 oder https://bots.example.com): " PUBLIC_URL
PUBLIC_URL="${PUBLIC_URL%/}"
if [[ ! "$PUBLIC_URL" =~ ^https?:// ]]; then
  echo "Fehler: URL muss mit http:// oder https:// beginnen."
  exit 1
fi

if [[ "$PUBLIC_URL" == https://* ]]; then
  COOKIE_SECURE=true
else
  COOKIE_SECURE=false
fi

read -r -p "Discord OAuth Client ID: " DISCORD_OAUTH_CLIENT_ID
read -r -s -p "Discord OAuth Client Secret: " DISCORD_OAUTH_CLIENT_SECRET
echo
read -r -p "Deine Discord User ID (Panel-Admin): " ADMIN_DISCORD_IDS

if [[ -z "$DISCORD_OAUTH_CLIENT_ID" || -z "$DISCORD_OAUTH_CLIENT_SECRET" ]]; then
  echo "Fehler: Discord OAuth Client ID und Client Secret dürfen nicht leer sein."
  exit 1
fi
if [[ ! "$ADMIN_DISCORD_IDS" =~ ^[0-9]{17,20}(,[0-9]{17,20})*$ ]]; then
  echo "Fehler: ADMIN Discord ID muss 17-20 Ziffern haben (mehrere ohne Leerzeichen mit Komma trennen)."
  exit 1
fi

SESSION_SECRET="$(openssl rand -hex 48)"
APP_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"

cat > .env <<ENVEOF
PUBLIC_URL=${PUBLIC_URL}
PORT=3000
SESSION_SECRET=${SESSION_SECRET}
APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}
DISCORD_OAUTH_CLIENT_ID=${DISCORD_OAUTH_CLIENT_ID}
DISCORD_OAUTH_CLIENT_SECRET=${DISCORD_OAUTH_CLIENT_SECRET}
ADMIN_DISCORD_IDS=${ADMIN_DISCORD_IDS}
TRUST_PROXY=true
COOKIE_SECURE=${COOKIE_SECURE}
ENVEOF
chmod 600 .env
mkdir -p data
chmod 700 data

echo
echo "Discord OAuth Redirect URI:"
echo "  ${PUBLIC_URL}/auth/discord/callback"
echo
echo "Diese URI MUSS im Discord Developer Portal unter OAuth2 -> Redirects eingetragen sein."
echo
read -r -p "Ist die Redirect URI bei Discord eingetragen? [j/N] " READY
if [[ ! "$READY" =~ ^[jJyY]$ ]]; then
  echo "Konfiguration gespeichert. Trage zuerst die Redirect URI ein und starte dann mit:"
  echo "  ${COMPOSE[*]} up -d --build"
  exit 0
fi

"${COMPOSE[@]}" up -d --build

echo
echo "Fertig. Panel: ${PUBLIC_URL}"
echo "Logs: ${COMPOSE[*]} logs -f wardogs-panel"
echo
if [[ "$PUBLIC_URL" == https://* ]]; then
  echo "Hinweis: Die Domain muss auf diesen VPS zeigen und TCP 80/443 müssen erreichbar sein."
else
  echo "Hinweis: Für öffentlichen Dauerbetrieb ist eine Domain mit HTTPS empfohlen."
fi
