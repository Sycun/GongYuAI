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

Launch a task (VPN must be up; target `*` allows dynamic container IPs):

```bash
pnpm gy run \
  --base-url http://127.0.0.1:8877 \
  --goals examples/tsecbench/goals.json \
  --target '*' \
  --auth "TSecBench authorized task task_202611fkretwo5ka — GongYuAI agent evaluation" \
  --name tsecbench-e1 \
  --max-wall-ms 3600000 \
  --max-tool-calls 400
```

Watch: console Live / Tasks, or `pnpm gy status --base-url http://127.0.0.1:8877`.
