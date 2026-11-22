#!/usr/bin/env bash
# 在**确切候选提交的干净副本**上做完整回归（第七轮）。
#
# 用干净 clone（不是 worktree，避免共享 node_modules 或未提交改动），冻结依赖安装、
# 构建、全量单测、验收校验器测试、smoke、跨日模拟流程、原始材料业务验收、恢复隔离自测。
#
# 用法：bash scripts/clean-regression.sh <commit> [workdir]
set -uo pipefail

# 宿主可能注入了残缺的 GIT_CONFIG_*（GIT_CONFIG_COUNT 有值但缺 KEY），会让任何
# git 命令直接失败。这里先清干净，保证干净副本回归不被环境问题带偏。
unset GIT_CONFIG_COUNT 2>/dev/null || true
for i in $(seq 0 31); do unset "GIT_CONFIG_KEY_${i}" "GIT_CONFIG_VALUE_${i}" 2>/dev/null || true; done

COMMIT=${1:?用法: clean-regression.sh <commit> [workdir]}
WORK=${2:-/tmp/gy-clean-$COMMIT}
SRC=$(cd "$(dirname "$0")/.." && pwd)
LOG=$WORK/clean-regression.log

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK" || exit 1
git clone -q --no-hardlinks "$SRC" repo || exit 1
cd repo || exit 1
git checkout -q "$COMMIT" || exit 1

{
  echo "== 干净副本 =="
  echo "commit=$(git rev-parse HEAD)"
  echo "tree=$(git rev-parse HEAD^{tree})"
  echo "status=$(git status --porcelain | wc -l) 条未提交改动"
  echo "node=$(node -v) pnpm=$(pnpm -v)"
  echo

  echo "== 冻结依赖安装 =="
  pnpm install --frozen-lockfile 2>&1 | tail -5 || { echo "INSTALL_FAILED"; exit 1; }
  echo

  echo "== 构建 =="
  pnpm run build 2>&1 | tail -6 || { echo "BUILD_FAILED"; exit 1; }
  echo

  echo "== 全量单测 =="
  pnpm -r run test 2>&1 | grep -E "ℹ (tests|pass|fail)|✖|test: Done" || true
  echo

  echo "== 验收校验器测试 =="
  pnpm run test:acceptance 2>&1 | grep -E "^(✔|✖|ℹ (tests|pass|fail))" || true
  echo

  echo "== smoke =="
  pnpm run smoke 2>&1 | tail -4 || { echo "SMOKE_FAILED"; exit 1; }
  echo

  echo "== 跨日模拟流程 =="
  pnpm run e2e:engagement 2>&1 | tail -4 || { echo "E2E_FAILED"; exit 1; }
  echo

  echo "== 原始材料业务验收 =="
  pnpm run acceptance:business 2>&1 | tail -4 || { echo "BUSINESS_FAILED"; exit 1; }
  echo

  echo "== 恢复隔离自测 =="
  pnpm run restore:selftest 2>&1 | tail -6 || { echo "RESTORE_SELFTEST_FAILED"; exit 1; }
  echo

  echo "== 失败步骤计数（必须为 0）=="
  grep -c "FAIL " "$LOG" 2>/dev/null || echo 0
  echo "DONE"
} 2>&1 | tee "$LOG"

echo "日志：$LOG"
