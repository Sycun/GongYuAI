# GongYuAI

AI-native **long-running** authorized pentest agent，产品面定位为 **Mission Control**（不是裸 API、也不是聊天壳）。

- **Web 控制台**：Overview / Tasks / Live / Goals / History / Evidence / Report / Logs
- **Pi Durable** worker（OpenAI 兼容回退；图相位 Bootstrap→Explore→Reason）
- **分层 History（Fact / Intent / Goal）** + **证据闸门**
- **Control plane + Watchdog**：lease / 崩溃恢复 / 每任务 Docker 或 local worker
- **Session Relay**：上下文边界结构化接力（πₙ）；图仍为权威
- **Harness 差分**：`pnpm diff-harness`（bare / history / relay）
- **单用户 MVP** CLI（`gy`）；多人后置

## 当前发布（第九轮，2026-11-22/23）

| 项 | 值 |
| --- | --- |
| 本轮范围 | 后端：委托边界、持久资料作业、24h 求助与跨班交接、材料语义/覆盖矩阵/证据撤回一致性、四图与因果 API、全局记忆与档案索引、冻结评测/提案晋升回退、角色分层与供应商韧性（模拟） |
| 新增验收 | `pnpm acceptance:r9:ops`（67/67）· `pnpm acceptance:r9:flywheel`（57/57）· 证据 `docs/evidence/r9/` |
| 单测 | 195 通过（contracts 51、history 57、control-plane 52、worker 35） |
| 前端交接 | [docs/api-contract-r9.md](docs/api-contract-r9.md) |
| 复核清单 | [docs/review-checklist-r9.md](docs/review-checklist-r9.md) |
| 差距表（开工前 + 实施后） | [docs/round9-gap.md](docs/round9-gap.md) |
| 未验证清单 | [docs/owner-unverified-r9.md](docs/owner-unverified-r9.md) |
| 交付记录 | [docs/delivery-record.md](docs/delivery-record.md) §0 |

## 上一轮发布（第八轮，2026-11-22）

| 项 | 值 |
| --- | --- |
| 受验代码 | `f2719556d19dc7c5d35063e45d78bed70c19f031`（tree `657929f`） |
| 本轮修复 | ① 控制台「业务核算」目标类型（系统派生核算条件）② 首次通过绑定判定时有效的那一版输入 |
| 单测 | 163 通过（contracts 41、history 50、control-plane 37、worker 35） |
| 跨日模拟运行 | `engagement-1795361202971`（80/80）· 快照封印 `f8583e4f7f0c…` |
| 业务验收运行 | `business-1795361225404`（77/77）· 快照封印 `0793116f38c8…` |
| 首次通过绑定验收 | `firstpass-1795361227496`（69/69）· `pnpm acceptance:firstpass` |
| Kali 正式入口验收任务 | `a0c5638d…` / `bf6b3bac…` / `c8c451d3…`（UI 复跑）+ `5e3490ce…`（最终构建 UI 复验）+ `706ead3e…` / `7a15202a…` / `dfcbffcc…` / `af139adb…`（最终构建接口复检）· 均 1/1，各自 1 条首次通过事件 |
| 交付记录 | [docs/delivery-record.md](docs/delivery-record.md) §0 · [浏览器验收读数](docs/evidence/round8/kali-console-acceptance.json) |
| 复核最短路径 | [docs/review-checklist.md](docs/review-checklist.md) §0 |

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
| Kali | `/home/parallels/GongYuAI-f2719556`（systemd `gongyuai.service`） | `bash scripts/kali/deploy.sh prepare|switch <commit>`（clone + build + 迁移数据 + 切换） |

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
