#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
echo "=== status-hub.lol Security Check ==="
fail=0
warn=0
val(){ grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2-; }
check_perm(){ local f="$1" expected="$2"; [[ -e "$f" ]] || return 0; local p; p=$(stat -c '%a' "$f" 2>/dev/null || echo '?'); if [[ "$p" == "$expected" ]]; then echo "[OK] $f permissions: $p"; else echo "[WARN] $f permissions: $p (recommended $expected)"; warn=$((warn+1)); fi; }
if [[ ! -f .env ]]; then echo '[FAIL] .env missing'; exit 1; fi
check_perm .env 600
PUBLIC_URL=$(val PUBLIC_URL); PANEL_BIND=$(val PANEL_BIND); TRUST_PROXY=$(val TRUST_PROXY); COOKIE_SECURE=$(val COOKIE_SECURE)
if [[ "$PUBLIC_URL" == https://* ]]; then echo '[OK] HTTPS public URL'; else echo '[WARN] PUBLIC_URL is not HTTPS'; warn=$((warn+1)); fi
if [[ "$PUBLIC_URL" == https://* && "$PANEL_BIND" == 127.0.0.1:* ]]; then echo '[OK] panel only bound to loopback behind proxy'; elif [[ "$PUBLIC_URL" == https://* ]]; then echo "[WARN] HTTPS configured but PANEL_BIND=$PANEL_BIND; prefer 127.0.0.1:3000 when the included local proxy is used"; warn=$((warn+1)); fi
if [[ "$TRUST_PROXY" == true && "$PUBLIC_URL" != https://* ]]; then echo '[WARN] TRUST_PROXY=true without HTTPS proxy setup'; warn=$((warn+1)); fi
if [[ "$PUBLIC_URL" == https://* && "$COOKIE_SECURE" != true ]]; then echo '[FAIL] HTTPS configured but COOKIE_SECURE is not true'; fail=$((fail+1)); else echo '[OK] cookie transport setting'; fi
for d in data custom-bots backups; do [[ -d "$d" ]] && echo "[INFO] $d permissions: $(stat -c '%a' "$d" 2>/dev/null || echo '?')"; done
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Ports}} {{.Names}}' | grep -E '(^|,)0\.0\.0\.0:4000|:::4000' >/dev/null; then echo '[FAIL] runner port 4000 is publicly published'; fail=$((fail+1)); else echo '[OK] runner port 4000 is not publicly published'; fi
fi
if command -v ufw >/dev/null 2>&1; then echo "[INFO] UFW: $(TERM=dumb ufw status 2>/dev/null | head -n1)"; fi
echo "Result: $fail failure(s), $warn warning(s)"
exit $(( fail > 0 ? 1 : 0 ))
