#!/usr/bin/env bash
# Run inside Parallels Ubuntu/Kali. Syncs host GongYuAI via Shared Folder, rebuilds, restarts serve.
set -euo pipefail
export PATH="/home/parallels/.n/bin:/home/parallels/.npm-global/bin:${PATH:-}"
GY=/home/parallels/GongYuAI
SRC=/media/psf/Home/GongYuAI

if [[ ! -d "$SRC" ]]; then
  echo "missing shared source: $SRC" >&2
  exit 1
fi

rsync -a --delete \
  --exclude node_modules \
  --exclude .gongyuai \
  --exclude .git \
  --exclude out \
  --exclude '.env' \
  "$SRC/" "$GY/"

cd "$GY"
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
