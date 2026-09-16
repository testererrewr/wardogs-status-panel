#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/server-status-hub-${STAMP}.tar.gz"
tar -czf "$OUT" .env data custom-bots
echo "Backup: $OUT"
echo "Enthält Secrets. Sicher und nicht öffentlich speichern."
