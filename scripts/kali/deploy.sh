#!/usr/bin/env bash
# Kali 正式实例：从受验提交准备完整新目录、本机安装构建、受控切换（第七轮）。
#
# 拆成两段，权限边界清晰：
#   bash deploy.sh prepare <commit>   以 parallels 用户跑：备份 + clone + 安装 + 构建 + 迁移数据
#   sudo bash deploy.sh switch <commit>  以 root 跑：改单元指向新目录 + 重启 + 逐项核对 + 失败回退
#
# 原则：构建失败不碰正式入口；切换失败立即回退旧目录；旧程序目录先保留，
# 确认无进程/无数据引用后由调用方清理。
set -uo pipefail

# 非交互 shell 里 pnpm/node 不在 PATH：显式补上，与 systemd 单元里的 PATH 保持一致。
export PATH="/home/parallels/.npm-global/bin:/home/parallels/.n/bin:${PATH}"

ACTION=${1:?用法: deploy.sh prepare|switch <commit>}
COMMIT=${2:?用法: deploy.sh prepare|switch <commit>}
SHORT=${COMMIT:0:8}
OLD_DIR=/home/parallels/GongYuAI
NEW_DIR=/home/parallels/GongYuAI-${SHORT}
UNIT=gongyuai.service
PORT=8877
DATA_DIR_NAME=.gongyuai
OVERRIDE_DIR=/etc/systemd/system/${UNIT}.d
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/home/parallels/gongyuai-data-backup-${STAMP}.tar.gz
STATE=/tmp/gongyuai-deploy-${SHORT}.state
LOG=/tmp/gongyuai-deploy-${SHORT}-${ACTION}.log
: > "${LOG}"

log() { echo "[$(date -Is)] $*" | tee -a "${LOG}"; }

