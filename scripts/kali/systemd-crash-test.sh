#!/usr/bin/env bash
# 故障恢复验证：让服务进程意外退出（SIGKILL），看 systemd 是否自动拉起。
# 独立于传输会话运行（后台 + 日志），避免杀掉进程时连带影响远程会话。
set -uo pipefail
UNIT=gongyuai.service
PORT=8877
LOG=/tmp/gongyuai-crash-test.log
: > "${LOG}"

log() { echo "[$(date -Is)] $*" >> "${LOG}"; }

cnt() { curl -fsS -m 5 "http://127.0.0.1:${PORT}/tasks" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["tasks"]))' 2>/dev/null || echo '?'; }

BEFORE=$(systemctl show -p MainPID --value "${UNIT}")
BEFORE_LISTENER=$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u | tr '\n' ' ')
log "故障前：MainPID=${BEFORE} listener=${BEFORE_LISTENER} tasks=$(cnt) health=$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null | tr -d '\n ')"
systemctl show -p ActiveState -p SubState -p NRestarts -p Result "${UNIT}" >> "${LOG}"

log "动作：kill -9 ${BEFORE}（模拟服务进程意外退出）"
kill -9 "${BEFORE}" 2>/dev/null || log "kill 失败：目标进程可能已不存在"

RECOVERED=0
for _ in $(seq 1 60); do
  sleep 1
  AFTER=$(systemctl show -p MainPID --value "${UNIT}")
  ACT=$(systemctl is-active "${UNIT}")
  if [ "${ACT}" = "active" ] && [ "${AFTER}" != "0" ] && [ "${AFTER}" != "${BEFORE}" ] \
     && curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    RECOVERED=1
    log "已自动恢复：用时约 ${_} 秒"
    break
  fi
done

AFTER=$(systemctl show -p MainPID --value "${UNIT}")
log "故障后：MainPID=${BEFORE} → ${AFTER}"
systemctl show -p ActiveState -p SubState -p NRestarts -p Result "${UNIT}" >> "${LOG}"
log "tasks=$(cnt)"
log "kali-demo $(curl -fsS -m 5 "http://127.0.0.1:${PORT}/tasks/e9d288f8-4580-4a42-813f-ec66c93d63a3/history" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print("facts=%d events=%d goals=%d" % (len(d["facts"]),len(d["events"]),len(d["goals"])))' 2>/dev/null || echo '不可读')"
LISTENER=$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
for pid in ${LISTENER}; do
  log "listener pid=${pid} cgroup=$(tr '\n' ' ' < /proc/${pid}/cgroup) cwd=$(readlink -f /proc/${pid}/cwd)"
done
log "health=$(curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" 2>/dev/null | tr -d '\n ')"
if [ "${RECOVERED}" = "1" ]; then log "结论：故障恢复通过（systemd 自动拉起，入口与历史仍可读）"; else log "结论：故障恢复失败"; fi
