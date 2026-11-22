# 第九轮后端接口契约（前端交接）

> 面向独立的前端任务。本文只写**已实现的可用 API、稳定 ID、请求/响应样例、状态与空值语义、错误处理与版本兼容**；不含页面、组件、样式或交互设计。
> 受验代码与运行读数见 [delivery-record.md](./delivery-record.md) §0；架构语义见 [round9-gap.md](./round9-gap.md)、[memory-layer.md](./memory-layer.md)、[graph-views.md](./graph-views.md)、[pentest-ops-design.md](./pentest-ops-design.md)。
> 所有新入口都返回 JSON；除特别说明外，路径前缀为控制面根（默认 `http://<host>:8877`）。

## 0. 通用约定

### 0.1 委托上下文（必须遵守）

- 任务记录含 `tenantId`（客户/租户）与 `engagementId`（委托）。**新建任务时显式传**；省略 `engagementId` 时该任务自成一委托。
- 任务级入口的上下文参数是可选的：
  - 不传：以路径里的 `taskId` 决定委托（单操作台默认）。
  - 传了 `?tenantId=` 或 `?engagementId=`（也可用请求头 `x-tenant-id` / `x-engagement-id`）：**必须与任务匹配**，否则 `403 {"error":"tenant-mismatch"|"engagement-mismatch","message":"…"}`。
- 平台级入口（`/memory/*`、`/archive/contact`、`/today`、`/proposals`、`/evaluations`、`/trends`）用 `?tenantId=` 过滤；`/memory/nodes` 再传 `?engagementId=` 时只返回溯源在本委托的节点。
- 纪律：**历史接触 ≠ 本次授权**。前端不得用历史命中代替 scope 校验，也不得把记忆/经验显示成"已授权"。

### 0.2 错误形状

| 状态 | 含义 | 典型 `error` |
| --- | --- | --- |
| 400 | 输入结构/取值不合法、状态机不允许、评测乱序/隔离缺失 | zod 报错文本、`evaluation-group-order-mismatch`、`frozen-evaluation-mismatch` |
| 403 | 委托/租户不匹配 | `tenant-mismatch`、`engagement-mismatch` |
| 404 | 任务/作业/记忆/提案/评测不存在 | `task-not-found`、`job-not-found`、`memory-not-found` |
| 409 | 业务冲突（输入哈希不符、不可重试状态等） | `input-sha256-mismatch`（附 `expected/actual`） |
| 422 | 材料需要受控引用（疑似明文凭据） | `secret-material-requires-controlled-ref` |

错误体统一为 `{ "error": string, "message"?: string }`；409 的 `input-sha256-mismatch` 另带 `{path, expected, actual}`。

### 0.3 稳定 ID

| 实体 | ID 形式 | 说明 |
| --- | --- | --- |
| 任务 | `taskId`（UUID） | 全站主键 |
| 委托 | `engagementId`（≤128 字符） | 跨任务署名/隔离的边界 |
| 资产节点 | `asset:<engagementId>::<规范化主机>` | **跨客户同名资产不会相同**（前缀含委托） |
| 事实/意图/发现 | `fact:<uuid>`、`intent:<uuid>`、`finding:<uuid>` | 图节点 ID 前缀固定 |
| 执行步 | `step:<uuid>` | 与 `GET /tasks/:id/trace` 的 `steps[].id` 相同 |
| 记忆 | `memory:<uuid>` | 平台级 |
| 溯源锚点 | `source:<taskId>:<refId>` | 指针不是拷贝 |
| 作业/求助/变更 | `jobId` / `consultId` / `changeId`（UUID） | 台账主键 |
| 证据 | `materialPath` + `sha256` | 撤回后仍可追；不复用路径 |
| 产物 | `{path, sha256}` | `path` 相对任务 `evidence/` |

前端可以只依赖这些 ID 做跨图跳转/下钻，但**不要**解析字符串内部的 UUID 语义，只用前缀 + 整体 ID。

### 0.4 时间、分页、空值

- 所有时间是 ISO-8601 UTC 字符串；`?now=<ISO>` 用于可控时钟复算（`handoff`、`consults/sweep`、`freshness`）。
- 目前只有 `GET /tasks/:id/trace` 有游标（`before`/`nextBefore`）；其余列表一次性返回，服务端按任务范围裁剪。前端不要假设有分页参数（会被忽略）。
- 空状态必须显式渲染，不能把空当"已完成"：

