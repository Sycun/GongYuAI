# GongYuAI

AI-native **long-running** authorized pentest agent，产品面定位为 **Mission Control**（不是裸 API、也不是聊天壳）。

- **Web 控制台**：Overview / Tasks / Live / Goals / History / Evidence / Report / Logs
- **Pi Durable** worker（OpenAI 兼容回退）
- **分层 History（Fact / Intent / Goal）** + **证据闸门**
- **Control plane + Watchdog**：lease / 崩溃恢复 / 每任务 Docker 或 local worker
- **Session Relay（规划中）**：上下文边界结构化接力，图仍为权威
- **单用户 MVP** CLI（`gy`）；多人后置

文档入口：[docs/README.md](docs/README.md)。后续开发按 [docs/dev-handbook.md](docs/dev-handbook.md)。

> Authorized testing only. You must supply an explicit authorization note and target allow-list.

## Quick start

```bash
pnpm install
pnpm -r run build
pnpm smoke
```

Mock closed loop:

```bash
pnpm gy run \
  --goals examples/dvwa-smoke/goals.json \
  --target https://example.com \
  --auth "Written authorization: example.com owned lab for GongYuAI smoke" \
  --mock --wait
```

## Docs

完整索引：[docs/README.md](docs/README.md)

- [Theory: Fact–Intent DAG](docs/theory-fact-intent-dag.md) — A2 理论综合（遗忘/漂移、授权层）
- [Architecture](docs/architecture.md) — 图原语、控制面/Worker、包职责
- [Long-run contract](docs/long-run-contract.md) — lease / FSM / 证据闸 / Relay
- [Dev handbook](docs/dev-handbook.md) — P0–P4 分期、验收、反模式
- [Console research](docs/console-research.md)
- [DVWA smoke](examples/dvwa-smoke/README.md) · [TSecBench](examples/tsecbench/README.md)

## Layout

```text
packages/contracts|history|control-plane|worker
apps/cli
docker/worker
examples/dvwa-smoke
```
