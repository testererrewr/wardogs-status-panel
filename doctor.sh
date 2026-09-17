#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
echo "=== status-hub.lol Diagnose ==="
command -v docker >/dev/null && echo "[OK] Docker" || echo "[FEHLER] Docker fehlt"
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose); else echo "[FEHLER] Compose fehlt"; exit 1; fi
[[ -f .env ]] && echo "[OK] .env" || echo "[FEHLER] .env fehlt"
if [[ -f .env ]]; then
  grep -E '^(PUBLIC_URL|PANEL_BIND|COMPOSE_PROFILES|ALLOW_PUBLIC_REGISTRATION|SERVICE_DOMAIN|LOCAL_STATUS_NODE_MAX_BOTS|STATUS_NODE_MIN_FREE_MB)=' .env || true
fi
for d in data custom-bots; do
  mkdir -p "$d"
  echo "[$d] owner=$(stat -c '%u:%g' "$d" 2>/dev/null || echo '?') perms=$(stat -c '%a' "$d" 2>/dev/null || echo '?')"
done
echo; "${COMPOSE[@]}" ps || true
echo; echo "--- Panel Logs ---"; "${COMPOSE[@]}" logs --tail=80 server-status-hub 2>/dev/null || true
echo; echo "--- Local Status Node Logs ---"; "${COMPOSE[@]}" logs --tail=80 status-node 2>/dev/null || true
echo; echo "--- Runner Logs ---"; "${COMPOSE[@]}" logs --tail=50 runner 2>/dev/null || true

echo; echo "--- Security Check ---"; bash ./security-check.sh || true