| 场景 | 字段 | 文案建议 |
| --- | --- | --- |
| 记忆库未建立 | `graph.empty=true, emptyReason="memory-not-established"` | 「全局记忆尚未建立（后续阶段接入）」 |
| 无资产 | `graph.empty=true, emptyReason="no-assets-recorded"` | 「还没有登记资产」 |
| 无执行步 | `graph.empty=true, emptyReason="no-execution-steps"` | 「还没有执行记录」 |
| 无记忆节点 | `emptyReason="no-memory-nodes"` | 「本任务还没有注入/蒸馏经验」 |
| 覆盖单元 unknown | `cell.state="unknown"` | 「未知」，不得写成「已测」 |

## 1. 持久作业（P1/P11）

### `POST /tasks/:id/jobs` → 202
```json
{
  "kind": "material-check",
  "label": "核查两份清单",
  "submittedBy": "op-a",
  "asset": "app-a-1.example.com",
  "inputs": [
    {"path":"materials/baseline.csv","sha256":"<64 hex>"},
    {"path":"materials/current.csv","sha256":"<64 hex>"}
  ],
  "options": {"goalId": "g-diff", "paceMs": 0}
}
```
- `kind`：`material-check` | `evidence-pack` | `parse-import` | `role-plan` | `role-review`。
- `sha256` 省略表示不校验；给了就必须与当前证据字节一致，否则 409。
- `options` 提交时冻结（`paceMs` 只用于可控验收，生产 0）。

响应：
```json
{"job":{"id":"<uuid>","taskId":"…","engagementId":"eng-a","kind":"material-check","label":"核查两份清单","status":"queued","scopeVersion":1,"asset":"app-a-1.example.com","submittedBy":"op-a","options":{…},"inputs":[…],"progress":{"done":0,"total":2,"message":"queued"},"artifacts":[],"error":null,"receiptKey":"<jobId>:0","deliveredAt":null,"attempt":0,"bootId":null,"pauseState":"none","startedAt":null,"finishedAt":null,"createdAt":"…","updatedAt":"…","lateResult":false,"result":null}}
```

### `GET /tasks/:id/jobs[?receipts=1]`
返回 `{jobs:[…]}`；`receipts=1` 时每项多 `receipts:[{deliveryKey,status,deliveredBy,at}]`。

### `GET /tasks/:id/jobs/:jobId` → `{job, receipts}`

### `POST /tasks/:id/jobs/:jobId/retry` → 202
只允许 `unknown` / `failed` / `paused`；其它状态 400。作业重新入队（`attempt+1`）。

### `POST /tasks/:id/jobs/:jobId/receipt` → 200
```json
{"deliveryKey":"notify-op-b","deliveredBy":"op-a","note":""}
```
响应 `{receipt:{jobId,deliveryKey,status,deliveredBy,note,at}, duplicate:false}`。同一 `deliveryKey` 重投 `duplicate:true`，不新增回执、不重复发事件。

### `POST /tasks/:id/jobs/:jobId/cancel` → 200

### 状态语义（前端徽章）

| status | 含义 |
| --- | --- |
| `queued` | 排队 |
| `running` | 执行中 |
| `draining` | 暂停时正在收尾（`pauseState="draining"`） |
| `paused` | 暂停（`pauseState="stopped"` 或 `"unknown"`） |
| `succeeded` / `failed` | 终态，`result` / `error` 有值 |
| `unknown` | 控制面重启后无法确认（**不能显示为成功**） |
| `canceled` | 操作员或停止任务时取消 |

`lateResult=true`：提交时的 `scopeVersion` 小于完成时的当前版本；结果保留但不得自动计入当前结论。

## 2. 人工求助与交接（P1/P11）

### `POST /tasks/:id/consults` → 201
```json
{"question":"范围收缩后是否继续验证 app-a-1？","options":["继续","停止"],"context":"…","blocking":true,"askedBy":"agent"}
```
响应 `{consult:{id,taskId,engagementId,question,options,context,blocking,status:"open",scopeVersion,createdAt,dueAt,releasedAt,answeredAt,answeredBy,answer,relatedIntentId,relatedJobId}}`。`dueAt = createdAt + 24h`。

### `POST /tasks/:id/consults/:consultId/answer` → 200
```json
{"answer":"继续验证，仅限已授权资产","answeredBy":"op-b","injectHint":true}
```
响应 `{consult, hintId}`；`injectHint=true` 会写一条 `source="human"` 的 Hint，`tags` 含 `consult:<id>`。

### `POST /tasks/:id/consults/sweep` → 200
`{"now":"<ISO>"}`（可选）。返回 `{released:[consult…], now}`。
**语义**：满 24h 只把 `blocking` 置 false、写 `releasedAt`，`status` 仍为 `open`；问题在交接包里继续显示为待答。

