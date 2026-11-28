#!/usr/bin/env bash
# 在**确切候选提交的干净副本**上做完整回归（第七轮）。
#
# 用干净 clone（不是 worktree，避免共享 node_modules 或未提交改动），冻结依赖安装、
# 构建、全量单测（含 Go sidecar 与脚本单测）、验收校验器测试、smoke、跨日模拟流程、
# 原始材料业务验收、恢复隔离自测。任何一步非零退出都会记入 FAIL 计数并使脚本以非零状态退出。
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

STEP_TMP=$WORK/step.out
FAIL_COUNT=0

run_fatal_step() {
  local label=$1
  shift
  echo "== ${label} =="
  if "$@" >"$STEP_TMP" 2>&1; then
    tail -6 "$STEP_TMP"
    echo "PASS ${label}"
  else
    local code=$?
    tail -30 "$STEP_TMP"
    echo "FAIL ${label} (exit=${code})"
    exit "$code"
  fi
  echo
}

run_check_step() {
  local label=$1
  local mode=$2
  shift 2
  echo "== ${label} =="
  if "$@" >"$STEP_TMP" 2>&1; then
    if [ "$mode" = "test-summary" ]; then
      grep -E "^(✔|✖|ok |[[:space:]]*--- FAIL)|ℹ (tests|pass|fail)|test: Done" "$STEP_TMP" || tail -6 "$STEP_TMP"
    else
      tail -6 "$STEP_TMP"
    fi
    echo "PASS ${label}"
  else
    local code=$?
    tail -40 "$STEP_TMP"
    echo "FAIL ${label} (exit=${code})"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  echo
}

{
  echo "== 干净副本 =="
  echo "commit=$(git rev-parse HEAD)"
  echo "tree=$(git rev-parse HEAD^{tree})"
  echo "status=$(git status --porcelain | wc -l | tr -d ' ') 条未提交改动"
  echo "node=$(node -v) pnpm=$(pnpm -v)"
  echo

  run_fatal_step "冻结依赖安装" pnpm install --frozen-lockfile
  run_fatal_step "构建" pnpm run build
  run_check_step "类型检查" "tail" pnpm run typecheck
  run_check_step "全量单测（Workspace + Scripts + Go netd）" "test-summary" pnpm run test
  run_check_step "验收校验器测试" "test-summary" pnpm run test:acceptance
  run_check_step "smoke" "tail" pnpm run smoke
  run_check_step "跨日模拟流程" "tail" pnpm run e2e:engagement
  run_check_step "原始材料业务验收" "tail" pnpm run acceptance:business
  run_check_step "首次通过绑定输入版本验收（A/B 反例）" "tail" pnpm run acceptance:firstpass
  run_check_step "恢复隔离自测" "tail" pnpm run restore:selftest

  echo "== 失败步骤计数（必须为 0）=="
  echo "$FAIL_COUNT"
  if [ "$FAIL_COUNT" -ne 0 ]; then
    echo "REGRESSION_FAILED: ${FAIL_COUNT} step(s) failed"
    exit 1
  fi
  echo "DONE"
} 2>&1 | tee "$LOG"

PIPE_RC=${PIPESTATUS[0]}
rm -f "$STEP_TMP"
echo "日志：$LOG"
exit "$PIPE_RC"
