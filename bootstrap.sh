#!/usr/bin/env bash
set -euo pipefail
REPO_URL=${1:-}
DEST=${2:-/opt/server-status-hub}
if [[ -z "$REPO_URL" ]]; then echo "Usage: sudo ./bootstrap.sh https://github.com/USER/REPO.git [/opt/server-status-hub]"; exit 1; fi
apt-get update && apt-get install -y git
if [[ -d "$DEST/.git" ]]; then cd "$DEST" && git pull --ff-only; else git clone "$REPO_URL" "$DEST"; fi
cd "$DEST" && chmod +x *.sh && ./setup-vps.sh
