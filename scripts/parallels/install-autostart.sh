#!/usr/bin/env bash
# Install / enable GongYuAI systemd unit on Kali (run as parallels with sudo).
# Usage: sudo bash scripts/parallels/install-autostart.sh
set -euo pipefail

GY="${GONGYUAI_ROOT:-/home/parallels/GongYuAI}"
UNIT_SRC="$GY/scripts/parallels/gongyuai.service"
UNIT_DST=/etc/systemd/system/gongyuai.service

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi
if [[ ! -f "$UNIT_SRC" ]]; then
  echo "missing $UNIT_SRC" >&2
  exit 1
fi

install -m 0644 "$UNIT_SRC" "$UNIT_DST"
# Retire stale unit that pointed at a missing binary on :8082
systemctl disable --now dsh-gongyuai.service 2>/dev/null || true

# Free :8877 if a leftover nohup serve is holding it
fuser -k 8877/tcp 2>/dev/null || true
sleep 1

systemctl daemon-reload
systemctl enable --now gongyuai.service
sleep 3
systemctl --no-pager --full status gongyuai.service || true
curl -sf http://127.0.0.1:8877/health
echo
echo "OK: gongyuai.service enabled (WantedBy=multi-user.target)"
echo "Physical host URL (Parallels Shared): http://10.211.55.5:8877/"
