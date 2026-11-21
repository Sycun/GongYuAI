#!/usr/bin/env bash
# One-shot: replace share/rsync tree with a clean GitHub clone at /home/parallels/GongYuAI.
# Preserves local .gongyuai / .env. Moves Desktop GongYuAI* into .gongyuai/from-desktop/.
set -euo pipefail
export PATH="/home/parallels/.n/bin:/home/parallels/.npm-global/bin:/home/parallels/.local/bin:${PATH:-}"

GY=/home/parallels/GongYuAI
REPO=https://github.com/Sycun/GongYuAI.git
STAMP=$(date +%s)
OLD="${GY}.pre-github.${STAMP}"
TMP="${GY}.clone.${STAMP}"

if ! command -v git >/dev/null; then
  echo "git required" >&2
  exit 1
fi

echo "clone $REPO -> $TMP"
git clone --branch main "$REPO" "$TMP"

if [[ -d "$GY" ]]; then
  echo "preserve runtime from existing $GY"
  if [[ -d "$GY/.gongyuai" ]]; then
    rm -rf "$TMP/.gongyuai"
    cp -a "$GY/.gongyuai" "$TMP/.gongyuai"
  fi
  if [[ -f "$GY/.env" ]]; then
    cp -a "$GY/.env" "$TMP/.env"
  fi
  echo "rename $GY -> $OLD"
  mv "$GY" "$OLD"
fi

mv "$TMP" "$GY"

# Desktop clutter belonging to this project
DESK=/home/parallels/Desktop
INBOX="$GY/.gongyuai/from-desktop"
mkdir -p "$INBOX"
for name in GongYuAI-demo-report.md GongYuAI-task.json GongYuAI-evidence; do
  if [[ -e "$DESK/$name" ]]; then
    echo "move Desktop/$name -> $INBOX/"
    mv "$DESK/$name" "$INBOX/"
  fi
done

cd "$GY"
pnpm install
pnpm --filter @gongyuai/contracts build
pnpm --filter @gongyuai/history build
pnpm --filter @gongyuai/control-plane build
pnpm --filter @gongyuai/worker build
pnpm --filter @gongyuai/console build

DATA_DIR="$GY/.gongyuai"
# Absorb any leftover ~/.gongyuai tasks before first serve (boot also migrates).
if [[ -d /home/parallels/.gongyuai/tasks && ! -d "$DATA_DIR/tasks" ]]; then
  mkdir -p "$DATA_DIR"
fi

fuser -k 8877/tcp 2>/dev/null || true
sleep 1
nohup pnpm gy serve --host 0.0.0.0 --port 8877 --data-dir "$DATA_DIR" >/tmp/gy-serve.log 2>&1 &
disown || true
sleep 4
curl -sf http://127.0.0.1:8877/health
echo

echo "OK: $GY is a git checkout. data-dir=$DATA_DIR"
echo "Old tree kept at $OLD (delete after you confirm)."
echo "Also removable when confirmed: /home/parallels/GongYuAI.bak.*"
