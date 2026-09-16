#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "FEHLER: .env fehlt. Kopiere .env.example nach .env und trage die Werte ein."
  exit 1
fi
npm install --no-audit --no-fund
exec npm start
