# TSecBench 状态

**当前任务：`task_202611c8pnksin2v`（2026-11-21 新签发）— 已解阻，可继续清板。**

## 本轮约束（硬）
1. **禁止 hint**（除非显式 `GY_TSEC_ALLOW_HINT=1`；历史任务 hint≥5 即终局）。
2. VPN 必须已连接（Viscosity：`task_202611c8pnksin2v_vpn_config`）；worker 禁止改宿主网络。
3. 凭据只写 `.gongyuai/tsecbench/env`（及同步的 `.env` / `~/.config/tsecbench/env`），勿回显明文。
4. board 未 100% 完成前，**不写 ALL_COMPLETE.json，不 assert clear-board**。

## 上一轮终局（归档）
- 旧任务 `task_202611fkretwo5ka`：hint 耗尽 → 409 `already finished`；63 题中曾完成 28 题。
- 证据：`evidence/tsec/known_flags.json` 多为实例级 UUID，**换 task 不可复用 flag 字符串**，只复用手法。
