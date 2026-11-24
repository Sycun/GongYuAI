# GongYuAI 项目指导方案

> 这份文件面向**操作员、开发者与复核人**：如何启动、建档、运行、接管、验收和继续开发。
> 项目原因与技术框架见 [project-overview.md](./project-overview.md)；完整流程见 [project-flow.html](./project-flow.html)。
> 产品语义以 [red-team-positioning.md](./red-team-positioning.md) 为最高权威；当前实现状态以 [implementation-ledger.md](./implementation-ledger.md)、[p17-closing-gaps.md](./p17-closing-gaps.md) 和 [delivery-record.md](./delivery-record.md) 为准。

---

## 1. 先记住五条使用原则

1. **授权在工具之外取得。** 目标进入任务即默认授权；产品不登记授权、不逐目标审查、不要求运行中再次确认。
2. **作业坐标不是授权层。** `targets` 告诉工具打哪里，`outOfScope` 告诉工具排除哪里，`roe/rateGuidance/timeWindow/capability` 是操作配置。
3. **模型拒绝按故障处理。** 重问、结构化重问、换模型、拆小重派；不写成 Fact、不进入终态、不计作攻击失败。
4. **完成由硬闸决定。** 模型说“完成”无效；Evidence、内容判据、Finding 门槛与资产归属必须同时满足。
5. **History 是唯一真相。** 聊天、Relay、报告、记忆和四图都不是第二套状态；看到状态异常先查 History，而不是先改工作副本。

---

## 2. 环境与首次启动

### 2.1 最低环境

| 项 | 要求 |
| --- | --- |
| 操作系统 | Linux / macOS；Docker Worker 可选 |
| Node.js | `>=22.19.0` |
| 包管理 | `pnpm@10.15.0` |
| 模型 | OpenAI 兼容 provider，或控制台中配置的 provider |
| 数据目录 | 默认 `<repo>/.gongyuai`；可用 `GY_DATA_DIR` 覆盖 |
| 浏览器 | 仅使用控制台时需要；CLI 不需要 |

首次启动：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm smoke
```

模型凭据通过环境变量或控制台设置注入，不要写进仓库、Goal 文件、报告或证据：

```bash
export OPENAI_API_KEY='...'
# 可选：OpenAI 兼容服务地址
export OPENAI_BASE_URL='https://your-provider.example/v1'
```

### 2.2 启动长驻控制面与控制台

推荐让控制面独立运行，不要依赖 `gy run` 的临时内嵌进程：

```bash
pnpm gy serve --port 8877
```

另开终端：

```bash
GY_CONSOLE_API=http://127.0.0.1:8877 pnpm dev:console
```

- 控制面：`http://127.0.0.1:8877`
- 控制台：`http://127.0.0.1:5173`

注意当前默认值并不一致：CLI 默认访问 `127.0.0.1:8787`，控制台开发代理默认指向 `127.0.0.1:8877`。统一使用 8877 时，CLI 命令采用以下任一种方式：

```bash
export GY_PORT=8877
# 或每次显式指定
pnpm gy status --base-url http://127.0.0.1:8877
```

### 2.3 数据目录与隔离验收

- 正式数据：`GY_DATA_DIR` 或默认 `.gongyuai/`。
- 隔离恢复演练：`pnpm gy serve --data-dir <副本目录> --isolated`。
- `--isolated` 不导入旧任务、不启动 Watchdog、不自动续跑，适合恢复与迁移验收。
- 不要在当前工作树直接做破坏性恢复演练；使用独立副本。

---

## 3. 十分钟 Mock 验收

Mock 不调用模型，也不证明真实渗透能力；它只验证建档、相位、图写入、证据闸、报告与审计主链。

```bash
pnpm gy run \
  --goals examples/dvwa-smoke/goals.json \
  --target example.invalid \
  --auth "Local synthetic mock fixture; target is treated as authorized" \
  --mock \
  --wait
```

拿到 `taskId` 后复核：

```bash
pnpm gy status <taskId>
pnpm gy logs <taskId>
pnpm gy report <taskId>
pnpm gy scorecard <taskId>
pnpm gy chain <taskId>
pnpm gy audit <taskId>
```

`--wait` 当前按秒轮询，适合短冒烟；长任务不要用它作为主要监控方式，改用控制台、事件/作业通知和必要的状态查询。

---

## 4. 一次真实委托的操作流程

### 4.1 开工前检查

