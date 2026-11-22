#!/usr/bin/env bash
# 验收校验器的五个单点负例（第七轮验收项 3）。
#
# 每个负例只改一处，然后跑一次正常入口的校验命令，要求：
# 1. 退出码非零；2. 输出里准确指出失败字段；3. 未改动的原件仍然通过。
#
# 用法：bash scripts/validator-negatives.sh <acceptance-run-dir> <expect-commit> [out.txt]
set -uo pipefail

RUN_DIR=${1:?用法: validator-negatives.sh <run-dir> <expect-commit> [out.txt]}
EXPECT=${2:?用法: validator-negatives.sh <run-dir> <expect-commit> [out.txt]}
OUT=${3:-docs/evidence/acceptance/validator-negatives.txt}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/gy-negatives-XXXXXX")
VERIFY="node --import tsx scripts/acceptance-verify.ts"
: > "${OUT}"
FAILED=0

say() { echo "$*" | tee -a "${OUT}"; }

run_case() {
  local name=$1 mutate=$2
  local dir="${WORK}/${name}"
  cp -R "${RUN_DIR}" "${dir}"
  python3 - "${dir}" "${mutate}" <<'PY'
import json, sys, subprocess, os
d, mode = sys.argv[1], sys.argv[2]
mp = os.path.join(d, "acceptance-manifest.json")
m = json.load(open(mp))
if mode == "zero-sha":
    m["code"]["commit"] = "0" * 40
elif mode.startswith("other-commit:"):
    m["code"]["commit"] = mode.split(":", 1)[1]
elif mode == "dirty":
    m["code"]["dirty"] = True
    m["code"]["dirtyPaths"] = ["packages/contracts/src/reconcile.ts"]
elif mode == "coverage-99":
    m["scorecard"]["coverage"] = {**m["scorecard"]["coverage"], "tested": 99}
elif mode == "failed-step":
    rp = os.path.join(d, "acceptance-record.json")
    r = json.load(open(rp))
    if r.get("steps"):
        r["steps"][0]["ok"] = False
        r["steps"][0]["detail"] = "人为注入的失败步骤（负例）"
    json.dump(r, open(rp, "w"), ensure_ascii=False, indent=2)
    open(rp, "a").write("\n")
json.dump(m, open(mp, "w"), ensure_ascii=False, indent=2)
open(mp, "a").write("\n")
PY
  say ""
  say "### 负例 ${name}（只改这一处）"
  local log="${WORK}/${name}.out"
  # shellcheck disable=SC2086
  ${VERIFY} "${dir}" --expect-commit "${EXPECT}" > "${log}" 2>&1
  local code=$?
  say "退出码　${code}"
  grep -E "^FAIL" "${log}" | tee -a "${OUT}"
  if [ "${code}" -eq 0 ]; then
    say "!! 该负例没有被拦住"
    FAILED=1
  fi
}

say "# 验收校验器负例（$(date -u +%Y-%m-%dT%H:%M:%SZ) UTC）"
say "原运行目录　${RUN_DIR}"
say "期望受验提交　${EXPECT}"
say ""
say "## 原件必须先通过"
# shellcheck disable=SC2086
${VERIFY} "${RUN_DIR}" --expect-commit "${EXPECT}" > "${WORK}/original.out" 2>&1
ORIG=$?
say "退出码　${ORIG}（期望 0）"
grep -cE "^PASS" "${WORK}/original.out" | xargs -I{} echo "通过项　{}" | tee -a "${OUT}"
[ "${ORIG}" -eq 0 ] || { say "!! 原件未通过"; FAILED=1; }

run_case "zero-sha" "zero-sha"
run_case "other-commit" "other-commit:$(git rev-parse HEAD~1 2>/dev/null || echo "")"
run_case "dirty" "dirty"
run_case "coverage-99" "coverage-99"
run_case "failed-step" "failed-step"

say ""
if [ "${FAILED}" = "0" ]; then say "结论：五个负例全部非零退出并指出失败字段；原件通过。"; else say "结论：存在未被拦住的负例。"; fi
rm -rf "${WORK}"
exit "${FAILED}"
