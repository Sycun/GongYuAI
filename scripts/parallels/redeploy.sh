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
git fetch "$REMOTE"
git pull --ff-only "$REMOTE" "$BRANCH"

pnpm install
pnpm --filter @gongyuai/contracts build
pnpm --filter @gongyuai/history build
pnpm --filter @gongyuai/control-plane build
pnpm --filter @gongyuai/worker build
pnpm --filter @gongyuai/console build

fuser -k 8877/tcp 2>/dev/null || true
sleep 1
nohup pnpm gy serve --host 0.0.0.0 --port 8877 >/tmp/gy-serve.log 2>&1 &
disown || true
sleep 4
curl -sf http://127.0.0.1:8877/health
echo
curl -sf http://127.0.0.1:8877/settings | head -c 400
echo