### `GET /tasks/:id/consults` → `{consults:[…]}`

### `GET /tasks/:id/handoff?nextOwner=&now=` → `{handoff, releasedConsults}`
```json
{
  "taskId":"…","engagementId":"eng-a","tenantId":"customer-a","generatedAt":"…","scopeVersion":2,
  "scope":{"targets":["app-a-2.example.com"],"outOfScope":[],"capability":"scan","version":2,"updatedAt":"…"},
  "status":"paused",
  "completed":[{"id":"g-diff","title":"两份清单差异核算","assertedAt":"…"}],
  "blocked":[{"kind":"consult","id":"…","detail":"…","needsAnswer":true}],
  "latestRetractions":[{"kind":"evidence","id":"http/tx-1.txt","reason":"材料撤回","at":"…"}],
  "openQuestions":[{"id":"…","question":"…","blocking":false,"dueAt":"…","releasedAt":"…","scopeVersion":2}],
  "jobs":[{"id":"…","kind":"material-check","status":"succeeded","label":"…","scopeVersion":1,"lateResult":true}],
  "nextOwner":"op-b",
  "notes":["后台作业：…","未答问题 1 条；其中阻塞 0 条","本交接包是只读投影；…"]
}
```
`blocked[].needsAnswer=true` 表示**必须人工明确答复**才能继续；其余受阻项（作业可重试、目标未过）不需要回答。

## 3. 材料与证据语义（P2/P6）

### `POST /tasks/:id/materials` → 201
```json
{"path":"materials/baseline.csv","content":"host,version\n…","kind":"asset-inventory","asset":"app-a-1.example.com","source":"operator-import","parser":{"name":"csv","version":"builtin-v1"},"observedAt":"<ISO>","locator":"rows=4","secretRef":null,"sensitivity":"redacted","ttlDays":14}
```
响应 `{material, classification}`：
- `material.status`：`accepted` | `unsupported` | `unknown-owner` | `expired`；`material.reason` 给原因（`unrecognized-material-format`、`asset-not-in-scope`、`material-older-than-7d`…）。
- 疑似明文凭据且没有 `secretRef` → 422；给了 `secretRef` 时只落 `{"secretRef","locator","sha256OfOriginal"}`，`sensitivity="controlled-ref"`，不改写原文。
- 材料**永远不会**因为导入成功就被当成"已验证"；`verified` 只来自 finding 状态。

`kind`：`asset-inventory` | `config-check` | `http-transaction` | `manual-retest`；省略时按文件名/内容嗅探，嗅探失败标 `unsupported`。

### `GET /tasks/:id/materials` → `{materials:[…]}`

### `POST /tasks/:id/coverage-cells` → 201
```json
{"asset":"app-a-1.example.com","technique":"AUTHZ-BOLA","state":"manual","reviewer":"op-b","reason":"人工核对未发现","evidenceRefs":["http/tx-2.txt"]}
```
`state`：`manual` | `verified`（人工确认已覆盖）。

### `GET /tasks/:id/coverage-matrix`
```json
{"cells":[{"asset":"app-a-1.example.com","technique":"CWE-89","state":"verified","materialRefs":["materials/baseline.csv"],"findingIds":["…"],"manualRefs":[],"retractedOnly":false,"independentSupport":2,"notes":[]}],
 "summary":{"total":5,"byState":{"verified":1,"retracted":1,"manual":1,"unknown":2}},
 "graph":{…surface 图…},
 "retractedEvidence":["http/tx-1.txt","<sha>"]}
```
派生优先级：**verified > manual > attempted > retracted > material > unknown**。`retractedOnly=true` 表示唯一依据已被撤回，必须显示「待复核」。

### `GET /tasks/:id/freshness?now=` → `{now, fresh, needsReview:[{factId,title,layer,tags,createdAt,freshness:{state,ageMs,ttlMs,freshUntil,reason}}]}`
TTL 默认：资产 7d、finding 14d、scope 365d、其它 30d。**只产生待复核状态，不删除/不改写 Fact。**

### `POST /tasks/:id/changes` → 201
```json
{"kind":"account","asset":"app-a-1.example.com","location":"local user gy-test","rollbackCmd":"userdel gy-test","beforeMaterial":{"path":"changes/before.txt","content":"…"},"registeredBy":"op-a","note":"临时账号"}
```
`kind`：`webshell|account|config|persistence|db|network|file`。

### `GET /tasks/:id/changes` → `{changes, open, script}`
### `POST /tasks/:id/changes/:changeId/confirm` → `{change}`
### `GET /tasks/:id/rollback` → `text/x-shellscript`（逆序脚本，**只生成不执行**）

