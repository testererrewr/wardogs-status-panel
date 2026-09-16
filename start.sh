#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data custom-bots
if [[ ${EUID:-$(id -u)} -eq 0 ]]; then chown -R 1000:1000 data custom-bots; fi
if docker compose version >/dev/null 2>&1; then docker compose up -d --build; else docker-compose up -d --build; fi
