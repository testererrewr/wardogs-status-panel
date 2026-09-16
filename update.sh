#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Bitte als root ausführen: ./update.sh"; exit 1; fi
if ! command -v openssl >/dev/null 2>&1; then apt-get update && apt-get install -y openssl; fi
if [[ -d .git ]]; then
  if ! git diff --quiet -- . ':(exclude).env' ':(exclude)data' ':(exclude)custom-bots' ':(exclude)compose.override.yaml'; then
    echo "Lokale Änderungen an getrackten Dateien gefunden. git status prüfen."; exit 1
  fi
  echo "==> GitHub Update"; git pull --ff-only
fi
# Legacy v2: altes lokales Compose-Override entfernen, weil die Services in v3 anders heißen.
if [[ -f compose.override.yaml ]] && grep -q "wardogs-panel" compose.override.yaml; then
  mv compose.override.yaml "compose.override.yaml.v2-backup-$(date +%Y%m%d-%H%M%S)"
  echo "==> Legacy compose.override.yaml gesichert und deaktiviert"
fi

# Bestehende v2 .env automatisch um v3 Runner-Konfiguration ergänzen.
if [[ -f .env ]] && ! grep -q '^RUNNER_SHARED_SECRET=' .env; then
  echo "RUNNER_SHARED_SECRET=$(openssl rand -hex 48)" >> .env
fi
if [[ -f .env ]] && ! grep -q '^RUNNER_URL=' .env; then echo 'RUNNER_URL=http://runner:4000' >> .env; fi
if [[ -f .env ]] && ! grep -q '^ALLOW_PUBLIC_REGISTRATION=' .env; then echo 'ALLOW_PUBLIC_REGISTRATION=true' >> .env; fi
if [[ -f .env ]] && ! grep -q '^DEFAULT_STATUS_BOT_LIMIT=' .env; then echo 'DEFAULT_STATUS_BOT_LIMIT=1' >> .env; fi
if [[ -f .env ]] && ! grep -q '^CUSTOM_UPLOAD_MAX_MB=' .env; then echo 'CUSTOM_UPLOAD_MAX_MB=5' >> .env; fi
if [[ -f .env ]] && ! grep -q '^PANEL_BIND=' .env; then echo 'PANEL_BIND=0.0.0.0:3000' >> .env; fi

mkdir -p data custom-bots
chown -R 1000:1000 data custom-bots
chmod 750 data custom-bots
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else COMPOSE=(docker-compose); fi
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps
echo "==> Update fertig"
