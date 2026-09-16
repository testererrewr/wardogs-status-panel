#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
tar -czf "backups/wardogs-${STAMP}.tar.gz" .env data
chmod 600 "backups/wardogs-${STAMP}.tar.gz"
echo "Backup erstellt: backups/wardogs-${STAMP}.tar.gz"