- [ ] 目标已由部署者或使用者授权；产品内不再设置授权审批。
- [ ] 明确 `targets` 与 `outOfScope`，确定能力档位和节奏建议。
- [ ] VPN、代理、路由由操作员在工具外接好；Worker 不会修改主机网络。
- [ ] 模型 provider、额度、上下文长度与工具依赖可用。
- [ ] Goal 的验收材料、内容判据和 Finding 门槛已经写清。
- [ ] 需要留存的报告格式、交付对象与复测入口已经确定。

### 4.2 先写 Goal，再启动任务

普通文件型 Goal 必须至少声明一个 `evidencePatterns`。推荐把“技术证据”“发现门槛”“进度台账”“最终报告”拆成不同 Goal，不要用一个模糊目标覆盖整份委托。

示例：

```json
[
  {
    "id": "sqli-proof",
    "title": "SQL 注入证据与独立确认",
    "description": "对声明资产完成 SQL 注入验证，留存请求、响应、复现说明和独立复核记录。",
    "assets": ["app.example.test"],
    "evidencePatterns": ["goals/sqli-summary.json"],
    "evidenceChecks": [
      {
        "pattern": "goals/sqli-summary.json",
        "field": "status",
        "equals": "verified"
      }
    ],
    "findingsGate": {
      "minVerified": 1,
      "minSeverity": "high",
      "vulnClasses": ["sqli"],
      "scope": "goal",
      "requireIndependent": true
    }
  },
  {
    "id": "engagement-report",
    "title": "客户风格渗透报告",
    "description": "汇总范围、资产、攻击路径、发现、证据、残余风险和复测状态。",
    "evidencePatterns": ["engagement/report.md"]
  }
]
```

Goal 设计规则：

- `evidencePatterns` 是 `evidence/` 下的相对 glob，每个 pattern 至少命中一个文件。
- `evidenceChecks` 只检查 JSON 顶层字段的精确值，适合机器可判定的关键结论。
- `findingsGate` 只统计 verified / retested / accepted；tentative 不计入。
- 默认 `scope: "goal"`，只统计 Goal 声明资产上的 Finding；只有整委托聚合目标才用 `scope: "task"`。
- `requireIndependent: true` 时，支持性 Finding 必须有 Finder 之外的 confirmed validation。
- 基准清板语义必须显式写 `boardGate: "tsecbench"`，不能靠文件名猜。

### 4.3 创建任务

当前 CLI：

```bash
pnpm gy run \
  --goals /path/to/goals.json \
  --target https://app.example.test \
  --name customer-web-engagement \
  --capability active-lab \
  --concurrency 1
```

当前语义（P16 已收敛）：

- `--auth` 为**可选**备注字段，写入 `authorizationNote`；授权是使用前提，**工具不登记、不审查授权**，目标进入任务即视为授权。
- CLI 与 API schema 默认 `--capability active-lab`；`full` 由操作者显式选择。档位是操作配置，不是目标审查。
- 不传 `--max-*` 时四项预算默认 `0 = unlimited`。只有明确需要硬上限时才传正数。
- 首次真实任务建议 `--concurrency 1`，确认资产与图约束稳定后再提高；有效并发会按资产数动态扩容，硬顶为 16。

P16 已收敛：CLI 的 `--auth` 是可选备注、`gy scope` 的 `auth` 形状是作业坐标、`scopeVersion` 只表示操作配置变更——产品没有授权层，旧台账仅只读兼容回查。

### 4.4 观察与引导

```bash
# 当前状态与 Worker 日志
pnpm gy status <taskId>
pnpm gy logs <taskId>

# 资产、攻击面、执行、记忆投影
pnpm gy graph <taskId> assets
pnpm gy graph <taskId> surface
pnpm gy graph <taskId> execution
pnpm gy graph <taskId> memory

# 当前覆盖、新鲜度与因果下钻
pnpm gy matrix <taskId>
pnpm gy freshness <taskId>
pnpm gy causality <taskId> <findingId>
```

需要补充战术信息时，用 Hint，不要直接改数据库：

```bash
pnpm gy hint <taskId> "优先验证登录后的导出接口；已有会话句柄见最近 Fact。"
```

Hint 只影响建议层，不直接派 Intent、不成为 Fact，也不能绕过 Goal Gate。

### 4.5 后台作业与人工求助

```bash
pnpm gy jobs <taskId> --receipts
pnpm gy job-retry <taskId> <jobId>
pnpm gy job-ack <taskId> <jobId> --key <receipt-key> --by operator

pnpm gy consults <taskId>
pnpm gy consult <taskId> --question "缺少测试账号，是否提供？" --options "提供,暂缓" --blocking true
pnpm gy answer <taskId> <consultId> "已通过安全渠道提供测试账号。" --by operator
pnpm gy consult-sweep <taskId>
```

