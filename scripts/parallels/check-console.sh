#!/usr/bin/env bash
# Smoke-check GongYuAI console on :8877 (run inside Parallels).
set -euo pipefail
export PATH="/home/parallels/.n/bin:${PATH:-}"

echo "=== HTML ==="
curl -sf http://127.0.0.1:8877/
echo
echo "=== HEALTH ==="
curl -sf http://127.0.0.1:8877/health
echo
ASSET=$(curl -sf http://127.0.0.1:8877/ | sed -n 's/.*src="\([^"]*\.js\)".*/\1/p' | head -1)
echo "ASSET=$ASSET"
curl -sI "http://127.0.0.1:8877$ASSET" | head -5
CSS=$(curl -sf http://127.0.0.1:8877/ | sed -n 's/.*href="\([^"]*\.css\)".*/\1/p' | head -1)
echo "CSS=$CSS"
curl -sI "http://127.0.0.1:8877$CSS" | head -5
