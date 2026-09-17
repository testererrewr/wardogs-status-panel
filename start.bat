@echo off
cd /d %~dp0
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop wird fuer status-hub.lol benoetigt.
  pause
  exit /b 1
)
docker compose up -d --build
if errorlevel 1 pause