- 长作业应异步完成并回流，不要让 Worker 反复轮询。
- blocking 求助会挂起当前 Intent；24h 无回复转非阻塞。
- 人工答复会写成 human Hint；它不会伪装成工具观测。
- 缺材料使用 `needs_input`，不是 `needs_authorization`。

### 4.6 暂停、恢复与换班

```bash
pnpm gy pause <taskId>
pnpm gy resume <taskId>
pnpm gy handoff <taskId> --next-owner next-operator
```

暂停会保留 History、证据、Durable checkpoint 与持久会话；恢复读取最新操作配置。换班包用于交接，不是恢复真假的替代品；接手后仍应从 History、checkpoint 和证据重新核对当前位置。

### 4.7 Finding、独立复核与复测

```bash
# 发现从 tentative 转 verified 需要证据和复现说明
pnpm gy finding-verify <taskId> \
  --finding <findingId> \
  --evidence evidence/proof/request.txt,evidence/proof/response.txt \
  --repro "1. ... 2. ... 3. ..."

# Validator 必须不同于 verifiedBy
pnpm gy finding-validate <taskId> \
  --finding <findingId> \
  --verdict confirmed \
  --method replay \
  --evidence evidence/validation/replay.txt \
  --note "独立重放得到一致结果。" \
  --validator independent-reviewer

pnpm gy findings <taskId>
pnpm gy validations <taskId> <findingId>

# 整改复测与客户处置
pnpm gy retest-request <taskId> --requester client --finding <findingId> --reason "修复后申请复测"
pnpm gy retest <taskId> \
  --finding <findingId> \
  --result fixed \
  --evidence evidence/retest/fixed.txt \
  --repro "按原步骤重放后不再复现。"
pnpm gy accept <taskId> --finding <findingId> --note "客户接受风险。" --evidence evidence/client/acceptance.txt
```

发现、验证、复测、客户接受和撤回是不同记录，不要合并成“已修复”一个字段。撤回保留历史，不删除 Finding。

### 4.8 交付与交付后更正

```bash
pnpm gy report <taskId>
pnpm gy scorecard <taskId> --out delivery-snapshot.json
pnpm gy chain <taskId>
pnpm gy audit <taskId>

# 交付后更正
pnpm gy correct <taskId> --reason "更正受影响资产范围。" --findings <findingId> --notice pending
pnpm gy correction-notice <taskId> <correctionId> --status notified --evidence evidence/delivery/notice.txt
pnpm gy corrections <taskId>
```

交付包至少包含：

- `report.md` 与其 `report-evidence/` 原始证据；
- 可复算的 delivery snapshot；
- 事件哈希链头与校验结果；
- 未验证、撤回、待复测和残余风险的明确分列；
- 操作员复核人与时间。

事件链是 TSA-ready 的 SHA-256 链头，不等于已经取得外部 RFC3161 时间戳。

---

## 5. 长时运行操作手册

| 场景 | 系统动作 | 操作员动作 |
| --- | --- | --- |
| Worker 崩溃 | Lease/Watchdog 在同任务卷重启，Durable 恢复相位 | 查 `logs`、状态和 checkpoint；不要删除 durable.sqlite |
| 上下文饱和 | 自动或主动 Relay π 换班 | 查 `workspace/relay/`；冲突时以 History 为准 |
| 长命令 | 后台作业完成通知回流 | 查 `jobs --receipts`；只重试 unknown/failed/paused |
| 缺测试账号/材料 | blocking consult，24h 后转非阻塞 | 用 `answer` 提供材料或说明暂缓理由 |
| 同一手法无进展 | 观察员与记分卡提示换面 | 用 Hint 补充约束，或结束无效 Intent 后换面 |
| 预算软阈值 | 只提示，不谎报耗尽 | 决定继续、缩面或显式设置硬上限 |
| 模型解释性拒绝 | 当前实现尚未完全收敛 | 重问、换 provider/model、拆小任务；不要记失败或写 Fact |
| 工程自保命中 | 确定性 blocked | 只读检查配置；不要试图让 Worker 改主机 VPN/代理/路由 |
| Goal 不通过 | 继续 Explore/Reason | 查 `audit` 与报告中的缺件；不要改 evidencePatterns 掩盖问题 |
| 交付后证据撤回 | 保留首次通过与当前支持度 | 生成更正记录与通知，不静默覆盖原报告 |

---

## 6. 排障速查

