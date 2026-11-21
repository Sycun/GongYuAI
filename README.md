# GongYuAI

AI-native **long-running** authorized pentest agent，产品面定位为 **Mission Control**（不是裸 API、也不是聊天壳）。

- **Web 控制台**：Overview / Tasks / Live / Goals / History / Evidence / Report / Logs
- **Pi Durable** worker（OpenAI 兼容回退）
- **分层 History** + **证据闸门 Goals**
- **Control plane + Watchdog**：lease / 崩溃恢复 / 每任务 Docker 或 local worker
- **单用户 MVP** CLI（`gy`）；多人后置

控制台 IA 调研见 [docs/console-research.md](docs/console-research.md)。

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

- [Architecture](docs/architecture.md)
- [Long-run contract](docs/long-run-contract.md)
- [DVWA smoke](examples/dvwa-smoke/README.md)

## Layout

```text
packages/contracts|history|control-plane|worker
apps/cli
docker/worker
examples/dvwa-smoke
```