tasks_json() {
  curl -fsS -m 8 "http://127.0.0.1:${PORT}/tasks" 2>/dev/null || echo '{}'
}
tasks_count() {
  tasks_json | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("tasks",[])))' 2>/dev/null || echo '?'
}
wait_health() {
  for _ in $(seq 1 90); do
    curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
write_override() {
  local dir=$1
  mkdir -p "${OVERRIDE_DIR}"
  cat > "${OVERRIDE_DIR}/override.conf" <<EOF
[Service]
WorkingDirectory=${dir}
ExecStart=
ExecStart=/home/parallels/.npm-global/bin/pnpm gy serve --host 0.0.0.0 --port ${PORT} --data-dir ${dir}/${DATA_DIR_NAME}
EOF
  systemctl daemon-reload
}

prepare() {
  [ "$(id -u)" -ne 0 ] || { log "!! prepare 必须以 parallels 用户运行（不要用 sudo）"; exit 1; }
  log "== prepare: 现场 =="
  log "旧目录 HEAD=$(git -C "${OLD_DIR}" rev-parse HEAD 2>&1 | head -1)"
  log "旧目录未提交改动=$(git -C "${OLD_DIR}" status --porcelain 2>&1 | wc -l) 条"
  log "当前单元 active=$(systemctl is-active ${UNIT}) enabled=$(systemctl is-enabled ${UNIT})"
  log "当前任务数=$(tasks_count)"

  log "== prepare: 保护备份（配置 + 数据根）=="
  tar czf "${BACKUP}" -C "${OLD_DIR}" ${DATA_DIR_NAME} .env 2>/dev/null \
    || tar czf "${BACKUP}" -C "${OLD_DIR}" ${DATA_DIR_NAME}
  chmod 600 "${BACKUP}"
  log "备份 ${BACKUP} $(stat -c %s "${BACKUP}") 字节 sha256=$(sha256sum "${BACKUP}" | cut -d' ' -f1)"

  log "== prepare: 新目录 clone 到受验提交 =="
  rm -rf "${NEW_DIR}"
  git clone -q https://github.com/Sycun/GongYuAI.git "${NEW_DIR}" || { log "!! clone 失败"; exit 1; }
  git -C "${NEW_DIR}" checkout -q "${COMMIT}" || { log "!! checkout 失败"; exit 1; }
  NEW_HEAD=$(git -C "${NEW_DIR}" rev-parse HEAD)
  log "新目录 HEAD=${NEW_HEAD}（期望 ${COMMIT}）"
  [ "${NEW_HEAD}" = "${COMMIT}" ] || { log "!! 提交不一致"; exit 1; }
  log "新目录未提交改动=$(git -C "${NEW_DIR}" status --porcelain | wc -l) 条"

  log "== prepare: 本机安装与构建（parallels 用户）=="
  # 非交互 shell 里 pnpm 不在 PATH：用单元里那个绝对路径，保证与运行环境一致。
  ( cd "${NEW_DIR}" && /home/parallels/.npm-global/bin/pnpm install --frozen-lockfile >/tmp/gy-deploy-install.log 2>&1 ) \
    || { log "!! 安装失败，见 /tmp/gy-deploy-install.log"; exit 1; }
  ( cd "${NEW_DIR}" && /home/parallels/.npm-global/bin/pnpm run build >/tmp/gy-deploy-build.log 2>&1 ) \
    || { log "!! 构建失败，见 /tmp/gy-deploy-build.log"; exit 1; }
  log "构建产物 packages/control-plane/dist/server.js 时间=$(stat -c %y "${NEW_DIR}/packages/control-plane/dist/server.js" | cut -d. -f1)"

  log "== prepare: 迁移正式配置与数据根 =="
  cp -a "${OLD_DIR}/${DATA_DIR_NAME}" "${NEW_DIR}/${DATA_DIR_NAME}" || { log "!! 数据复制失败"; exit 1; }
  [ -f "${OLD_DIR}/.env" ] && cp -a "${OLD_DIR}/.env" "${NEW_DIR}/.env"
  log "新目录任务目录数=$(ls "${NEW_DIR}/${DATA_DIR_NAME}/tasks" | wc -l)"

  cat > "${STATE}" <<EOF
COMMIT=${COMMIT}
NEW_DIR=${NEW_DIR}
OLD_DIR=${OLD_DIR}
BACKUP=${BACKUP}
TASKS_BEFORE=$(tasks_count)
EOF
  log "== prepare 完成；下一步：sudo bash $0 switch ${COMMIT} =="
}

switch_to_new() {
  [ "$(id -u)" -eq 0 ] || { log "!! switch 需要 root"; exit 1; }
  [ -f "${STATE}" ] || { log "!! 缺少 ${STATE}，先跑 prepare"; exit 1; }
  # shellcheck disable=SC1090
  . "${STATE}"
  log "== switch: 切换单元到 ${NEW_DIR} =="
  log "切换前任务数=$(tasks_count)（prepare 记录 ${TASKS_BEFORE}）"
  cp -a "/etc/systemd/system/${UNIT}" "/tmp/${UNIT}.bak-${STAMP}" 2>/dev/null || true
  write_override "${NEW_DIR}"
  systemctl restart "${UNIT}"
  if ! wait_health; then
    log "!! 新目录实例未健康，回退到 ${OLD_DIR}"
    write_override "${OLD_DIR}"
    systemctl restart "${UNIT}"
    wait_health && log "已回退，旧目录实例健康" || log "!! 回退后仍不健康，需人工处理"
    exit 1
  fi
  sleep 2

  log "== switch: 核对 =="
  log "单元 active=$(systemctl is-active ${UNIT}) sub=$(systemctl show -p SubState --value ${UNIT}) enabled=$(systemctl is-enabled ${UNIT})"
  systemctl show -p MainPID -p WorkingDirectory -p User "${UNIT}" | tee -a "${LOG}"
  LISTENER=$(ss -ltnpH "sport = :${PORT}" | grep -oP 'pid=\K[0-9]+' | sort -u)
  UNIT_CG=$(systemctl show -p ControlGroup --value "${UNIT}")
  FAIL=0
  for pid in ${LISTENER}; do
    cg=$(tr '\n' ' ' < "/proc/${pid}/cgroup")
    cwd=$(readlink -f "/proc/${pid}/cwd")
    cmd=$(tr '\0' ' ' < "/proc/${pid}/cmdline")
    log "监听 pid=${pid} cwd=${cwd} cgroup=${cg}"
    echo "${cmd}" | grep -q -- "--data-dir ${NEW_DIR}/${DATA_DIR_NAME}" || { log "!! 数据目录参数不对"; FAIL=1; }
    [ "${cwd}" = "${NEW_DIR}" ] || { log "!! 监听进程 cwd 不是新目录"; FAIL=1; }
    echo "${cg}" | grep -q "${UNIT_CG}" || { log "!! 监听进程不在单元 cgroup"; FAIL=1; }
  done
  [ -n "${LISTENER}" ] || { log "!! 没有监听进程"; FAIL=1; }
  AFTER=$(tasks_count)
  log "切换后任务数=${AFTER}（切换前 ${TASKS_BEFORE}）"
  [ "${AFTER}" = "${TASKS_BEFORE}" ] || { log "!! 任务数变化"; FAIL=1; }
  log "health=$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" | tr -d '\n ')"

  if [ "${FAIL}" = "0" ]; then
    log "结论：切换通过（新目录 ${NEW_DIR} 由 systemd 托管；旧目录 ${OLD_DIR} 保留待清理）"
  else
    log "结论：核对存在失败项，保留旧目录 ${OLD_DIR} 以便回退"
  fi
  exit "${FAIL}"
}

case "${ACTION}" in
  prepare) prepare ;;
  switch) switch_to_new ;;
  *) echo "用法: deploy.sh prepare|switch <commit>"; exit 2 ;;
esac