| 症状 | 优先检查 | 处理 |
| --- | --- | --- |
| `task-not-found` | CLI 端口、`GY_DATA_DIR`、服务实例 | 使用 8877 时加 `--base-url` 或设 `GY_PORT=8877` |
| 控制台 502 | Vite 代理目标、控制面健康 | `curl http://127.0.0.1:8877/health`；核对 `GY_CONSOLE_API` |
| 任务建档后不动 | provider 配置、Worker 日志、能力档位、工程边界 | 先看 `gy logs`，再查模型额度与工具闸原因 |
| Worker 反复重启 | checkpoint、租约、磁盘、模型超时 | 保留现场，比较 `worker.log` 与 `worker-status.json` |
| Goal 一直不通过 | evidencePatterns、evidenceChecks、Finding scope | 用 `gy audit` 找缺件；不要用空文件或无意义 JSON 凑闸 |
| 证据导入失败 | 路径是否位于 `evidence/`、符号链接/硬链接、SHA | 从受控工作副本重新导入；不要改数据库绕过路径边界 |
| Finding 无法 verified | 证据引用、SHA、repro、verifiedBy | 补齐原始证据与复现说明；tentative 不进入正式报告 |
| 独立复核被拒 | validator 是否等于 verifiedBy | 换独立复核人；不要把自审改名绕过 |
| 事件链损坏 | `gy chain` 的 brokenAt | 保留数据库与日志，定位具体事件；不要重算后覆盖原记录 |
| C2/PTY 会话断开 | 持久会话句柄、作业状态、隧道状态 | 使用会话/作业命令重新附着；不要修改主机网络配置 |
| 报告数字对不上 | 快照版本、复核撤回、任务范围 | 用 `gy scorecard --recompute <snapshot>` 离线复算 |

---

## 7. 开发指导

### 7.1 开发顺序

1. 先读 [red-team-positioning.md](./red-team-positioning.md)、[project-overview.md](./project-overview.md) 和 [long-run-contract.md](./long-run-contract.md)。
2. 从 [dev-handbook.md](./dev-handbook.md) 和 [implementation-ledger.md](./implementation-ledger.md) 找当前缺口。
3. 先改 `packages/contracts`，再改 `packages/history` 迁移与测试，最后接 Worker/API/CLI/控制台。
4. 新行为先写失败测试，再实现；状态机、证据边界和幂等性必须有反例。
5. 控制台只读 History 与 worker-status，不新建第二套状态。
6. 完成 UI 改动后启动开发服务器，用浏览器验证主路径和边界情况。
7. 契约变化才同步长跑契约与 API 文档；纯实现修复不扩写设计文档。

### 7.2 包改动落点

| 改动 | 主落点 |
| --- | --- |
| Task/Goal/Fact/Intent/Finding/Relay schema | `packages/contracts` |
| 图读写、证据闸、复核、报告、快照、事件链 | `packages/history` |
| Lease、Watchdog、Runner、API、作业回流、记忆 API | `packages/control-plane` |
| Shell、PTY、HTTP、OAST、隧道、C2、确定性边界 | `packages/exec` |
| Pi 循环、相位工具、MCP/Skill、Relay、Observe | `packages/worker` |
| 命令入口 | `apps/cli` |
| Mission Control 与图投影 | `apps/console` |

### 7.3 P16 收敛项（2026-11-24 已落码）

产品语义已落到代码（见 [implementation-ledger.md](./implementation-ledger.md) §9 与 [red-team-positioning.md](./red-team-positioning.md) §8）：

1. ✅ `AuthScopeSchema` 改为作业坐标：`authorizationNote` 可选、新增 `roe`；旧台账只读兼容。
2. ✅ `needs_authorization` → `needs_input`，缺目标/材料/坐标冲突走结构化澄清。
3. ✅ 拒绝处理链（上下文重问→结构化重问→换模型→操作员 paused 故障）；解释性拒绝不成为终态或 Fact。
4. ✅ API 与 CLI 能力档位默认统一为 `active-lab`。
5. ✅ `scopeVersion` 语义为操作配置变更；`POST /authorization` 退场（410 指引 `/scope`）。
6. ✅ 契约/状态机/会话行为测试补齐（`p16-semantics.test.ts` 覆盖五条验收口径）。

剩余兼容残留：`gy run/scope/resume` 个别文案仍含“授权”字样，属措辞清理，不影响语义。

---

## 8. 验收矩阵

### 8.1 每次提交前的最小回归

```bash
pnpm typecheck
pnpm test
pnpm smoke
pnpm eval:p17 -- --self-test
```

### 8.2 按改动范围追加

