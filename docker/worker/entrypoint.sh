#!/usr/bin/env bash
set -euo pipefail
exec node /opt/gongyuai/packages/worker/dist/main.js --manifest "${GY_MANIFEST:-/task/manifest.json}"
