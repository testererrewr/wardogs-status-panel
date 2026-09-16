@echo off
cd /d "%~dp0"
if not exist .env (
  echo FEHLER: .env fehlt. Kopiere zuerst .env.example nach .env und trage die Werte ein.
  pause
  exit /b 1
)
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo npm install ist fehlgeschlagen.
  pause
  exit /b 1
)
call npm start
if errorlevel 1 (
  echo.
  echo Das Panel wurde mit einem Fehler beendet.
  pause
  exit /b 1
)
