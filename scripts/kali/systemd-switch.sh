#!/usr/bin/env bash
# 把 Kali 正式入口从“用户会话里的 nohup 进程”受控切换到 systemd 托管。
#
# 原则：
# 1. 先记录现场（监听 PID / cwd / cgroup / 单元状态），切换前不杀任何进程；
# 2. 切换在同一条流程里完成：停用户监听 → 启动单元 → 等健康；
# 3. 单元起不来就回滚到切换前的启动方式，保证正式入口不掉；
# 4. 切换后核对 MainPID、监听进程所属 cgroup、工作目录与数据目录。
set -uo pipefail

UNIT=gongyuai.service
PORT=8877
APP_DIR=/home/parallels/GongYuAI
DATA_DIR=/home/parallels/GongYuAI/.gongyuai
SELF_PGID=$(ps -o pgid= -p $$ | tr -d ' ')

log() { echo "[$(date -Is)] $*"; }

listener_pids() {
  ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u
}

describe_pid() {
  local pid=$1
  [ -d "/proc/${pid}" ] || { echo "  pid=${pid} 已不存在"; return; }
  local ppid pgid cwd cgroup
  ppid=$(ps -o ppid= -p "${pid}" | tr -d ' ')
  pgid=$(ps -o pgid= -p "${pid}" | tr -d ' ')
  cwd=$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || echo '?')
  cgroup=$(tr '\n' ' ' < "/proc/${pid}/cgroup" 2>/dev/null || echo '?')
  echo "  pid=${pid} ppid=${ppid} pgid=${pgid} cwd=${cwd}"
  echo "  cmdline=$(tr '\0' ' ' < /proc/${pid}/cmdline | cut -c1-240)"
  echo "  cgroup=${cgroup}"
}

log "== 切换前现场 =="
log "unit enabled=$(systemctl is-enabled "${UNIT}" 2>&1) active=$(systemctl is-active "${UNIT}" 2>&1)"
systemctl show -p MainPID -p ActiveState -p SubState -p User -p WorkingDirectory "${UNIT}"
log "数据目录：$(ls -d "${DATA_DIR}" 2>&1)"
log "活跃任务：$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/tasks" 2>/dev/null | grep -o '"status": "[a-z_]*"' | sort | uniq -c | tr '\n' ' ')"

BEFORE_PIDS=$(listener_pids)
log "监听 ${PORT} 的进程：${BEFORE_PIDS:-无}"
for pid in ${BEFORE_PIDS}; do describe_pid "${pid}"; done

if systemctl is-active --quiet "${UNIT}"; then
  log "单元已在运行，无需切换"
  exit 0
fi

systemctl reset-failed "${UNIT}" 2>/dev/null || true

log "== 停止用户会话监听（保持正式入口不中断为先，失败即回滚）=="
for pid in ${BEFORE_PIDS}; do
  pgid=$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ')
  kill -TERM "${pid}" 2>/dev/null || true
  if [ -n "${pgid}" ] && [ "${pgid}" != "${SELF_PGID}" ]; then
    kill -TERM -- "-${pgid}" 2>/dev/null || true
  fi
done
for _ in $(seq 1 40); do
  [ -z "$(listener_pids)" ] && break
  sleep 0.5
done
log "端口释放：$([ -z "$(listener_pids)" ] && echo 是 || echo '否（仍有监听）')"

log "== 启动 systemd 单元 =="
systemctl start "${UNIT}"
HEALTH=0
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then HEALTH=1; break; fi
  sleep 1
done

if [ "${HEALTH}" != "1" ]; then
  log "!! 单元 60s 内未健康，回滚到用户会话启动方式"
  systemctl stop "${UNIT}" 2>/dev/null || true
  systemctl show -p MainPID -p ActiveState "${UNIT}"
  cd "${APP_DIR}" || exit 1
  setsid nohup pnpm gy serve --host 0.0.0.0 --port "${PORT}" --data-dir "${DATA_DIR}" \
    >> /tmp/gongyuai-rollback.log 2>&1 &
  sleep 6
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/health"; then
    log "回滚后正式入口健康（用户会话方式）"
  else
    log "回滚也失败：需要人工恢复，见 /tmp/gongyuai-rollback.log"
  fi
  exit 1
fi

log "== 切换后核对 =="
log "unit enabled=$(systemctl is-enabled "${UNIT}") active=$(systemctl is-active "${UNIT}")"
systemctl show -p MainPID -p ActiveState -p SubState -p WorkingDirectory -p User -p Type "${UNIT}"
MAIN=$(systemctl show -p MainPID --value "${UNIT}")
log "MainPID=${MAIN}"
if [ "${MAIN}" != "0" ] && [ -d "/proc/${MAIN}" ]; then
  log "MainPID 详情："; describe_pid "${MAIN}"
fi
AFTER_PIDS=$(listener_pids)
log "监听 ${PORT} 的进程：${AFTER_PIDS:-无}"
for pid in ${AFTER_PIDS}; do describe_pid "${pid}"; done

UNIT_CGROUP=$(systemctl show -p ControlGroup --value "${UNIT}")
log "单元 ControlGroup=${UNIT_CGROUP}"
FAIL=0
for pid in ${AFTER_PIDS}; do
  if ! grep -q "${UNIT_CGROUP}" "/proc/${pid}/cgroup"; then
    log "!! pid=${pid} 不在单元 cgroup 内"
    FAIL=1
  fi
done
[ -n "${AFTER_PIDS}" ] || { log "!! 没有监听进程"; FAIL=1; }
CWDS=$(for pid in ${AFTER_PIDS}; do readlink -f "/proc/${pid}/cwd"; done | sort -u)
log "监听进程工作目录：${CWDS}"
[ "${CWDS}" = "${APP_DIR}" ] || { log "!! 工作目录不是 ${APP_DIR}"; FAIL=1; }
CMDS=$(for pid in ${AFTER_PIDS}; do tr '\0' ' ' < /proc/${pid}/cmdline; done)
echo "${CMDS}" | grep -q -- "--data-dir ${DATA_DIR}" || { log "!! 数据目录参数不是 ${DATA_DIR}"; FAIL=1; }

log "健康检查：$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" | tr -d '\n')"
log "任务数：$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/tasks" | grep -o '"id":' | wc -l)"
if [ "${FAIL}" = "0" ]; then log "结论：systemd 托管核对通过"; else log "结论：核对存在失败项"; fi
exit "${FAIL}"
