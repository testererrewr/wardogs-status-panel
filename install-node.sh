#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "Bitte als root ausführen."; exit 1; fi
CONTROL_PLANE_URL=${1:-}
JOIN_SECRET=${2:-}
CAPACITY=${3:-50}
NAME=${4:-$(hostname)}
REPO_URL=${REPO_URL:-https://github.com/testererrewr/wardogs-status-panel.git}
INSTALL_DIR=${INSTALL_DIR:-/opt/server-status-node}
if [[ -z "$CONTROL_PLANE_URL" || -z "$JOIN_SECRET" ]]; then
  echo "Nutzung: bash install-node.sh https://panel.example.com JOIN_SECRET [MAX_BOTS] [NAME]"; exit 1
fi
if [[ ! "$CONTROL_PLANE_URL" =~ ^https:// ]]; then
  echo "FEHLER: Remote Nodes übertragen Discord-Bot-Tokens. Benutze für die Control Plane HTTPS."; exit 1
fi
if ! command -v git >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git docker.io docker-compose ca-certificates
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose
fi
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
NODE_ID="node-$(cat /etc/machine-id 2>/dev/null | cut -c1-12 || hostname | tr -cd 'A-Za-z0-9-' | cut -c1-24)"
cat > .env.node <<ENVEOF
CONTROL_PLANE_URL=${CONTROL_PLANE_URL%/}
STATUS_NODE_JOIN_SECRET=${JOIN_SECRET}
STATUS_NODE_ID=${NODE_ID}
STATUS_NODE_NAME=${NAME}
STATUS_NODE_MAX_BOTS=${CAPACITY}
STATUS_NODE_SYNC_SECONDS=10
STATUS_NODE_ALLOW_INSECURE=false
ENVEOF
chmod 600 .env.node
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else COMPOSE=(docker-compose); fi
"${COMPOSE[@]}" --env-file .env.node -f compose.node.yaml up -d --build
"${COMPOSE[@]}" --env-file .env.node -f compose.node.yaml ps
echo
echo "Status Node installiert: ${NODE_ID} · ${NAME} · Kapazität ${CAPACITY}"
echo "Logs: cd ${INSTALL_DIR} && ${COMPOSE[*]} --env-file .env.node -f compose.node.yaml logs -f status-node"
