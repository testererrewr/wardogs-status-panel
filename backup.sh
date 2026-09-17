#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
mkdir -p backups
chmod 700 backups
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/server-status-hub-${STAMP}.tar.gz"
tar -czf "$OUT" .env data custom-bots
chmod 600 "$OUT"
echo "Backup: $OUT"
echo "Enthält Secrets. Sicher und nicht öffentlich speichern."
