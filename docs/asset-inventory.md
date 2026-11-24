# 资产清单（Asset Inventory）

双向、实时、与 Fact–Intent DAG 同真相源。  
配套：[architecture.md](./architecture.md) · [long-run-contract.md](./long-run-contract.md) · [theory-fact-intent-dag.md](./theory-fact-intent-dag.md)

## 要解决什么

用户开局给 10 条靶标 → 控制台「资产」表应立刻有 10 行。  
运行中 FOFA / 子域枚举又发现 10 条 → 表变成 20 行，**且** Worker Observe 能看见同一批行，并能据此继续提出 Intent。

不另建第二张「资产库」当真相；**资产表 = History 中带 `asset` 标签的 Fact 投影**。

## 三层边界（保留旧设计）

> 字段名 `auth.targets` 是历史包袱，语义是**作业坐标**：目标进入任务即视为授权，不设授权审查（[red-team-positioning.md](./red-team-positioning.md)）。坐标只能人改，是工程纪律，不是授权闸。

| 层 | 权威 | 可变性 |
| --- | --- | --- |
| **作业边界** | `auth.targets`（作业坐标）+ `outOfScope` | 仅人类改任务坐标；Agent **禁止**静默扩围 |
| **资产清单** | Fact 投影（本页） | 运行中 append；控制台与 AI 同读 |
| **待探索** | open Intents | Reason 对 admitted/live 扇出 |

## 生命周期

```text
创建作业坐标 targets（人类）
            │
            ▼
   seedAssetsFromAuth → Fact kind=seed     ← 创建任务即写；控制台立刻可见
            │
            ▼
   Intent：枚举 / FOFA / 指纹（sourceFactIds=seed|admitted）
            │
            ▼
   asset_record(address) → 自动准入
        ├─ 命中 targets（CIDR / *.domain / 后缀 / *）→ admitted（或 live）
        └─ 未命中或命中 outOfScope → oos
            │
            ▼
   Reason：对 admitted/live 有界扇出新 Intent（仍须挂 sourceFactIds）
```

### kind

| kind | 含义 |
| --- | --- |
| `seed` | 来自 `auth.targets` 的作业靶标 / 模式（含 CIDR、`*.domain`） |
| `candidate` | 保留语义；默认发现路径直接走自动准入，少用 |
| `admitted` | 已在作业坐标内，可继续测 |
| `live` | 已核实存活（`asset_record(..., live=true)`） |
| `oos` | 范围外；可记账，**不可**作为利用 Intent 的唯一前驱 |

同一 `address` 多条 Fact 时，投影取 **最高 kind**（live > admitted > seed > candidate > oos）。

## 正式匹配（CIDR / 通配）

实现：`packages/contracts/src/scope.ts`（`targetAllows` / `admitAddress` / `matchTarget`）。  
Worker shell 闸门与资产准入共用同一套规则。

| `auth.targets` 条目 | 匹配 |
| --- | --- |
| `*` | 任意主机（仍禁止改主机 VPN/代理） |
| `10.0.0.0/8` | IPv4 CIDR |
| `*.example.com` | `example.com` 及其子域 |
| `example.com` | 精确或 `*.example.com` 后缀 |
| `https://host:8443/path` | 规范化后按 host 匹配 |

`outOfScope` 命中时 **覆盖** targets（按作业坐标拦截 / 记为 oos）。

能自动的一律自动：发现写入时默认 `admitAddress`，不弹人审。扩作业坐标仍须人改 `auth.targets`。

## 双向读写

| 读者 | 入口 |
| --- | --- |
| 控制台 | `GET /tasks/:id/assets`；任务深潜 **资产** Tab；轮询实时更新 |
| Worker | Observe 段「资产清单」；工具 `asset_list` / `asset_record` / `asset_search` |

写入唯一合法路径：

1. `seedAssetsFromAuth`（创建任务 / prepareManifest / bootstrap）  
2. `asset_record`（发现 / 升 live）  
3. `asset_search`（设置中启用的 FOFA / 鹰图 / 自定义收集器；内部仍走 `recordAsset`）  
4. （可选）Explore `conclude` 附带 asset tags 的 Fact  

**不要**把 FOFA JSON 只塞进 chat / Relay 当真相。控制台「设置 → 资产收集」配置密钥后，Worker 才可见对应收集器。

## 扇出纪律（硬闸）

配置在 `execution`（创建任务契约；默认见 contracts）：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `maxIntentsPerReason` | 4 | Reason 波次 open Intent 硬顶 |
| `maxIntentsPerAssetRoot` | 2 | 同根（eTLD+1 或 IPv4 /24）open Intent 硬顶 |
| `exploreTimeoutMs` | 900000 | Explore claim 墙钟超时 → 强制 conclude + partial Fact；0=关 |
| `reasonLeaseMs` | 120000 | 多 Explore 下 Reason 项目级 CAS lease；0=关 |

- Reason / `technique_transfer` 走同一套硬顶；同根合并优先于盲目全量扇出。  
- 有 open Explore 时不做 Reason（既有图互斥）。  
- `oos` 可保留情报标题；**禁止**作为利用 Intent 的唯一前驱（`proposeIntent` 硬拒）。

## 反模式

1. 发现即 `auth.targets.push`（模型自改作业坐标）  
2. 独立 assets 表与 Fact 双写  
3. 只更新控制台、不写 History（AI 看不见）  
4. 只写 chat、不写 asset Fact（刷新即丢）  
