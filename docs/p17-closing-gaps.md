# P17：补齐剩余缺口（主机枚举 / 事件链 / AD·云图 / 模型路由 / 评测）

2026-11-24 起草并实现。对象：本仓 `main` 工作树（P15 之后）。
配套：[absorb-offensive-landscape.md](./absorb-offensive-landscape.md)（P15）· [pentest-completeness.md](./pentest-completeness.md) · [MASTER-DESIGN.md](./MASTER-DESIGN.md)

P15 收口时明确记了五件未完成的事：提权枚举器、AD/云域模型、事件哈希链/TSA、provider 池与三层路由、阶段级/命令级评测。本轮逐项落地；仍不能在本机伪造的部分，写清边界而不是假装完成。

---

## 1. 提权 / 主机枚举解析器

**问题**：`HostProfile` 对象早已存在，但模型要手工把 `systeminfo`/`whoami /all`/`sudo -l` 抄成字段；P14 §12 记的「提权枚举器未做」指的就是这一步。

**落点**：

- `packages/contracts/src/host-enum.ts`：纯函数 `parseHostEnumeration(text)`。
  - Linux：`id`、`uname -a`、`/etc/os-release`、`sudo -l`、`getcap`、`ss -ltnp`。
  - Windows：`systeminfo`、`whoami /all`、`net localgroup administrators`、`net user`、`net share`、`ipconfig /all`。
  - AV/EDR 信号：Defender/CrowdStrike/SentinelOne/Carbon Black/…（只作为观测，不用于绕过）。
- `packages/worker/src/ops-tools.ts`：`hostProfileParseTool` 写入 `HostProfile`，带 `evidencePath` 与 `source=enum-parser`；未识别返回 `skipped`，不编造。
- Worker 工具 `host_profile_parse`（Explore 相位）；提示词要求拿到枚举输出先结构化画像。
- 硬闸：数组去重并限长（200/50）；asset 过 `admitAddress`，oos 拒绝；无匹配不落 profile。

**验收**：`packages/contracts/src/host-enum.test.ts`（4 例：Linux/Windows/未识别/裸 hostname）；`packages/worker/src/ops-tools.test.ts` 新增 1 例。

---

## 2. 事件哈希链

**问题**：事件表只有 append-only，没有防篡改链；报告无法给一个可复算的链头。

**落点**：

- `events` 表新增 `prev_hash`、`hash`；`emit()` 以
  `sha256(prev + id + taskId + kind + payloadJson + createdAt)` 计算并写入。
- 迁移：旧库打开时按任务、`rowid` 顺序回填；已有事件也获得链。
- `verifyEventChain(taskId)` 从 genesis 重算，返回 `{ok,length,head,brokenAt,reason}`；篡改 payload 会被定位到具体事件。
- 入口：`GET /tasks/:id/chain`、`gy chain <task>`；报告「覆盖与当前支持」段打印事件链头。
- **TSA 边界**：链头是 TSA-ready 的 SHA-256 摘要；外部 RFC3161 时间戳需要可用的 TSA 服务，本轮不伪造。操作员可把链头交给现有 TSA/公证流程。

**验收**：`packages/history/src/event-chain.test.ts`（2 例：链校验/篡改定位；旧库 NULL 事件回填）。

---

## 3. AD / 云攻击图

**问题**：AD/云只有 Skill/MCP 和自由文本 Fact，没有类型化图，也没有「从 foothold 到 Domain Admins」的可复核路径。

**设计**：不建第二资产库。节点/边仍是 Fact，标签为：

```text
attack.node + attack.node.kind:<ad-user|ad-group|ad-computer|ad-domain|cloud-*>
           + attack.node.id:<SID/ARN> + attack.node.name:<name>
attack.edge + attack.edge.kind:<member-of|generic-all|admin-to|has-session|assume-role|…>
           + attack.edge.from:<id> + attack.edge.to:<id>
```

**落点**：

- `packages/contracts/src/attack-graph.ts`
  - `buildAttackGraph(facts)`：只读投影；
  - `parseBloodHound(json)`：SharpHound/BloodHound 的 users/groups/computers/domains + `Members`/`Aces`/`Sessions`/`LocalAdmins`；
  - `findAttackPaths(graph)`：从 `owned` 起点 BFS 到 Domain/Enterprise/Schema Admins，返回路径与边类型；
  - 云节点/边 helper：`cloudNode` / `cloudEdge`。
