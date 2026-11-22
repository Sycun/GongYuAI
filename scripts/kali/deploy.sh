#!/usr/bin/env bash
# Kali 正式实例：从受验提交准备完整新目录、本机安装构建、受控切换（第七轮）。
#
# 原则：
# 1. 切换前另取独立保护备份（配置 + 数据根）；
# 2. 新目录完整安装构建，构建失败不碰正式入口；
# 3. 系统单元用 drop-in 覆盖指向新目录，重启后逐项核对；
# 4. 核对不过立即回退到旧目录并重启，正式入口不掉；
# 5. 旧程序目录先保留，确认无进程/无数据引用后再由调用方清理。
#
# 用法：bash scripts/kali/deploy.sh <commit>
set -uo pipefail

COMMIT=${1:?用法: deploy.sh <commit>}
SHORT=${COMMIT:0:8}
OLD_DIR=/home/parallels/GongYuAI
NEW_DIR=/home/parallels/GongYuAI-${SHORT}
UNIT=gongyuai.service
PORT=8877
DATA_DIR_NAME=.gongyuai
OVERRIDE_DIR=/etc/systemd/system/${UNIT}.d
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/home/parallels/gongyuai-data-backup-${STAMP}.tar.gz
LOG=/tmp/gongyuai-deploy-${SHORT}.log
: > "${LOG}"

log() { echo "[$(date -Is)] $*" | tee -a "${LOG}"; }

tasks_count() {
  curl -fsS -m 8 "http://127.0.0.1:${PORT}/tasks" 2>/dev/null \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["tasks"]))' 2>/dev/null || echo '?'
}

wait_health() {
  for _ in $(seq 1 90); do
    if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then return 0; fi
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

log "== 0. 现场 =="
log "旧目录 ${OLD_DIR} HEAD=$(git -C "${OLD_DIR}" rev-parse HEAD 2>&1 | head -1)"
log "旧目录改动=$(git -C "${OLD_DIR}" status --porcelain 2>&1 | wc -l) 条"
log "当前单元 active=$(systemctl is-active ${UNIT}) enabled=$(systemctl is-enabled ${UNIT})"
log "当前任务数=$(tasks_count)"

log "== 1. 保护备份（配置 + 数据根）=="
tar czf "${BACKUP}" -C "${OLD_DIR}" ${DATA_DIR_NAME} .env 2>/dev/null || tar czf "${BACKUP}" -C "${OLD_DIR}" ${DATA_DIR_NAME}
chmod 600 "${BACKUP}"
log "备份 ${BACKUP} $(stat -c %s "${BACKUP}") 字节 sha256=$(sha256sum "${BACKUP}" | cut -d' ' -f1)"

log "== 2. 新目录 clone 到受验提交 =="
rm -rf "${NEW_DIR}"
git clone -q https://github.com/Sycun/GongYuAI.git "${NEW_DIR}" || { log "!! clone 失败"; exit 1; }
git -C "${NEW_DIR}" checkout -q "${COMMIT}" || { log "!! checkout ${COMMIT} 失败"; exit 1; }
NEW_HEAD=$(git -C "${NEW_DIR}" rev-parse HEAD)
log "新目录 HEAD=${NEW_HEAD}（期望 ${COMMIT}）"
[ "${NEW_HEAD}" = "${COMMIT}" ] || { log "!! 提交不一致"; exit 1; }
log "新目录改动=$(git -C "${NEW_DIR}" status --porcelain | wc -l) 条"

log "== 3. 本机安装与构建 =="
( cd "${NEW_DIR}" && pnpm install --frozen-lockfile >/tmp/gy-deploy-install.log 2>&1 ) || { log "!! 安装失败，见 /tmp/gy-deploy-install.log"; exit 1; }
( cd "${NEW_DIR}" && pnpm run build >/tmp/gy-deploy-build.log 2>&1 ) || { log "!! 构建失败，见 /tmp/gy-deploy-build.log"; exit 1; }
log "安装与构建完成（日志 /tmp/gy-deploy-install.log、/tmp/gy-deploy-build.log）"

log "== 4. 迁移正式配置与数据根 =="
cp -a "${OLD_DIR}/${DATA_DIR_NAME}" "${NEW_DIR}/${DATA_DIR_NAME}" || { log "!! 数据复制失败"; exit 1; }
[ -f "${OLD_DIR}/.env" ] && cp -a "${OLD_DIR}/.env" "${NEW_DIR}/.env"
log "新目录任务目录数=$(ls "${NEW_DIR}/${DATA_DIR_NAME}/tasks" | wc -l)"

log "== 5. 切换单元到新目录 =="
write_override "${NEW_DIR}"
systemctl restart "${UNIT}"
if ! wait_health; then
  log "!! 新目录实例未健康，回退旧目录"
  write_override "${OLD_DIR}"
  systemctl restart "${UNIT}"
  wait_health && log "已回退，旧目录实例健康" || log "!! 回退后仍不健康，需人工处理"
  exit 1
fi
sleep 2

log "== 6. 切换后核对 =="
log "单元 active=$(systemctl is-active ${UNIT}) sub=$(systemctl show -p SubState --value ${UNIT}) enabled=$(systemctl is-enabled ${UNIT})"
systemctl show -p MainPID -p WorkingDirectory -p User -p ExecStart "${UNIT}" | tee -a "${LOG}"
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
log "任务数=$(tasks_count)"
log "health=$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" | tr -d '\n ')"
log "运行版本探针：dist 构建时间=$(stat -c %y "${NEW_DIR}/packages/control-plane/dist/server.js" | cut -d. -f1)"

if [ "${FAIL}" = "0" ]; then
  log "结论：切换通过（新目录 ${NEW_DIR} 由 systemd 托管）"
else
  log "结论：核对存在失败项，保留旧目录 ${OLD_DIR} 以便回退"
fi
exit "${FAIL}"
