#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
FAIL=0

ok(){ printf '  [OK] %s\n' "$1"; }
warn(){ printf '  [!!] %s\n' "$1"; FAIL=1; }

echo "WARDOGS Panel Diagnose"
echo

if command -v docker >/dev/null 2>&1; then ok "Docker gefunden"; else warn "Docker fehlt"; fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose); ok "docker compose verfügbar"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose); ok "docker-compose verfügbar"
else
  warn "Docker Compose fehlt"
  COMPOSE=()
fi

if [[ -f .env ]]; then
  ok ".env vorhanden"
else
  warn ".env fehlt (setup-vps.sh ausführen)"
fi

if [[ -f .env ]]; then
  PUBLIC_URL="$(grep -E '^PUBLIC_URL=' .env | head -1 | cut -d= -f2-)"
  CLIENT_ID="$(grep -E '^DISCORD_OAUTH_CLIENT_ID=' .env | head -1 | cut -d= -f2-)"
  ADMIN_IDS="$(grep -E '^ADMIN_DISCORD_IDS=' .env | head -1 | cut -d= -f2-)"
  [[ "$PUBLIC_URL" =~ ^https?:// ]] && ok "PUBLIC_URL: $PUBLIC_URL" || warn "PUBLIC_URL ungültig"
  [[ -n "$CLIENT_ID" ]] && ok "Discord OAuth Client ID gesetzt" || warn "Discord OAuth Client ID fehlt"
  [[ -n "$ADMIN_IDS" ]] && ok "Mindestens ein Panel-Admin gesetzt" || warn "ADMIN_DISCORD_IDS fehlt"
  echo "  OAuth Redirect: ${PUBLIC_URL%/}/auth/discord/callback"
fi

if ((${#COMPOSE[@]})); then
  if "${COMPOSE[@]}" config >/dev/null 2>&1; then ok "Compose-Konfiguration gültig"; else warn "Compose-Konfiguration ungültig"; fi
  echo
  "${COMPOSE[@]}" ps 2>/dev/null || true
  echo
  if "${COMPOSE[@]}" logs --tail=25 wardogs-panel 2>/dev/null; then :; fi
fi

exit "$FAIL"