- History：`recordAttackNode/recordAttackEdge/attackGraph/attackPaths`，全部写 Fact。
- Worker 工具：`bloodhound_import`（导入并返回 DA 路径）、`attack_graph_record`（node/edge）、`cloud_record`（云节点 + 可选边）。
- API：`GET /tasks/:id/graphs/ad`、`GET /tasks/:id/graphs/cloud`（只读，含 paths）。AD 默认目标是 Domain/Enterprise/Schema Admins；云视图的目标是 cloud-role 或名称含 admin/owner/root 的节点。
- 报告新增「AD / 云攻击路径」段：节点/边规模、路径、每条边可回查 Fact；无路径时明确写「未发现路径或缺少 owned 起点」。
- 硬闸：只导入已有节点之间的边；未知 Right/kind 丢弃；不把路径当「已利用」。

**验收**：`attack-graph.test.ts`（4）、`history/src/attack-graph.test.ts`（1）、`control-plane/src/attack-graph-api.test.ts`（1）、`worker/src/ops-tools.test.ts`（2）。

---

## 4. Provider 池与三层模型路由

**问题**：P7 只有契约与提案；实际 worker 仍是单模型，Reason/Explore 没有分层。

**落点**：

- `packages/contracts/src/model-routing.ts`：
  - `ModelRef` / `ModelTiers`（reason / explore / execute）；
  - `selectModelRoute()`：slot 0 优先 `reason`，其他 slot 优先 `explore`；缺 key 时按「其他 tier → provider pool → base」回退；确定性去重。
- `ExecutionConfigSchema` 增加 `models` / `providers`，任务可携带三层配置。
- `packages/worker/src/pi-loop.ts` 的 `resolvePiModelRef()` 在启动时按 slot 选模型，并把 `tier` / `fallbacks` 写入进度日志。
- **边界**：Pi 的 root model 在 Harness 打开时固定，所以这是**启动期路由**；进程中途热切换需要 Pi 暴露模型切换 API。fallback 链已算出并记录，但跨 provider 的自动重试仍属下一轮。

**验收**：`model-routing.test.ts`（4）、`pi-model.test.ts` 新增 1 例（leader=reason / slot3=explore）。

---

## 5. 阶段级 / 命令级离线评测

**问题**：此前只能报「目标过没过 / token 多少」，无法判断是工具选错、参数写错还是策略错。

**落点**：

- `packages/contracts/src/capability-eval.ts`：
  - 命令归一：shell-ish tokenizer + alias 映射（`http`→`httpx` 等）；
  - 评分：exact=1 / 同 binary 且期望 flags 全在=0.5 / 其余=0；
  - 阶段覆盖：`recon/auth/web/verify/chain/report` 分别统计 required/covered/missing。
- `scripts/p17-eval.ts` + `pnpm eval:p17`：读 fixture JSON，输出命令得分与阶段覆盖率；不调用模型、不联网。
- `examples/p17-eval/fixtures.json`：4 条合成用例，可把 `actual` 换成模型真实输出做回归。
- 硬闸：不接受「公开 benchmark 分数 = 能力」；fixture 必须标注模型、预算、日期。

**验收**：`capability-eval.test.ts`（3）；`pnpm eval:p17 -- --self-test` 可跑。

---

## 6. 仍不能假装完成的部分

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 外部 RFC3161 TSA | 未接 | 需要可用 TSA 服务与网络；链头已 TSA-ready，不伪造回执 |
| Pi 进程内模型热切换 | 未接 | Pi root model 固定；当前为启动期 tier 路由 + fallback 链 |
| 云 API 自动采集（AWS/Azure/GCP/阿里云/腾讯云/华为云） | 未接 | 需要各家凭据、只读策略与云 SDK；当前是 `cloud_record` 通用对象 |
| AD 图的全量边类型 | 部分 | 已覆盖 Members/Aces/Sessions/LocalAdmins；GPO/OU/Trust 可按同一 tag 语义继续扩 |
| 阶段级端到端基准 | 部分 | 已有评分原语与 fixture；接真实任务回放/模型对比是下一轮 |

---

## 7. 验收读数

- Mac：`pnpm -r run typecheck` 0 错误；`pnpm -r run test` **439 通过 / 0 失败**（contracts 80 / console 30 / history 79 / exec 58 / worker 72 / control-plane 120；cli 0）。
- Kali：同步后构建成功、全量测试 **439 通过 / 0 失败**；`P17_KALI_E2E_OK`（真实 nmap 解析、主机枚举、BloodHound/AD 路径、云节点、独立确认、重复命令断路、事件链 20 条校验、tier 路由、命令评分、审计记分卡）；`pnpm eval:p17` 输出 exact=4、阶段覆盖 0.75。
- 验证副本 `/home/parallels/GongYuAI-p17`、e2e 脚本与 `/tmp/gy-*` 临时目录在结束后删除；Kali 生产 `gongyuai.service` 未切换。
