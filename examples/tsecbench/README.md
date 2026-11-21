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

Launch autonomous board clear (VPN must be up **before** start; prefer CIDR over bare `*`):

```bash
pnpm gy run \
  --base-url http://127.0.0.1:8877 \
  --goals examples/tsecbench/goals-autonomous.json \
  --target '10.0.0.0/8' \
  --auth "TSecBench authorized task_202611fkretwo5ka — GongYuAI agent evaluation" \
  --name tsecbench-auto \
  --max-wall-ms 14400000 \
  --max-tool-calls 5000
```

Watch: **http://127.0.0.1:8877/** (Mission Control). Host network/VPN mutation is denied by the worker.