## 4. 四图与因果（P10）

四个视图共用同一 DTO：
```json
{"taskId":"…","engagementId":"…","view":"assets|surface|execution|memory","generatedAt":"…","empty":false,"emptyReason":null,
 "nodes":[{"id":"asset:eng-a::app-a-1.example.com","kind":"asset","label":"app-a-1.example.com","badge":"seed","data":{}}],
 "edges":[{"id":"asset:…->technique:CWE-89:coverage","from":"…","to":"…","kind":"coverage","label":"verified","broken":false}],
 "notes":["资产 3 个，发现意图 1 个；无 Intent 触碰的资产 2 个。"]}
```
- `GET /tasks/:id/graphs/assets`：asset/scope/intent 节点；边 `authorizes`、`seeded`、`discovered`、`lineage`、`same-family`。缺失意图/前驱事实的边 `broken=true`。
- `GET /tasks/:id/graphs/surface`：asset / technique / material / finding 节点；边 `coverage`（label 即状态，`retractedOnly` 时 broken）、`material`、`found-on`、`classified-as`。
- `GET /tasks/:id/graphs/execution`：slot / step / tool_gate / timeout / relay / intent / job 节点；边 `lane`、`sequence`、`audit`、`depends-on`。节点数≈`/trace` 步数；拒绝/超时节点用徽章区分。
- `GET /tasks/:id/graphs/memory`：memory / source / task 节点；边 `derived-from`、`contradicts`、`supersedes`、`injected-as`。只含本委托可见的来源；库未建立时 `emptyReason="memory-not-established"`。
- `GET /tasks/:id/causality/:findingId` → `{trace:{findingId,nodes,edges,broken:[{from,to,reason}],upstream:[factId],downstream:[findingId]}}`。`broken` 必须显示为断点，不得补全。
- `GET /today?tenantId=&engagementId=` → `{generatedAt,tenantId,engagementId,tasks:[{taskId,name,status,scopeVersion,openQuestions,runningJobs,lateJobs,blockedGoals,staleFacts,nextAction}]}`。

## 5. 记忆与档案（P8）

- `POST /memory/nodes`（草稿）→ 201
  ```json
  {"kind":"lesson","title":"登录口先测布尔盲注","body":"…","matchKeys":[{"kind":"family","value":"web-login","strength":"hard"}],"provenance":[{"taskId":"…","engagementId":"eng-a","refKind":"finding","refId":"…","path":"http/tx-a.txt","sha256":null}],"supersedes":"<可选记忆 id>","contradicts":"<可选记忆 id>"}
  ```
  `provenance` 至少一条（无源不记忆）；`kind`：`lesson|playbook|counterexample|tool-artifact`。
- `GET /memory/nodes?tenantId=&engagementId=&status=&kind=` → `{nodes:[…]}`；节点含 `status`（`draft|confirmed|retracted|superseded`）、`reuseCount`、`supportRetracted`、`reviewer`、`reviewedAt`、`reviewReason`。
- `POST /memory/nodes/:id/review` → `{node}`：`{"decision":"confirm|retract","reviewer":"op","reason":"…"}`。draft 不能被注入；retract 保留节点。
- `GET /memory/nodes/:id/references[?engagementId=]` → `{references:[{memoryId,taskId,engagementId,hintId,layer,matchedKeys,reason,injectedAt}]}`。
- `POST /tasks/:id/memory/inject` → `{injected:[{memoryId,title,layer,matched,matched:"…",hintId,injection}], considered}`。只注入本委托溯源、`confirmed` 的节点；硬键命中为主，Explore 命中当前资产最多追加 2；写入 `source="system"` Hint，**不落 Fact**。
- `GET /tasks/:id/memory` → `{injections:[…]}`。
- `GET /archive/contact?targets=a,b&tenantId=&limit=` → `{query,hits:[{taskId,engagementId,name,status,finishedAt,findings,verifiedFindings,retractedFindings,pointer:{kind,id,sha256},mayHaveDrifted,sameAsset}],nonBlocking:true,note}`。只回指针，下钻走源任务；非阻塞。
- `POST /tasks/:id/model-request`（模拟）→ `{authenticity:"simulated",billing:"none",egress:{tenantId,engagementId,allowed},payload:{task,hints,memory,facts}}`。用于验证"模拟模型请求不出客户"；**不调用真实供应商**。

## 6. 飞轮（P9-F2/F3）

