# GongYuAI

AI-native **long-running** authorized pentest agent，产品面定位为 **Mission Control**（不是裸 API、也不是聊天壳）。

- **Web 控制台**：Overview / Tasks / Live / Goals / History / Evidence / Report / Logs
- **Pi Durable** worker（OpenAI 兼容回退；图相位 Bootstrap→Explore→Reason）
- **分层 History（Fact / Intent / Goal）** + **证据闸门**
- **Control plane + Watchdog**：lease / 崩溃恢复 / 每任务 Docker 或 local worker
- **Session Relay**：上下文边界结构化接力（πₙ）；图仍为权威
- **Harness 差分**：`pnpm diff-harness`（bare / history / relay）
- **单用户 MVP** CLI（`gy`）；多人后置

## 当前发布（第七轮，2026-11-22）

| 项 | 值 |
| --- | --- |
| 受验代码 | `f34cc032cd9c4061a9212758595b34cf8d5fc2e0`（tree `e9d5649`） |
| 跨日模拟运行 | `engagement-1795356668890`（80/80）· 快照封印 `d6f744c3356a…` · 字节 `97ff33f3a146…` |
| 业务验收运行 | `business-1795356691440`（77/77）· 快照封印 `0439db0cc133…` · 字节 `5ef79202a6d5…` |
| Kali 正式入口验收任务 | `497126a0-93ac-4c9b-b293-acd380759f40` · 首次通过依据 `reconcile/kali-eng-diff-20261122141507.json` · `478da5dfc3d0…` |
| 交付记录 | [docs/delivery-record.md](docs/delivery-record.md) §0 · [发布回执](docs/evidence/release/receipt.json) |
| 复核最短路径 | [docs/review-checklist.md](docs/review-checklist.md) |

文档入口：[docs/README.md](docs/README.md)。后续开发按 [docs/dev-handbook.md](docs/dev-handbook.md)。

> Authorized testing only. You must supply an explicit authorization note and target allow-list.

## Quick start

```bash
pnpm install
pnpm -r run build
pnpm smoke
```

## Mac 开发 → Kali 运行（GitHub）

| 角色 | 路径 | 动作 |
| --- | --- | --- |
| Mac | `/Users/sycpro/GongYuAI` | 开发；`git push origin main` |
| Kali | `/home/parallels/GongYuAI-f34cc032`（systemd `gongyuai.service`） | `bash scripts/kali/deploy.sh prepare|switch <commit>`（clone + build + 迁移数据 + 切换） |

首次在 Kali 从旧共享盘树切到 Git：`bash scripts/parallels/bootstrap-from-github.sh`。  
不再使用 `~/Downloads/GongYuAI-sync` / Parallels 共享盘 rsync 做传输。

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
