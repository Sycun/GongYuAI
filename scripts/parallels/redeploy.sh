#!/usr/bin/env bash
# Run inside Kali. Pull from GitHub private origin, rebuild, restart serve on :8877.
# Host develops in /Users/sycpro/GongYuAI and pushes; this VM only pulls — no Parallels share / Downloads sync.
set -euo pipefail
export PATH="/home/parallels/.n/bin:/home/parallels/.npm-global/bin:/home/parallels/.local/bin:${PATH:-}"

GY=/home/parallels/GongYuAI
BRANCH="${GONGYUAI_BRANCH:-main}"
REMOTE="${GONGYUAI_REMOTE:-origin}"

if [[ ! -d "$GY/.git" ]]; then
  echo "missing git checkout at $GY (expected clone of Sycun/GongYuAI)" >&2
  exit 1
fi

cd "$GY"
echo "pull $REMOTE/$BRANCH -> $GY"
BEFORE=$(git rev-parse HEAD)
git fetch "$REMOTE"
git pull --ff-only "$REMOTE" "$BRANCH"
AFTER=$(git rev-parse HEAD)
# Script may have changed on pull; re-exec so restart logic is never stale.
if [[ "$BEFORE" != "$AFTER" && "${GONGYUAI_REDEPLOY_REEXEC:-}" != "1" ]]; then
  export GONGYUAI_REDEPLOY_REEXEC=1
  exec bash "$GY/scripts/parallels/redeploy.sh"
fi

pnpm install
pnpm run build

DATA_DIR="$GY/.gongyuai"
restart_nohup() {
  fuser -k 8877/tcp 2>/dev/null || true
  sleep 1
  nohup pnpm gy serve --host 0.0.0.0 --port 8877 --data-dir "$DATA_DIR" >/tmp/gy-serve.log 2>&1 &
  disown || true
}

# Prefer systemd when passwordless restart works; otherwise fall back to nohup.
if systemctl cat gongyuai.service >/dev/null 2>&1 && sudo -n systemctl restart gongyuai.service; then
  echo "restarted gongyuai.service"
else
  echo "restart via nohup (data-dir=$DATA_DIR)"
  restart_nohup
fi
sleep 4
curl -sf http://127.0.0.1:8877/health
echo
curl -sf http://127.0.0.1:8877/tasks | head -c 200
echo
curl -sf http://127.0.0.1:8877/settings | head -c 400
echo