- `GET /trends?tenantId=&engagementId=` → `{points:[{batch,taskId,engagementId,at,goalsPassed,goalsTotal,verifiedFindings,retractedFindings,tokens,wallMs,reuseCount}],note}`。
- `POST /proposals` → 201：`{kind:"memory|skill|param|prompt|tool",title,body,evidence:[{taskId,pointer,sha256}],expectedGain,configKey,previousValue,proposedValue}`；`evidence` 为空 → 400。
- `POST /proposals/:id/decide`：`{decision:"approve|reject",decidedBy,reason}`。
- `POST /proposals/:id/promote`：`{promotedBy,evaluationRunId}`；要求 `approved` 且评测 `metrics.adjudicated>0`。
- `POST /proposals/:id/rollback`：`{rolledBackBy,reason}`；保留 `promotedAt` / `evaluationRunId`（回退后可复算用过哪个版本）。
- `GET /proposals/:id/events` → `{events:[{action:"created|approved|rejected|promoted|rolled-back",actor,reason,at}]}`。
- `POST /evaluations` → 201：`{suite,group,order,frozen,seed,cases:[FindingEvalCase],taskIds,isolatedFrom}`；响应 `{evaluation}`，含 `metrics.{tp,fp,fn,pending,adjudicated,precision,recall,severityAgreement,denominators}`。
  - 同一 suite 首次运行定义组顺序；后续 order 必须一致，新组必须追加在最后。
  - `isolatedFrom` 必须覆盖该 suite 已完成的其他组（否则 400 `evaluation-isolation-missing:<group>`）。
  - 冻结组：同 `suite+group+seed` 内容不可替换（400 `frozen-evaluation-mismatch`）；完全相同幂等返回。
  - `pending` 单列，不进 precision/recall 分母；`recall = tp/(tp+fn)`。

## 7. 角色与韧性（P4）

- `POST /tasks/:id/roles`：`{role:"planner|reviewer|assistant",kind:"plan|review|incident",input:{…},simulated:true}`
  - `plan`/`review` → 202 + 作业（`role-plan`/`role-review`），完成后 `GET /tasks/:id/jobs` 里 `result.output` 含 `{summary,proposals,opinions,pauseRequested…,authority,authenticity:"simulated"}`。
  - `incident`（仅 assistant）→ 同步返回 `{output,paused,authenticity:"simulated",billing:"none"}`；严重信号触发 `paused`，**恢复必须操作员**。
  - 权限固定：规划者可提案不可复核；复核者可复核；辅助者可请求/触发暂停，**不可** stop/扩 scope/派单。
- `POST /tasks/:id/provider`：`{provider,fault:"rate-limit|timeout|insufficient-balance|egress-denied",attempt,fallbackAllowed,billing:"none|usage-only|billed",tokens}` → `{plan:{action:"retry|failover|blocked",backoffMs,nextProvider,reason,egressAllowed,costVisible,billing},duplicateAccounting,egressEngagement}`。
  - 外发受限（`egress-denied` 或备用未获准）→ `blocked`，**不得换通道**。
  - `billing:"none"` 时 `costVisible=false`：前端不得把 Token 降低显示为"省钱"。
- `GET /tasks/:id/provider` → 历史故障处置事件。
- `GET /tasks/:id/alerts?threshold=N` → `{alarm,reason,toolCallsSinceFact,threshold,waitingOnConsult}`；等待人工答复期间不算无进展。

## 8. 版本兼容与前端纪律

1. **只加不改**：新增字段可随时出现；前端必须忽略未知字段/未知枚举值（`state`、`status`、`kind` 都可能扩展）。
2. **不要自己拼 ID**：跨图跳转只用服务端返回的 `id`；资产节点 ID 含委托前缀，前端不要用主机名当全局键。
3. **失败/未知不可美化**：`unknown`、`retracted`、`unsupported`、`expired`、`lateResult`、`broken` 必须原样呈现（这是审计信息）。
4. **只读投影**：图与记忆视图不提供写操作；写一律走本文列出的 POST 入口。
5. **契约版本**：本轮新增契约模块 `packages/contracts/src/ops.ts`；旧的 Task/Finding/Reconcile 契约未破坏。前端若需要 `schema` 校验，直接依赖 `@gongyuai/contracts` 的 zod schema（`BackgroundJobSchema`、`HandoffPacketSchema`、`GraphViewSchema`、`MemoryNodeSchema`、`ProposalSchema`、`EvaluationRunSchema`、`ProviderAttemptSchema`…）。
6. **未提供的**（不要等）：真实供应商调用、会话/隧道/浏览器对象、PTES/等保模板渲染、前端页面。它们按 [owner-unverified-r9.md](./owner-unverified-r9.md) 单列。
