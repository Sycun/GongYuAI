# Explore 并发：智能推荐与动态扩容

2026-11-22 定案（用户拍板：智能推荐 3–10 + 按资产数动态扩并发）。  
配套：[architecture.md](./architecture.md) · [long-run-contract.md](./long-run-contract.md) · [asset-inventory.md](./asset-inventory.md)

## 要解决什么

P4 已有 `execution.maxConcurrentExplores`（1–16，默认 1），但有效并发 = `min(配置, auth.targets.length)` 且**只在启动时解析一次**：

- 授权给 1 条 CIDR / `*.domain` → `targets.length=1` → 哪怕扫出 200 台存活资产也永远单 Worker。
- 运行中发现大量新资产，并发不跟着涨。
- 控制台默认 1，用户不知道要手动抬。

## 新公式（契约变更）

```text
effectiveExplores = min( maxConcurrentExplores, max( seed靶标数, admitted/live 资产数 ) )
totalWorkerSlots  = effectiveExplores <= 1 ? 1 : effectiveExplores + 1   # slot 0 专职调度 + slots 1..E 真并发 Explore
```

- 默认 `DEFAULT_MAX_CONCURRENT_EXPLORES = 3`（契约 / CLI / 控制台统一默认 3，控制台按靶标数推荐 `min(10, max(3, 靶标数))`，单 CIDR 不再被压成 1）。
- 资产数 = History 资产投影中 kind ∈ {admitted, live} 的去重地址数（`listAssets` 已按最高 kind 合并）；seed/oos 不计（seed 由靶标数覆盖，oos 不可利用）。靶场 `boardGate=tsecbench` 任务开局按 `min(configured, 3)` 直接拉起 `1 Leader + 3 Followers` 滑动流水线。
- 硬顶仍 16；下限 1；启动与崩溃重启都按新公式解析。

## 动态扩容纪律（硬规则）

1. **只扩不缩**：desired ≤ 当前存活 slot 数时不动作；不杀正在跑 Intent 的 Worker，缩容靠自然退出。
2. **永不超用户上限**：`maxConcurrentExplores` 是操作员契约，扩容不得越过；抬上限只能人改任务。
3. **非战术**：扩容判定只读资产**计数**（结构投影）与租约/存活状态，不读 Fact 内容、不派 Intent、不改 Goal。这是资源供给（与 `min(配置,靶标数)` 启动解析同类），不是看门狗写战术——Watchdog 零策略军规不破，判定函数放 runner，watchdog 只在存活分支调用。
4. **节流**：每任务扩容检查最小间隔（10s），避免每个 tick 全量扫 Fact。
5. **新 slot 语义与单 Intent 会话隔离**：slot 0 仍是唯一 Bootstrap/Reason/Report leader（物理剥离执行工具）；slot 1..N 为 follower，采用**单 Intent 隔离短会话**——每次 `intent_claim` 一条 `proposed` Intent 独立执行，`intent_conclude` 时通过 `control: { terminate: true }` 结束本轮并在下一轮前 `reset` 清空本地会话历史，只通过共享 History SQLite 传递结构化事实与证据。
6. **预算口径不变**：任务级累计用量 + 控制面聚合闸照旧；新 slot manifest 预算同样扣 `usageOffset`。

## 机制

- Watchdog tick 存活分支 → `runner.reconcileWorkers(task)`：
  1. 短开 History 只读连接数 admitted/live 资产 → desired；
  2. desired > 存活 slot 数时，为新 slot 写 manifest 并拉起进程/容器，追加 `workerPids`/`containerIds`；
  3. 同时重写既有 slot 的 manifest（`workerCount` 更新；运行中进程不重读，重启后生效——提示词里的 pool 规模短暂滞后是无害的）；
  4. 写 History 事件 `explore_scaled { from, to, assetCount }` 供控制台 Live 与审计。
- 节流时间戳记在 runner 内存（重启丢失无害：重启本就重新解析）。

## 控制台智能推荐（3–10）

- 新建任务表单：靶标数变化时自动推荐 `min(max(3, 靶标数), 10)`（保底默认 3 路并发，确保单 CIDR / 单域名也能动态扩容）。
- 用户手动改过并发值后不再自动覆盖；范围仍 1–16。
- extraText 说明新公式与「运行中按发现资产自动扩容（只扩不缩）」。
- CLI 不变：`gy run --concurrency N` 显式指定。

## 验收

```bash
pnpm --filter @gongyuai/contracts test   # assetCount 公式 + 旧调用兼容
pnpm --filter @gongyuai/control-plane test
pnpm smoke
```

- 单测：单 CIDR 靶标 + N 资产 → effective=min(cap, N)；无 assetCount 旧行为不变；只扩不缩。
- mock 集成：1 靶标 cap≥3 启动 → 写入资产 Fact → reconcile 后 slot 数增长、leader 仍 slot 0。
- 控制台：填 5 条靶标 → 并发自动变 5；填 20 条 → 变 10；手动改 2 后再改靶标 → 保持 2。

## 反模式

1. 按 Fact 内容/Intent 语义决定扩缩容（战术进看门狗）。
2. 缩容杀正在执行的 Worker（丢 partial Fact 风险）。
3. 自动抬 `maxConcurrentExplores` 上限（授权边界只能人改）。
4. 为扩容另建第二套调度器/队列（图 + CAS 已是并发协议）。
5. 把 oos 资产计入并发需求（不可利用面不配执行体）。