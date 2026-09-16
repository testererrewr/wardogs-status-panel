#!/usr/bin/env bash
set -euo pipefail

# Verwendung:
#   sudo bash bootstrap.sh https://github.com/USER/REPO.git
# Optional anderes Ziel:
#   sudo bash bootstrap.sh https://github.com/USER/REPO.git /opt/wardogs-status-panel

REPO_URL="${1:-}"
INSTALL_DIR="${2:-/opt/wardogs-status-panel}"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Bitte als root ausführen: sudo bash bootstrap.sh <GITHUB_REPO_URL>"
  exit 1
fi

if [[ -z "$REPO_URL" ]]; then
  echo "Fehler: GitHub Repository URL fehlt."
  echo "Beispiel: sudo bash bootstrap.sh https://github.com/USER/wardogs-status-panel.git"
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y git ca-certificates curl

if [[ -e "$INSTALL_DIR" ]]; then
  echo "Fehler: Ziel existiert bereits: $INSTALL_DIR"
  echo "Für Updates im bestehenden Clone: cd '$INSTALL_DIR' && sudo ./update.sh"
  exit 1
fi

echo "==> Klone $REPO_URL nach $INSTALL_DIR ..."
git clone "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
chmod +x setup-vps.sh update.sh doctor.sh backup.sh bootstrap.sh

exec ./setup-vps.sh
