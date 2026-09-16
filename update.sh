#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo "Fehler: git ist nicht installiert."
  exit 1
fi

if [[ -d .git ]]; then
  if ! git diff --quiet -- . ':(exclude).env' ':(exclude)data'; then
    echo "Fehler: Es gibt lokale Änderungen an getrackten Dateien."
    echo "Bitte zuerst sichern/committen oder mit 'git status' prüfen."
    exit 1
  fi

  echo "==> Hole Updates von GitHub ..."
  git pull --ff-only
else
  echo "Hinweis: Dieser Ordner ist kein Git-Clone. Überspringe git pull."
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Fehler: Docker Compose wurde nicht gefunden."
  exit 1
fi

echo "==> Baue und starte Container ..."
"${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d --build --remove-orphans
"${COMPOSE[@]}" ps

echo "==> Update fertig."