| 改动范围 | 追加验收 |
| --- | --- |
| History / 证据 / 复核 | `pnpm review:offline`、对应 package 测试、快照复算 |
| 作业 / 求助 / 记忆 / 四图 | `pnpm acceptance:r9` |
| Shell / PTY / C2 / 执行边界 | `pnpm acceptance:shell-c2` |
| 数据迁移 / 备份恢复 | `pnpm restore:selftest`，再用独立副本演练 |
| 差分 harness | `pnpm diff-harness:tsec` |
| 模型路由 / 命令评分 | `pnpm eval:p17`，fixture 标注模型、预算与日期 |
| 控制台 | 构建、类型检查、浏览器主路径与窄屏验证 |

### 8.3 真实环境验收

真实目标验收必须单独记录：

- 目标与时间窗；
- provider/model、上下文长度与 tier；
- 预算与累计 token/tool calls；
- 资产范围与 Goal；
- 每条 Finding 的证据、复核人和复测状态；
- 与裸循环或旧版本的相对差分，不把公开 benchmark 分数直接当成本项目能力。

P17 文档记录的 439 项测试是当时快照，不是当前工作树的永久保证；每次交付都应重新运行并记录实际读数。

---

## 9. 当前能力状态

| 状态 | 内容 |
| --- | --- |
| 已形成主链 | Fact–Intent DAG、CAS、证据闸、Relay、并行 Explore、Finding 独立复核、复测、更正、记分卡、快照、事件链 |
| 已形成执行面 | Shell、PTY、后台作业、C2、驻留会话、隧道/pivot、HTTP 事务、OAST、端点覆盖、主机画像 |
| P17 已补齐 | 主机枚举解析、事件哈希链、AD/云攻击图、BloodHound 导入、启动期三层模型路由、离线命令/阶段评测 |
| P16 已收敛 | 授权层退场（旧台账只读兼容）、`needs_input` 澄清、拒绝处理链、能力档位默认 `active-lab`、任务坐标提示块 |
| 部分接线 | Worker 自动注入、部分求助/唤醒、自动蒸馏、记录代理、Chromium 等按台账推进 |
| 外部依赖未完成 | RFC3161 TSA、云 API 自动采集、真实生产盲评、真实供应商故障验证 |
| 能力边界 | 进程内模型热切换、AD 全量边类型、真实阶段级端到端基准仍未完成 |

“有解析器/图/评测原语”不等于“所有环境已经自动验证”；报告必须继续区分已验证、部分实现、设计和外部依赖。

---

## 10. 看到就停的反模式

- 把聊天记录当 History，或让报告反向修改图状态。
- 用模型自述“DONE”关闭 Goal。
- 把模型解释性拒绝写成 Fact、终态或“目标无漏洞”。
- 把 `--auth` 兼容字段重新解释为逐目标授权审批。
- 给 Watchdog 写战术 if/else。
- 未完成图约束与 Intent CAS 就扩大并行 Worker。
- 用空文件、伪造 JSON 或无意义文本凑 Goal Gate。
- 让 Finder 自证，或把 tentative  Finding 放进正式报告。
- 静默覆盖撤回证据、更正记录或事件。
- 自动执行未审查的 Skill/MCP 下载物。
- 从 AGPL 上游复制实现，而不是吸收机制语义。
- 把工具数量、角色数量或公开 benchmark 分数当能力证明。

---

## 11. 文档导航

| 你要做的事 | 先读 |
| --- | --- |
| 理解项目为什么这样设计 | [project-overview.md](./project-overview.md) |
| 看懂任务如何流转 | [project-flow.html](./project-flow.html) |
| 确认产品语义与拒绝边界 | [red-team-positioning.md](./red-team-positioning.md) |
| 查运行硬约束 | [long-run-contract.md](./long-run-contract.md) |
| 改运行时或 Worker | [architecture.md](./architecture.md)、[dev-handbook.md](./dev-handbook.md) |
| 接真实渗透能力 | [pentest-exec-c2-enhancement.md](./pentest-exec-c2-enhancement.md)、[pentest-capability-extension.md](./pentest-capability-extension.md) |
| 判断当前完备程度 | [pentest-completeness.md](./pentest-completeness.md)、[p17-closing-gaps.md](./p17-closing-gaps.md) |
| 查上游机制如何吸收 | [absorb-offensive-landscape.md](./absorb-offensive-landscape.md) 及 `docs/README.md` 的吸收文档组 |
| 查 API 与控制台接线 | [api-contract-r9.md](./api-contract-r9.md)、[knowledge-library-api.md](./knowledge-library-api.md) |
| 复算与独立验收 | [evidence-review.md](./evidence-review.md)、[review-checklist-r9.md](./review-checklist-r9.md) |

完整目录见 [docs/README.md](./README.md)。
