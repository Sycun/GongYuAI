# TSecBench + GongYuAI

Authorized benchmark only. Credentials live in `.gongyuai/tsecbench/env` (gitignored) or `~/.config/tsecbench/env`.

## Prereqs

1. `BENCHMARK_BASE_URL` + `BENCHMARK_TOKEN` set (admission ticket).
2. Import `task_*_vpn_config.ovpn` into Viscosity and connect.
3. `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL` / `GY_MODEL`) for the real worker.

## Helper

```bash
pnpm tsecbench list
pnpm tsecbench start e1-01
pnpm tsecbench status e1-01
pnpm tsecbench submit e1-01 'flag{...}'
pnpm tsecbench close e1-01
```

## Run agent

Control plane (already common on 8877):

```bash
pnpm gy serve --port 8877
pnpm --filter @gongyuai/console dev   # http://127.0.0.1:5173
```

Launch autonomous board clear as an **authorized pentest engagement** (VPN must be up **before** start; prefer CIDR over bare `*`). Goals require board clear + engagement ledger + `engagement/report.md`:

```bash
pnpm gy run \
  --base-url http://127.0.0.1:8877 \
  --goals examples/tsecbench/goals-autonomous.json \
  --target '10.0.0.0/8' \
  --auth "TSecBench authorized task — GongYuAI agent evaluation" \
  --capability full \
  --name tsecbench-auto
  # defaults: unlimited budget (0); add --max-wall-ms / --max-tool-calls only if you want caps
```


## Harness 子集差分（相对裸循环）

只报 **bare / history / relay** 相对表，不报神话绝对分。

Mock 基线（CI / 本机无 VPN 也可）：

```bash
pnpm diff-harness:tsec
# 等价于：
pnpm diff-harness --mock --goals examples/tsecbench/goals-subset-diff.json \
  --target example.invalid \
  --auth "Local synthetic P3 fixture only"
```

三组执行相同的合成准备和采集，各计两次工具调用。证据写入和 Goal 断言属于验收步骤，不计入工具调用。三组都用同一套证据文件规则判定 Goal。Mock 不调用模型，Tokens 不作收益指标。

`bare` 只用 History 持久化验收与审计，执行过程不读任务图。`history` 组关闭自动和主动 Relay，`relay` 组必须生成一次交接。表格同时列出通过的 Goal 数、Relay 事件数和文件数，任一口径异常时命令返回失败。

真平台子集（VPN + ticket + 真模型；禁止 hint；只跑小子集）：

```bash
# 1) 接通 Viscosity；2) 填好 .gongyuai/tsecbench/env；3) 去掉 --mock，收紧 budget
pnpm diff-harness --goals examples/tsecbench/goals-subset-diff.json \
  --target '10.0.0.0/8' \
  --auth "TSecBench authorized <task_id> — harness subset vs bare" \
  --modes bare,history,relay
```

与 ARTEX 对比时：同一 task ticket、同一子集、同预算；只比完成题数 / toolCalls / tokens 相对差，不批量 hint。

Watch: **http://127.0.0.1:8877/** (Mission Control). Host network/VPN mutation is denied by the worker.
