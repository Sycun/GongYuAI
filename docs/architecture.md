# GongYuAI Architecture

## Problem

Long-running authorized pentest agents fail for four reasons: context windows fill, processes die, side effects are not idempotent, and models mark goals done without evidence.

## Solution (MVP)

1. **Durable Run** — Worker checkpoints phase/step to SQLite; control-plane lease + Watchdog restarts dead workers onto the same History/Durable volumes.
2. **External History** — Layered Fact (title / summary / evidence) + Intent + Goal graph is the only cross-session truth.
3. **Router / Worker split** — Control plane never executes shell. Workers own tools.
4. **Evidence gate** — Goals stay `passes:false` until matching files exist under `evidence/`.
5. **AI-native policy** — Human supplies auth scope, budget, and goal contracts. Exploration path is model-driven (or mock script for CI).

## Packages

| Package | Responsibility |
| --- | --- |
| `@gongyuai/contracts` | Shared schemas (Task, Goal, Fact, Intent, Manifest) |
| `@gongyuai/history` | SQLite History store (`node:sqlite`) + evidence gate |
| `@gongyuai/control-plane` | Task state machine, Docker/local runner, Watchdog, HTTP API |
| `@gongyuai/worker` | Pi Durable / OpenAI / mock loop + tools |
| `@gongyuai/cli` | `gy` single-user CLI |

## Data layout (per task)

```text
.gongyuai/tasks/<taskId>/
  manifest.json
  history.sqlite
  durable.sqlite
  durable.sqlite.ckpt.sqlite
  evidence/
  workspace/PROGRESS.md
  worker.log
  worker-status.json
  report.md
```

## Runtime

- `GY_RUNTIME=local` — spawn worker Node process (dev / smoke).
- `GY_RUNTIME=docker` — one container per task (`gongyuai-worker` image).

## Differentiation

Not a HexStrike-style tool catalog, not a fixed PentestGPT stage pipeline, not a tmux legion. Harness mechanics + History + evidence contracts; minimal doctrine.
