#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/parallels/.n/bin:/home/parallels/.npm-global/bin:${PATH:-}"
echo "WHOAMI=$(whoami)"
echo "PNPM=$(command -v pnpm || true)"
echo "GH=$(command -v gh || true)"
echo "GIT=$(command -v git || true)"
echo "NODE=$(command -v node || true)"
if [[ -d /home/parallels/GongYuAI/.git ]]; then
  echo "HAS_GIT=1"
  cd /home/parallels/GongYuAI
  git remote -v || true
  git status -sb | head -8 || true
else
  echo "HAS_GIT=0"
fi
gh auth status 2>&1 | head -12 || true
du -sh /home/parallels/GongYuAI.bak.1795257839 2>/dev/null || true
ls -la /home/parallels/Desktop
curl -sI --max-time 10 https://api.github.com | head -3
git ls-remote https://github.com/Sycun/GongYuAI.git HEAD 2>&1 | head -5 || true
