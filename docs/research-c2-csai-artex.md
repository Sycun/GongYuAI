# GongYuAI 的 C2 / shell 能力：CyberStrikeAI 与 ARTEX 的可抄设计与不可抄的坑

调研日期 2026-11-23 · 只读调研（未改任何代码、未提交 git、未跑扫描）· 所有 `file:line` 均为实机存在，可逐条复核。
参照物：`/Users/sycpro/CyberStrikeAI`（Go 单体 AI 渗透平台）、`/Users/sycpro/ARTEX`（Go agent 平台，执行内核在依赖 `github.com/Autumn-27/norma v0.4.3`）。
本文所有"我们"指 GongYuAI（`/Users/sycpro/GongYuAI`）。

---

## 0. 结论

1. CyberStrikeAI 最值钱的不是四种 listener，而是"任务表 CAS + 终态不可覆盖 + 自适应看门狗 + 单飞调度"这套收敛逻辑；listener 只是可替换的传输插件。
2. 它的授权是 7 层串联，"已授权仍被拦"绝大多数发生在**项目边界**与**HITL 降级**两处，而不是 RBAC 权限点本身。
3. ARTEX 真正可抄的是"用 AST 判 shell，而不是正则"和"给审查模型喂什么、绝不给什么"的输入边界契约，不是它的规则表。
4. 我们的执行面（`scope`/`proc`/`jobs`/`sessions`）比 C2 面成熟得多；C2 是"骨架对、收口错"——raw 任务的成败判定目前恒为 `success`（`packages/exec/src/c2.ts:551`），这是必须立刻修的正确性缺陷，不是优化项。
5. 下一步只做三件：任务收口与看门狗、文件通道（sha256 + 分块）、工具面收敛并统一走审批台账。

---

## 1. CyberStrikeAI 的 C2 设计

### 1.1 分层：Manager 唯一门面 + Listener 插件

- `Manager` 是唯一入口，HTTP handler / MCP 工具 / HITL / 业务钩子全走它，不直接碰 listener 实现（`/Users/sycpro/CyberStrikeAI/internal/c2/manager.go:20-40`）。
- `Listener` 接口只有三个方法 `Type/Start/Stop`（`internal/c2/listener.go:14-21`），具体类型靠 `ListenerRegistry` 工厂注册（`internal/c2/listener.go:36-58`），启动时一次性注册四种（`internal/app/c2_lifecycle.go:25-28`）。
- 好处：Manager 不感知传输，测试可注入 mock 工厂（`listener.go:34-35` 注释）。坏处：任何需要"传输特性"的能力都被塞进 listener，导致能力矩阵不对称——`buildTCPCommand` 只支持 9 种 task_type（`listener_tcp.go:336-377`），而类型系统声明了 18 种（`types.go:79-98`），不支持的会走失败分支（`listener_tcp.go:275-278`）。

### 1.2 listener 类型、绑定/端口策略、TLS、token、会话唯一化与重连

| 维度 | 实现 | 证据 |
| --- | --- | --- |
| 类型集合 | `tcp_reverse` / `http_beacon` / `https_beacon` / `websocket` | `internal/c2/types.go:24-29`、`:42-50` |
| 绑定默认值 | 空 bind_host → `127.0.0.1`（要暴露必须显式改 `0.0.0.0`） | `internal/c2/manager.go:174-177` |
| 回调地址分离 | `callback_host` 独立于 `bind_host`，`0.0.0.0/::/空` 时探测外网 IP，失败回落 127.0.0.1 | `types.go:143`、`manager.go:185-187`、`internal/c2/beacon_host.go:14-34` |
| 端口校验 | 只校验 `1..65535`；真实占用在 `net.Listen` 时识别为 `ErrPortInUse`（HTTP 409） | `types.go:252-257`、`types.go:245`、`listener_tcp.go:64-72`、`listener_http.go:109-115` |
| 加密 | 每 listener 独立 AES-256-GCM 密钥；TCP 额外用魔数 `CSB1` 分帧 | `manager.go:193-200`、`internal/c2/crypto.go:39-91`、`internal/c2/tcp_beacon_server.go:24-30` |
| token | `create` 时生成并落库，**只在 create 响应里返回一次**，list/get/start/stop 一律清空 | `manager.go:197-200`、`internal/app/c2_tools.go:96-97`、`:109-110`、`:146-152`、`internal/handler/c2.go:125-127` |
| token 校验 | constant-time 比较；失败伪装 404 HTML，不暴露这是 C2 | `listener_http.go:448-458`、`:461-465`、`listener_websocket.go:136-141`、`tcp_beacon_server.go:65-72` |
| TLS | `https_beacon` 走 `ServeTLS`；可配置证书路径或自动自签 | `listener_http.go:117-128`、`types.go:132-134`、`listener_http.go:517-562` |

**会话唯一化（三个入口三套策略，这是设计要点）**

1. beacon 自带 `implant_uuid`：同一 uuid 复用会话，但 uuid 已属于另一个 listener 时直接 `ErrAuthFailed`（`manager.go:358-364`）。心跳里上报的 sleep/jitter **不会**覆盖操作员设置（`manager.go:393-401`）。
2. 裸 TCP shell：`uuid = sha256(listenerID|remoteIP)[:8]`，同源重连复用同一会话（`listener_tcp.go:156-159`）。
3. curl oneliner：`uuid = curl_<ip>_<sha256(ip+listenerID+X-Session-Token)>`，同 IP 不同 token 仍是不同身份（`listener_http.go:201-204`）。

**重连语义**：同一 sessionID 的新连接会踢掉旧连接（`listener_tcp.go:187-191`），且旧连接断开回调不会把新连接建立的会话标死——有测试锁这条（`internal/c2/task_terminal_test.go:46-61`）。这是"重连不丢会话、旧连接不误杀"的最小实现。

**明文兼容是鉴权面的削弱**：check-in 解密失败会回退按明文 JSON 解析（`listener_http.go:176-190`），而 result 端强制要求解密（`:298-302`）。也就是说 listener token 是唯一防线，密钥在这条路径上没能加码。

### 1.3 session 状态机、心跳/看门狗、误报判定

声明 4 态 `active/sleeping/dead/killed`（`types.go:55-60`），实际写入的只有 2 个：

- `active`：`IngestCheckIn`（`manager.go:388`）；TCP 侧收到任意数据或读超时也刷 `active`（`listener_tcp.go:222`、`:236`）。
- `dead`：`MarkSessionDead`（`manager.go:467-473`），由看门狗或 TCP 连接关闭触发。

**`sleeping` 与 `killed` 没有任何写入点**：`sleeping` 只出现在看门狗遍历里（`internal/c2/session_watchdog.go:68`），`killed` 只在入队校验里被读（`manager.go:503`）。前端按 `killed` 筛永远返回空——这是"声明态无迁移"，第 5 节第 1 条。

**看门狗**（`session_watchdog.go:12-27` 的设计注释就是标准答案）：

- 单 goroutine + 15s ticker，不给每个会话开 timer（`:30-55`、`:66-90`）。
- 阈值 = `sleep * (1 + jitter%) * gracePct(3.0)`，再以 `minGrace(30s)` 兜底；`sleep <= 0`（交互式 TCP）用 `minGrace*2 = 60s`（`:127-151`）。
- 不读 `implant_uuid`，纯按 `last_check_in` 判定，与 listener 类型解耦（`:19`）。

**误报判定分三层，性质完全不同**：

1. 自适应阈值（上）——算法规避误报。
2. 交互式连接"读超时 = 存活"，继续刷心跳（`listener_tcp.go:234-237`）——协议层规避误报。
3. 事后筛选 `suspicious`：`status='dead' AND (hostname LIKE 'tcp_%' OR username='unknown' OR pid=0)`（`internal/database/c2.go:692-696`）——纯启发式。

第 3 条只能用于人工筛选，**不能用来自动清理**：真实 legacy shell 同样满足这三个特征，会被一起标成"疑似误报"。

### 1.4 task 生命周期：queued→sent→success/failed/cancelled

声明 6 态（`types.go:65-72`），但 **`running` 没有写入点**：只在 TCP 单飞判断里被读（`manager.go:665`）。真实迁移是 `queued → sent → success|failed|cancelled`。

**入队 `EnqueueTask`**（`manager.go:492-627`）的校验顺序值得照抄，因为每一步都对应一个可区分的错误码：

1. 会话存在且不是 `dead/killed` → 否则 409 `session_inactive`（`manager.go:503-505`）。
2. OPSEC 命令黑名单：`listener config.command_deny_regex` 正则命中 → 403 `command_denied`（`manager.go:507-529`，配置在 `types.go:139`）。
3. 并发上限：数 `queued + sent`，超 `max_concurrent_tasks` → 429 `concurrent_limit`（`manager.go:531-550`，配置在 `types.go:141`）。
4. 危险类型走 HITL（见 1.7），否则直接 `approval_status = approved`（`manager.go:564-616`）。
5. 落库 `queued`（`manager.go:618-626`）。

**派发 `PopTasksForBeacon`**（`manager.go:652-686`）：

- TCP 强制单飞：只要存在 `sent` 或 `running` 就返回空，且 `limit=1`（`:662-675`）——交互式连接不能并发下发。
- 真正的"取任务"在 DB 事务里完成：`SELECT queued AND approval_status IN ('', 'approved')` → `UPDATE status='sent', sent_at=now`（`internal/database/c2.go:1275-1333`，关键行 `:1294`、`:1318-1327`）。**读到即 sent，不需要额外 ack**，天然幂等。

**等待/超时/取消/落库**：

- 取消只允许 `queued/sent`，`running` 及以上返回 409 `task_running`；取消用 CAS 写（`manager.go:630-648`，`ExpectedStatus` 在 `:643`）。
- 结果回传幂等：任务已是 `success/failed/cancelled` 时 `return nil`，**迟到结果直接丢弃**（`manager.go:724-726`），有测试锁（`task_terminal_test.go:29-44`）。
- 所有状态写入都带 `ExpectedStatus`（`database/c2.go:867-878`、`:925-936`），`affected == 0` 返回 `sql.ErrNoRows`——并发写失败而不是静默覆盖。这是整套设计里最该抄的一条。
- 离线的 `sent` 任务由看门狗过期：超过 `payload.timeout_seconds`（默认 60）+ minGrace → `failed`，错误文案明确写"远端进程是否终止尚未确认"（`session_watchdog.go:92-124`，关键行 `:106-108`、`:117`）。这个措辞很重要：它不假装知道远端状态。
- 文本结果落 `result_text/error`；二进制落 `saveResultBlob` → `storageDir/results/<taskId><suffix>`（`manager.go:760-768`、`:798-825`），suffix 走白名单正则（`:46`、`:840-852`），路径逃逸用 `filepath.Rel` 拦截（`:854-871`）。**不加密、不哈希、不分块**。

**AI 侧与 HTTP 侧各有一次 wait 实现**：MCP 是 500ms 轮询到终态、默认 60s（`internal/app/c2_tools.go:479-503`），HTTP 是同一套逻辑再写一遍、超时回 408（`internal/handler/c2.go:673-704`）。两份实现迟早漂移（第 5 节第 6 条）。

### 1.5 文件上传下载：分块、sha256、归属校验

- 上行：`POST /upload?task_id=`，AES-GCM 解密后**整块**写 `storageDir/uploads/<taskId>.bin`，`MaxBytesReader` 256 MiB（`listener_http.go:332-370`、`manager.go:827-838`）。
- 下行：`GET /file/<task_id>`，从 `storageDir/downstream/<taskId>.bin` 读全文，AES-GCM 加密后 base64 塞进 JSON 返回（`listener_http.go:374-424`）。
- 归属校验做了两层：`task_id` 字符白名单（`manager.go:47`、`:829`）+ 目录逃逸校验（`listener_http.go:405-415`）；下行额外要求 `X-Session-Token` 能通过该 listener 的身份绑定（`:390-400`）。
- TCP 通道的 `download` 只是把内容 `base64` 成文本回传（`listener_tcp.go:363-372`），二进制或大文件必崩；`buildTCPCommand` 的注释自己写了"upload/screenshot 等建议使用 http_beacon"（`listener_tcp.go:334-335`）。

**结论（对我们的关键判断）**：这套文件通道是"小截图/小配置"级别的，**没有分块、没有 sha256、没有断点、全量进内存**（`listener_http.go:346`、`:416`）。GongYuAI 的证据=文件，这块不能照搬，必须按 2.5 的内容寻址方案自己写。

### 1.6 AI 工具面怎么切：8 个统一工具 + 与 HTTP 路由的关系

工具名在 `internal/mcp/builtin/constants.go:68-77` 定义，在 `internal/app/c2_tools.go:25-35` 注册：

| 工具 | action 枚举 | 关键参数形态 | 证据 |
| --- | --- | --- | --- |
| `c2_listener` | list/get/create/update/start/stop/delete | 扁平参数 + `config` 对象；`bind_port` 必填整数；create 额外返回一次性 `implant_token` | `c2_tools.go:54-84`、`:146-152` |
| `c2_session` | list/get/set_sleep/kill/delete/delete_batch | `kill` 不删记录，而是入队一个 `exit` 任务（`:311-320`）；`suspicious` 布尔做误报筛 | `c2_tools.go:237-263`、`:311-320` |
| `c2_task` | 15 个 `task_type` | 全部参数平铺在 schema（21 个属性），只有 `session_id`/`task_type` 必填；`timeout_seconds` **恒写入 payload** | `c2_tools.go:347-384`、`:391` |
| `c2_task_manage` | get_result/wait/list/cancel | `wait` 是 500ms 轮询 | `c2_tools.go:444-526` |
| `c2_payload` | oneliner/build | oneliner 有"kind × listener 类型"兼容矩阵 | `c2_tools.go:532-...`、`payload_oneliner.go:15-23`、`:35-48` |
| `c2_event` | 单个查询动作 | 无 `session_id`/`task_id` 时要求 global scope | `c2_tools.go:640-676`、`mcp_authorization.go:208-221` |
| `c2_profile` | list/get/create/update/delete | 写操作要求 global scope | `c2_tools.go:689-...`、`mcp_authorization.go:222-238` |
| `c2_file` | list/get_result | `get_result` 只返回**文件路径**，不返回内容 | `c2_tools.go:841-890` |

**切法结论**：按"资源"切，不按"动作"切；每个资源一个工具 + 一个 `action` 枚举，其余参数平铺。代价是 schema 很宽（`c2_task` 21 个属性），模型容易传无关参数；收益是工具数量可控（35 条 HTTP 路由 → 8 个工具入口）。

**工具面与 HTTP 路由的关系：不复用 handler，复用 Manager。**

- HTTP 侧 35 条路由挂在 `/c2`（`internal/app/app.go:1443-1487`），未启用时中间件统一回 503 `c2_disabled`（`app.go:1444-1453`）。
- MCP 侧直接调 `m.DB()` / `m.CreateListener` / `m.EnqueueTask`（`c2_tools.go:91`、`:102`、`:138`、`:203`、`:432`），HTTP 侧走 `C2Handler` → 同一个 Manager（`internal/handler/c2.go:49-61`）。
- 结果是**校验逻辑写两遍**：项目过滤、limit、端口、脱敏各一份。例：MCP list 走 `ListC2ListenersForAccess`（`c2_tools.go:91`），HTTP list 走另一条（`handler/c2.go:63`）；`c2_file get_result` 只给路径，HTTP 的 `DownloadResultFile` 先做资源鉴权再 `FileAttachment`（`handler/c2.go:1189-1209`）。

### 1.7 授权/审批：7 层，以及"已授权仍被拦"到底发生在哪

| 层 | 机制 | 证据 |
| --- | --- | --- |
| L1 传输 token | constant-time 比较，失败伪装 404 | `listener_http.go:448-465` |
| L2 身份绑定 | `BindC2HTTPIdentity` + `X-Session-Token`，同 IP 不同 token 不同身份 | `listener_http.go:217-221`、`:430-436` |
| L3 资源归属 | `task → session → listener` 三方必须一致，否则 `ErrAuthFailed` | `manager.go:707-709` |
| L4 RBAC 权限点 | `c2:read` / `c2:write` / `c2:delete`，按 action 映射 | `internal/app/mcp_authorization.go:270-280`；HTTP 侧 `internal/security/rbac_middleware.go:182-183`、`:210-219` |
| L5 作用域强制 | profile 写、未过滤事件列表要求 `scope=all` | `mcp_authorization.go:222-238`、`:208-221`；`rbac_middleware.go:235-238` |
| L6 项目边界 | 会话/监听器所属项目 ≠ 当前对话绑定项目 → 拒绝 | `mcp_authorization.go:325-355`，资源→项目解析在 `:376-402` |
| L7 OPSEC | 命令黑名单 403 / 并发上限 429 / 会话 dead 409 | `manager.go:507-550` |
| L8 HITL | 危险 task_type → `pending` → 拒绝或超时即 `failed` | `manager.go:564-616`、`internal/app/c2_hitl_bridge.go:48-139` |

**"已授权仍被拦"的实际落点（按发生频率排序）**：

1. **L6 项目边界**。对话绑定项目 A、监听器属项目 B，则该会话下所有 C2 工具调用全被拒，文案是 `resource c2_session s_xxx belongs to project B, current conversation project is A`（`mcp_authorization.go:348-353`）。用户看到的是"我有 c2:write 却什么都做不了"。
2. **L8 HITL 静默降级，两个方向都会错**。gate 依赖 `conversationID`，AI 侧 `ConversationID` 为空时 `gate(convID, MCPToolC2Task)` 的判定与人类协同界面不一致（`manager.go:570-571`）；反过来若开了人机协同但 bridge 未注入，危险任务也会直接 `approved`（`manager.go:614-615`）。前者该拦没拦，后者该问没问。
3. **L3 归属**。多个 listener 共用同一 beacon 二进制时会 uuid 冲突 → 401，表现为"刚上线就掉"。
4. **L7 并发上限 429**。模型常把 429 当"稍后重试"而不是"会话已满"。
5. **L4/L5** 只在多用户部署下才可能挡人；单用户形态是纯税。

### 1.8 长任务 / 反弹 shell 怎么避免阻塞

- **派发从不在 accept 里阻塞**：TCP 有独立 dispatcher goroutine（500ms tick，`listener_tcp.go:245-270`），每条任务 `go runTaskOnConn`（`:265`）；WS 同构（`listener_websocket.go:240-...`）。
- **但"读结果"是同步的**：`readUntilMarker` 硬编码 60s 读超时（`listener_tcp.go:302`、`:383`），叠加单飞（`manager.go:662-675`）→ 任何超过 60s 的命令必然 `failed`，且残留输出要靠 `drainStaleData` 兜（`listener_tcp.go:451-462`）。这是 TCP 模式的硬伤，不是配置项。
- **HTTP beacon 天生异步**：check-in 只回 `has_tasks`（`listener_http.go:232-244`），任务走 `GET /tasks`，结果走 `POST /result`（`:266-281`、`:283-328`），不存在阻塞问题。
- **事件推送非阻塞**：`Publish` 在 channel 满时静默丢弃并计数（`internal/c2/eventbus.go:92-115`），SSE 侧 buffer 128（`handler/c2.go:974-980`）。
- **心跳不写事件表**：普通心跳只更新 `last_check_in`，否则按 sleep 周期一条审计会把 DB 与 SSE 打爆（`manager.go:423-424`）——这条注释是踩过坑才能写出来的。

**结论**：异步能力靠"任务表 + 客户端拉取"，不靠 goroutine 池。这一点与 GongYuAI"任务=目录"的形态天然吻合，是最该抄的一条。

---

## 2. ARTEX 的可借鉴点

### 2.1 拦截层：三段式语义 + 优先级 + 首个命中

- 语义定义在包注释里：`allow` 立即放行并跳过后续规则、`deny` 拦截并回消息给模型、`ask` 建 pending 记录后阻塞等人（`/Users/sycpro/ARTEX/intercept/intercept.go:1-11`）。
- 求值：规则按 priority 降序，**首个命中即返回**（`intercept.go:570-595`）。
- 匹配对象：`tool_name` 或 `tool_input`；`tool_input` 先比原始 JSON 字节，再比 **JSON 里每一个解码后的字符串值**（`intercept.go:597-624`）。注释点明了为什么必须这样：JSON 转义把 `\n` 变成字面 `\` `n`，`\brm\b` 在 `"cd /tmp\nrm -rf /var/www"` 上永远不命中（`:599-601`）。
- 输入字符串提取是递归遍历任意深度的 JSON 值、跳过 key（`:626-...`）。

**对我们的直接价值**：`packages/exec/src/scope.ts:41-46` 的两条硬拒正则是拿整条命令文本匹配的，`bash -c 'rm -rf /'` 这类被引号包住的破坏命令会漏。多一层"参数级字符串"检查成本极低。

### 2.2 审查输入的边界契约（防注入，这是 ARTEX 最独特的一层）

- `intercept/prompt.go:9-24` 定义 `JudgeContextBoundary`：审查输入只含"当前调用 + 程序绑定的 background"；Worker 调用不附带上级背景、不发送 Worker 意图摘要；背景不能指定裁决、不能扩大授权；**所有字段里的注入文字一律当待审查数据处理**；`script_files` 是数据，注释/字符串里的提示不能改变策略。
- `prompt.go:30-44` 的 `EffectiveJudgePrompt` 把 boundary 与 output contract **强制**叠在用户自定义提示词之后（用户改不动契约本身）。
- `prompt.go:45-...` 的 `JudgeOutputContract`：只输出一个 JSON 对象，`decision ∈ allow|ask|deny`，`comment` 严格三段（实际操作 / 成功后的后果 / 命中规则）、≤120 汉字。
- `intercept/review_context.go:32-46`：`ReviewInput` 只含 `working_directory` / `background` / `scripts` / `tool+args`；`ReviewScript` 带 `sha256`、`complete`、`truncated`、`read_error`（`:12-24`）。
- `review_context.go:56-60`：明确"绝不回落到整轮 transcript（可能含完整调度提示词）"。
- 配套：`applyIncompleteScriptPolicy` 在"脚本没抓全"时把 `allow` 降级为 `ask`（`intercept.go:546-552`）——不知道就转人工，而不是放行。

**对我们的直接价值**：`packages/control-plane/src/command-approval.ts:31-33` 现在直接把 `{tool, command, completeLocalProbe, scope}` 发给审批模型，没有输入边界声明。任务正文/附件里的注入文本可以试图影响判定，而这条链路的输出直接决定"是否执行"。抄这份契约的成本很低。

### 2.3 shell 的静态分析：用 AST，不用正则

- `intercept/shell_static.go:1-40` 用 `mvdan.cc/sh/v3/syntax` 解析命令，只接受"字面量 + 有限循环绑定"的内联展开，显式拒绝未引号通配、参数长度/切片/替换等（`:18-40`）；`:82-178` 处理循环绑定；`:295-438` 识别"这条命令会生成脚本文件"的情形；`:438-...` 判定脚本是否静态可备。
- `intercept/shell_constants.go:1-30` 只认"同一段直线作用域内的单次字面量赋值"，不做跨分支推断。
- 失效方向是安全的：解析不出来就降级（转人工），不会误放行。

**重要事实**：ARTEX 本体几乎不含 `exec.Command`——全仓只有 `selfupdate/bootstrap.go` 与 `server/customtool.go` 两处。真正的 shell 执行体在依赖里：`github.com/Autumn-27/norma v0.4.3`（`/Users/sycpro/ARTEX/go.mod:6`）。所以"ARTEX 怎么执行命令"这个问题的答案是：**它自己不做，把 shell 交给内核，本体只做拦截、审查与审计**。这个分层本身值得抄。

### 2.4 长任务与输出回传（执行内核 norma，v0.4.3）

路径：`/Users/sycpro/go/pkg/mod/github.com/!autumn-27/norma@v0.4.3/tool/`

- `bash.go:31-58`：工具声明 `timeout_ms`（默认 120s，上限 600s）+ `run_in_background`；后台能力可以整体关闭（`BackgroundTasksDisabled`）。
- `bash.go:61-72` 权限：先跑 `catastrophicBash` 硬拒（`rm -rf /`、fork bomb、`mkfs.*`、`dd of=/dev/sd*`，`:20-25`），其余**一律 `AskUser`**——默认不放过，而不是默认放过。
- `bash.go:104-151` `runBashManaged`：显式后台 → `Spawn` + 立刻返回句柄与输出文件路径（`:107-116`）；前台 → `RunForeground`，超时后**只有 `autoBackgroundAllowed` 为真才转后台**（`:141-146`），否则 `Kill` 并返回 `[command timed out after ...]`（`:147-150`）。`sleep` 被硬编码禁止自动后台（`:29`、`:194-209`）。
- `bash.go:155-190`：没有任务管理器时退化为同步执行，保证功能可用。
- `task.go:214-264` `Spawn`（输出直接写 `OutputPath`）、`:266-315` `watch`/`watchSize`（超过 `maxTaskOutputBytes` 即终止）、`:386-408` `RunForeground`、`:490-563` `Output`/`tailFile`（**只回尾部 maxBytes，并明确前缀"已截断"**）。
- `taskoutput.go:13-72` `TaskOutput`：`max_bytes` 默认 30k，`block=true` 才等待（默认 30s），返回 `[task id | status | exit N]` 头 + 尾部输出。

**这三件事**（输出落文件、只回 tail、block 是显式参数）与我们 `packages/exec/src/jobs.ts:166-193` 的形状已经一致；我们缺的是"超时自动转后台"与"完成通知"（`jobs.ts` 目前只有 exit 回调写 meta，没有向上层推事件）。

### 2.5 流量与证据：内容寻址 blob + 分段读

- `traffic/traffic.go:1-5` 明确：嵌入 go-mitmproxy、"Full capture, plaintext (no redaction)"、只抓目标 HTTP。
- `:585-600` 写 blob：`sha256(body)` → `_blobs/sha256/<前2位>/<hash>.bin`，存在即跳过（天然去重）。
- `:731-745` 读 blob：兼容单层与两层 bucket（历史布局迁移），不命中就报错而不是返回空。
- `:2116-2198` 三个工具：`traffic_search` / `traffic_get` / `traffic_blob`；`traffic_blob` 单次最多 8KB，用 `offset` 续读并回总长度（`:2189`、`:2193`）。
- `traffic/archive.go:23-31`：任务归档只带"流量子集 manifest + blob 引用"，注释说明用复制而不是 base64 是为了保留去重与流式写（`:24-27`）。
- `traffic/evidence.go:15-27`：`ReadEvidence` 用回调暴露完整 body，并在释放写锁前关闭 reader，避免"索引查完、blob 被删"的竞态。

**对我们的直接价值**：GongYuAI 的证据=文件，这套 `<ab>/<hash>.bin` + 索引存 hash + 工具按 offset 分段读，是现成可用的形状。

### 2.6 代理

`server/forward_proxy.go:19-45` 的 `dynamicForwardProxy`：绑 `127.0.0.1:0`（随机端口），**每次请求解析当前上游**（`current()`），所以切换代理池不必重建 agent 或 MCP 连接；credential-free。

对我们：如果以后要让子进程走代理，这个形状（本地随机端口 + 动态上游 + 只对子进程注入 env）比改全局代理安全得多，也符合我们"代理只对当次命令用临时环境变量"的既有约定。

---

## 3. 与 GongYuAI 的差距对照表

| 能力 | 现状（file:line） | 差距 | 建议 |
| --- | --- | --- | --- |
| listener 类型 | 只有 `tcp`/`tls`，默认绑 `127.0.0.1`，`port:0` 随机 | 无 http/ws beacon；bind 失败只写 `meta.error`，没有可判定的错误码 | 保持两种；补 `ErrPortInUse` 等价错误码与 listener 状态机（`running/stopped/error` 已有，缺"启动失败原因"语义） |
| TLS | `certPath/keyPath` 读文件即可（`c2.ts:159`、`:164-167`） | 不记录证书指纹 | 把 cert 的 sha256 写进 listener meta，报告可复核 |
| 鉴权 | agent 可上报 `token` 但只记录不校验（`c2.ts:343`） | **任何能连上端口且 IP 在范围内的对端都能登记会话** | 加可选的共享 token 校验（常量时间比较 + 失败直接断开，不回显原因） |
| 会话唯一化 | 每次连接随机 `s-...`（`c2.ts:223`） | 断线重连=新会话，任务历史不归并；同源多连接不踢旧 | raw 用 `sha256(listener|peer)` 稳定 id；agent 用自报 uuid + token |
| session 状态机 | 声明 `active/idle/closed/blocked`（`c2.ts:33`），`idle` 无写入点 | 与 CS 同病：声明态无迁移 | 要么删 `idle`，要么补"心跳超时 → idle"的写入 |
| 心跳 / 看门狗 | 无 watchdog；只有 socket close 事件（`c2.ts:295-298`） | 半开连接（拔网线）永远 `active`，pending 任务挂到 `waitMs` | 抄自适应阈值 watchdog |
| task 生命周期 | 六态声明齐全（`c2.ts:58`） | 无 CAS、无 `sent` 原子迁移；raw 收口**恒 success**（`:551`）；deadline 分支不可达（`:550-566`） | 见增量 1 |
| 任务持久化 | 内存数组 + 全量覆盖 `state.json`（`c2.ts:134-153`），**构造时不加载** | 进程重启即丢 listener/session/task | 改为每任务一目录（与"任务=目录"一致），启动时扫目录恢复只读视图 |
| 文件通道 | 只有 `read`/`write` 字节（`c2.ts:573-600`） | 无法搬二进制证据；无 sha256/分块 | 见增量 2 |
| AI 工具面 | 1 个 `c2` 工具、9 个 action 混在一个 schema（`pi-loop.ts:512-537`） | 无 listener/file/payload 分组；属性平铺且无 enum 约束 | 见增量 3 |
| 审批 | `listen`/`pty open` 传自造 verdict 直接过（`exec-tools.ts:135`、`:199`） | **capability 阶梯被绕过**；只有 `task` 真正判范围（`:240-244`） | 全部走 `assertCapabilityAllows` + 台账 |
| 长任务 | detached 后台作业 + `exit.code` + 增量读（`jobs.ts:70-193`） | 已达标；缺"工具超时自动转后台"与完成通知 | 抄 norma `runBashManaged` 的判定分支 |
| PTY | `python3 pty.spawn` 优先、`script(1)` 兜底（`sessions.ts:35-43`）；pattern/idle wait（`:186-220`） | 已达标；无会话数上限治理 | — |
| 证据 | 每命令写 `evidence/exec/cmd-*.md`，mode 0600（`tools.ts:178-186`） | 无 sha256 索引、无 blob 去重、无分段读 | 抄 traffic 的内容寻址 |
| 范围模型 | capability 阶梯 + `auth.targets` 形式化匹配（`scope.ts:132-179`、`packages/contracts/src/scope.ts:139-178`）；语义是作业坐标，不是授权审查 | 无 RBAC/项目边界——**这是对的**（单用户），别引入 | — |
| C2 侧范围闸 | `exec` 与本地 shell 共用 `authorizeCommand`，且把会话对端并入判定（`c2.ts:408-412`） | 已达标，且比 CS 更干净 | 保留 |

---

## 4. 可直接复用的设计（语义抄，不抄实现）

1. **任务 CAS + 终态不可覆盖**：所有状态写入带"期望旧状态"，`affected==0` 视为失败；迟到的结果直接丢弃并记事件。
2. **派发 = 单事务 `SELECT queued → UPDATE sent`**：读到即 sent，不需要客户端 ack，天然幂等。
3. **自适应看门狗**：`sleep * (1 + jitter%) * 3`，下限 30s；交互式会话用固定 60s。
4. **会话唯一化三件套**：稳定 uuid（hash(listener|peer) 或 implant 自报）、token 绑定身份、新连接踢旧连接且旧连接不得退掉新连接。
5. **结束标记 + 输出清洗**：marker 收口，剥掉命令回显行与提示符行（我们已有 marker，缺清洗）。
6. **单飞**：同一交互会话同时只允许一个 in-flight 任务，避免输出交错。
7. **危险动作类型白名单 → 审批**：不需要 RBAC，只需要"哪些 task_type 必须人工过一遍"。
8. **工具按资源切、每资源一个 action 枚举**：8 个工具覆盖 35 条路由，是可控粒度（我们收成 4 个）。
9. **明文兼容只留在一个入口**（check-in），不要扩散到 result/upload。
10. **blob 内容寻址 + offset 分段读**（traffic）：`<ab>/<sha256>.bin` + 索引 + 8~64KB 分段。
11. **输出落文件 + 只回 tail + block 显式化**（norma）：默认不阻塞、阻塞要显式请求并带超时。
12. **审查输入边界契约 + 输出协议**（ARTEX prompt.go）：边界由程序强制叠加，用户改不动。
13. **AST 级 shell 静态判据**（ARTEX shell_static）：解析失败即降级转人工，不误放行。
14. **事件总线非阻塞 + 丢弃计数**（CS eventbus）：SSE/订阅者慢不能反压业务。
15. **错误文案不假装知道远端状态**：`"会话已离线且任务结果超过执行期限；远端进程是否终止尚未确认"`（`session_watchdog.go:117`）——这类措辞应成为我们的模板。

---

## 5. 不要照搬的坑

1. **声明态无迁移**。CS 的 `sleeping`/`killed`/`running` 全无写入点；我们 `c2.ts:33` 的 `idle` 同病。要么补写入，要么删枚举——留着会让前端筛选项永远为空，也会让后续维护者写出错误的过滤逻辑。
2. **只在提示词里的约束**。`c2_tools.go:67`、`:77` 反复叮嘱"bind_port 不要等于 Web 端口"，但 `CreateListener` 全链路没有这条校验（`manager.go:164-226`、`handler/c2.go:78-134`）。约束写在描述里等于没写。
3. **审批记录消失被当批准**。`c2_hitl_bridge.go:119-121`：查询审批行返回 `sql.ErrNoRows` 时 `return nil`，即"记录不存在 → 视为通过"。这条路径在 DB 被清理/迁移后会静默放行危险任务。
4. **硬编码 60s 读超时 + 单飞**。`listener_tcp.go:302`、`:383` 与 `manager.go:662-675` 组合的结果是：TCP 模式下任何长命令必然失败，且没有配置项可以改。
5. **空闲收口当成功**。CS 的 TCP 用 marker 判定（正确）；我们的 `c2.ts:551` 是 `task.status = hit ? "success" : "success"`——两个分支同值，且 `:559` 的 deadline 分支因为 `:550` 的条件已包含 `Date.now() > deadline` 而永远不可达。这是"假成功"，会让上层把超时命令当成功证据写进报告。
6. **两份 wait 实现**。`c2_tools.go:479-503` 与 `handler/c2.go:673-704` 是同一套轮询逻辑的两份代码，参数默认值/返回形状已经开始不一致（一个回工具结果、一个回 408）。
7. **解密失败回退明文**。`listener_http.go:184-190`。协议兼容性把加密层变成可选，只剩 token 一道防线。
8. **文件全量进内存**。`listener_http.go:346`（256MiB 上限）、`:416`（`os.ReadFile`）。任何超过内存的文件都会把整个 C2 进程拖死。
9. **启发式误报筛选被当清理依据**。`database/c2.go:692-696` 的 `tcp_% / unknown / pid=0` 会把真实 legacy 会话一起命中；它只适合做"人工复核队列"。
10. **多用户 RBAC 五层 + 项目边界**。单用户形态下是纯税，而且它正是"已授权仍被拦"的第一大来源（`mcp_authorization.go:348-353`）。我们有 capability 阶梯 + targets 匹配就够。
11. **Malleable Profile / 自签 TLS / 域名前置 / 四种 listener**。我们没有任何对抗需求，引入只会扩大攻击面与维护面。
12. **明文全量流量记录**。`traffic/traffic.go:3` 自述 "plaintext (no redaction)"。若借鉴它的 blob 结构，必须保留我们现有的 `mode 0600` 并在 README 里写明"证据目录可能含凭据"。
13. **judge 失败默认 ask、ask 默认超时 deny**。ARTEX 这套会在没人看审批页时把 worker 挂住最长 5 分钟（`c2_hitl_bridge.go:32` 的 5min）。我们的审批是文件台账 + fence（`command-guard.ts:39-67`），**不要引入阻塞式等待**，用"过期 + 重新跑"代替。

---

## 6. 下一步增量（3 条，按性价比排序）

### 增量 1：C2 任务收口与看门狗（最小改动，最高收益）

**改动面**：仅 `packages/exec/src/c2.ts`（不改公开 API 形状）。

a) `collectRaw` 判定重写：marker 命中 → `success`；未命中且 socket 已关 → `failed`；未命中且到 deadline → `failed`（`error: "wait_timeout"`），保留部分输出到 `result`；空闲收口只在 marker 命中时算 `success`。
b) 终态不可覆盖：任务进入 `success/failed/cancelled` 后，迟到的 `result` 帧丢弃并写 `warn` 事件（对齐 `manager.go:724-726` 的语义）。
c) 新增 session watchdog：15s 扫 `active`，超过 `max(2*interval, 60s)` 无数据 → `closed`，并把该会话所有 pending 任务置 `failed`（对齐 `session_watchdog.go:127-151`）。
d) `state.json` 启动时加载为只读视图（listener 不自动重启，session/task 历史可见）。

**验收口径**：
- 新增 3 个测试（同 `packages/exec/src/exec.test.ts`）：① fake implant 只回显、不回 marker → `task.status === "failed"` 且 `error` 含 `wait_timeout`；② 先 `cancel` 再让 implant 回 `result` → 状态仍为 `cancelled`；③ 连接后无数据超过阈值（阈值做成可注入参数）→ `session.status === "closed"` 且 pending 任务为 `failed`。
- 既有两个 C2 测试保持绿（`exec.test.ts:170-198`、`:200-241`）。
- `pnpm -F @gongyuai/exec test` 全绿；先修判定再加阈值，禁止调阈值掩盖失败。

### 增量 2：C2 文件通道（sha256 + 分块 + 归属）

**改动面**：`packages/exec/src/c2.ts` 新增文件原语；`packages/worker/src/exec-tools.ts` 暴露 `action=file-put|file-get|task-download`。

a) 落盘 `<taskDataDir>/c2/files/<sha256>.bin` + 同名 `.json` 元数据（`size`、原路径、来源 `sessionId`、时间）。存在即复用（内容寻址去重）。
b) `fileGet` 支持 `offset`/`maxBytes`（默认 64KiB，上限 1MiB），返回 `{data(base64), offset, nextOffset, size, sha256}`。
c) 归属：文件记录写入时的 `sessionId`；读取要求同 session 或同 task，跨会话读 → 拒绝 + `warn` 事件。
d) `task-download`：implant 回 base64 → 服务端解码 → 计算 sha256 → 与 implant 自报 sha256 比对，不一致即 `failed(hash_mismatch)`。

**验收口径**：
- 写入 1MiB 随机字节，分 16 次按 offset 读回，拼接后 sha256 与写入一致。
- 跨 session 读同一 hash → 抛错，且 `events.jsonl` 出现 `warn` 级 `file` 事件。
- implant 自报错误 sha256 → `task.status === "failed"` 且 `task.error === "hash_mismatch"`。
- 断言目录里只有 `<sha256>.bin` 与 `<sha256>.json`，无临时文件残留（`readdir` 全量比较）。

### 增量 3：C2 工具面收敛 + 全量审批

**改动面**：`packages/worker/src/pi-loop.ts`（工具定义）、`packages/worker/src/exec-tools.ts`（统一入口）。`scope.ts` 不加判定逻辑。

a) 拆成 4 个 action 型工具：`c2_listener`（listen/close/list）、`c2_session`（sessions/note/close/read/write）、`c2_task`（task/read-result）、`c2_file`（put/get/download）。每个 schema ≤ 8 属性，`action` 带 enum。
b) 所有 action 统一走 `gateTool → assertCapabilityAllows` + `reviewBeforeDispatch`；**删除** `exec-tools.ts:135` 与 `:199` 的自造 verdict。
c) listener 能力分级：loopback bind → `scan`；非 loopback（`0.0.0.0`/具体网卡 IP）→ `active-lab` 且强制人工确认一次。
d) 审批摘要只放 host 列表与动作名，不放命令正文（沿用 `commandProposal` 的 digest 语义，`command-guard.ts:6-13`）。

**验收口径**：
- `capability=observe` 时 `c2_listener action=listen` 必须抛 `denied:`（当前会直接放行）。
- `capability=scan` 且 `bindHost=0.0.0.0` 时必须产生一个 `waiting` ticket，未确认前不 bind。
- `c2_task` 携带越界 host → 不产生 ticket 且抛"目标越界"（复用 `c2.ts:410` 的 `authorizeCommand` 判定）。
- 台账断言：跑完四个工具的一轮 CRUD，`ledger` 中 ticket 数 === 实际执行次数（不多不少）。
- 回归：`packages/exec` 与 `packages/worker` 既有测试全绿。

---

## 7. 证据索引

### 7.1 CyberStrikeAI（`/Users/sycpro/CyberStrikeAI`）

**模型与协议**
- `internal/c2/types.go:24-29` listener 类型；`:32-50` 类型校验
- `internal/c2/types.go:55-60` session 状态；`:65-72` task 状态；`:79-98` task 类型；`:101-110` 全集；`:114-121` 危险类型
- `internal/c2/types.go:124-146` ListenerConfig（`:132-134` TLS、`:139` 命令黑名单、`:141` 并发上限、`:143` callback_host、`:145` allow_legacy_shell）
- `internal/c2/types.go:149-174` 默认值（sleep 5 / jitter 0-100）
- `internal/c2/types.go:177-221` check-in / task envelope / result report（`:214` OutputB64、`:217` BlobBase64）
- `internal/c2/types.go:238-249` sentinel 错误；`:252-257` 端口校验
- `internal/c2/crypto.go:21-37` 生成 key/token；`:39-91` AES-GCM
- `internal/c2/tcp_beacon_server.go:24-30` CSB1 魔数与 64MB 帧上限；`:65-72` token 校验
- `internal/c2/beacon_host.go:14-34` 回连地址优先级

**listener 与会话**
- `internal/c2/listener.go:14-21` 接口；`:36-58` 工厂注册表
- `internal/c2/manager.go:164-226` CreateListener（`:174-177` 默认 bind、`:193-200` key/token、`:203` id 前缀）
- `internal/c2/manager.go:228-286` StartListener（`:249-251` 脱敏副本、`:265-271` 失败置 error）
- `internal/c2/manager.go:330-344` 重启恢复；`:289-312` Stop；`:315-318` Delete
- `internal/c2/manager.go:354-426` IngestCheckIn（`:358-364` uuid/跨 listener、`:393-401` 保留操作员设置、`:405-415` 首见事件、`:423-424` 心跳不写事件）
- `internal/c2/listener_tcp.go:124-149` 协议识别；`:152-242` 裸 shell 会话（`:156-159` uuid 派生、`:187-191` 踢旧连接、`:218-237` 读超时刷心跳）
- `internal/c2/listener_tcp.go:245-270` dispatcher；`:273-317` 单任务执行（`:291` marker、`:302` 60s 超时）
- `internal/c2/listener_http.go:88-137` Start（`:100-107` 四个超时、`:117-128` TLS）
- `internal/c2/listener_http.go:161-245` check-in（`:170` 1MiB、`:176-190` 明文回退、`:201-204` curl 身份、`:217-221` 身份绑定）
- `internal/c2/listener_http.go:247-281` /tasks；`:283-328` /result（`:292` 64MiB）；`:332-370` /upload（`:346` 256MiB）
- `internal/c2/listener_http.go:374-424` /file（`:386` task_id 过滤、`:390-400` 身份枚举、`:405-415` 逃逸校验）
- `internal/c2/listener_http.go:430-465` 鉴权辅助与 404 伪装
- `internal/c2/listener_websocket.go:75-104` Start；`:135-148` token 前置；`:151-185` 首帧 checkin

**状态机与看门狗**
- `internal/c2/session_watchdog.go:12-27` 设计说明；`:30-55` ticker；`:66-90` tick；`:92-124` 离线任务过期（`:106-108` 读 timeout_seconds、`:117` 措辞）；`:127-151` 阈值
- `internal/c2/task_terminal_test.go:29-44` 迟到结果不覆盖终态；`:46-61` 旧连接不误杀新连接
- 死状态证据：`types.go:59`（killed 声明）、`manager.go:503`（唯一读点）；`types.go:57`（sleeping 声明）、`session_watchdog.go:68`（唯一读点）；`types.go:68`（running 声明）、`manager.go:665`（唯一读点）

**任务生命周期**
- `internal/c2/manager.go:492-627` EnqueueTask（`:503-505`、`:507-529`、`:531-550`、`:564-616`、`:614-615`）
- `internal/c2/manager.go:630-648` CancelTask；`:652-686` PopTasksForBeacon（`:662-675` TCP 单飞）
- `internal/c2/manager.go:692-711` 归属校验；`:713-796` 结果入库（`:724-726` 终态幂等、`:750-758` CAS、`:760-768` blob）
- `internal/c2/manager.go:798-871` blob 落盘与路径校验
- `internal/database/c2.go:829-864` 建任务；`:867-878` 更新结构；`:881-938` CAS 更新（`:933-936`）；`:1275-1333` 原子取任务

**工具面与路由**
- `internal/app/c2_tools.go:25-35` 八个工具注册；`:54-84` listener schema（`:67`/`:77` 端口约束仅在描述）；`:96-152` 脱敏与一次性 token
- `internal/app/c2_tools.go:237-341` session 工具（`:257` suspicious、`:311-320` kill=exit）
- `internal/app/c2_tools.go:347-438` task 工具（`:367` enum、`:391` timeout 恒写、`:391-422` payload 拼装）
- `internal/app/c2_tools.go:444-526` task_manage（`:479-503` wait 轮询）
- `internal/app/c2_tools.go:841-890` file 工具（只回路径）
- `internal/mcp/builtin/constants.go:68-77` 工具名常量；`:80-139` IsBuiltinTool
- `internal/app/app.go:1443-1487` 35 条 HTTP 路由（`:1444-1453` 未启用 503）
- `internal/handler/c2.go:78-134` CreateListener（无端口校验）；`:673-704` WaitTask；`:965-999` EventStream（`:974-980` buffer 128）；`:1189-1209` 结果文件下载

**授权**
- `internal/app/mcp_authorization.go:17-51` 授权器骨架；`:197-238` C2 工具映射；`:270-323` action→权限映射（`:272-277`、`:282-296`）；`:325-355` 项目边界（`:348-353` 报错文案）；`:376-402` 资源→项目解析
- `internal/security/rbac_middleware.go:182-183` C2 → crudPermission；`:210-219` 权限点生成；`:235-238` profile 写需 global；`:264-269` 资源归属
- `internal/app/c2_hitl_bridge.go:20-35` 桥与 5min 超时；`:48-139` RequestApproval（`:70-76` 落库、`:89` 轮询、`:107-112` 超时拒绝、`:119-121` ErrNoRows→nil）
- `internal/c2/manager.go:52-67` HITLBridge 接口与请求结构；`:94-106` 注入点
- `internal/c2/hitl_context.go:10-19` HITL 用户上下文

**异步与事件**
- `internal/c2/eventbus.go:55-80` 订阅；`:92-115` 非阻塞发布 + 丢弃计数；`:131-144` 过滤
- `internal/app/c2_lifecycle.go:15-58` 装配（`:25-28` 注册、`:29-33` HITL、`:53-56` 恢复与看门狗）；`:87-103` 关闭

### 7.2 ARTEX（`/Users/sycpro/ARTEX`）与其执行内核

**拦截**
- `intercept/intercept.go:1-11` 三段语义；`:80-83` compiledRule；`:570-595` 首个命中；`:597-624` 匹配策略与 `\b` 注释；`:626-...` 输入字符串提取
- `intercept/intercept.go:546-552` 脚本不完整降级；`:687-769` HandleAsk（`:693`、`:704-706`、`:728-768`）；`:770-792` Decide 与 ErrAlreadyDecided
- `intercept/prompt.go:9-24` 输入边界契约；`:30-44` 强制叠加；`:45-...` 输出协议
- `intercept/review_context.go:12-30` 脚本快照（sha256/complete/truncated）；`:32-46` ReviewInput；`:56-60` 禁止回落 transcript
- `intercept/shell_static.go:1-40` AST 展开与拒绝条件；`:82-178` 循环绑定；`:295-438` 生成脚本识别
- `intercept/shell_constants.go:1-30` 直线作用域常量推断
- `intercept/judge_retry.go`（judge 失败重试路径）

**流量 / 代理 / 证据**
- `traffic/traffic.go:1-5` 包定位（明文全量）；`:40-...` 索引 schema；`:585-600` 写 blob；`:731-745` 读 blob；`:2116-2198` 三个工具（`:2189`、`:2193` 分段读）
- `traffic/archive.go:23-31` 归档快照；`:24-27` 复制而非 base64 的理由
- `traffic/evidence.go:15-27` 回调式证据读取
- `server/forward_proxy.go:19-45` 动态前向代理

**执行内核 norma v0.4.3**（模块缓存，非 ARTEX 仓库内）
- `/Users/sycpro/go/pkg/mod/github.com/!autumn-27/norma@v0.4.3/tool/bash.go:20-29` 灾难命令硬拒；`:31-58` 工具声明；`:61-72` 权限（危险 denied，其余 AskUser）；`:104-151` 后台/前台与超时转后台；`:155-190` 同步兜底；`:194-209` 自动后台白名单
- `.../tool/task.go:214-264` Spawn；`:266-315` watch 与上限；`:386-408` RunForeground；`:490-563` Output/tailFile
- `.../tool/taskoutput.go:13-72` TaskOutput（max_bytes / block / timeout）
- `/Users/sycpro/ARTEX/go.mod:6` 依赖版本 `github.com/Autumn-27/norma v0.4.3`

### 7.3 GongYuAI（仓库相对路径）

**执行面**
- `packages/exec/src/scope.ts:12-27` 授权快照与判定结构；`:41-46` 硬拒正则；`:72-104` 主机抽取；`:106-127` 能力级映射；`:132-179` `authorizeCommand`；`:182-192` `authorizePeer`
- `packages/contracts/src/scope.ts:139-168` 目标匹配（`*`/CIDR/通配/后缀）；`:171-178` outOfScope 优先
- `packages/exec/src/proc.ts:25` 1MB 输出上限；`:27-38` 进程组 kill；`:40-117` `runCommand`
- `packages/exec/src/jobs.ts:41` 8MB 上限；`:70-120` 后台启动作业（`:79` 写 exit.code）；`:141-164` reconcile；`:166-193` 增量读；`:195-215` kill；`:218-248` wait
- `packages/exec/src/sessions.ts:35-43` PTY 选择；`:60-113` open；`:138-156` write；`:158-183` read；`:186-220` wait
- `packages/exec/src/index.ts:25-48` ExecRuntime；`:50-68` 先授权再执行
- `packages/exec/src/exec.test.ts:170-198` raw C2 测试；`:200-241` agent C2 测试

**C2 面**
- `packages/exec/src/c2.ts:19-31` listener 类型与元数据；`:33` session 状态（`idle` 无写入）；`:57-58` task 类型与状态
- `packages/exec/src/c2.ts:105-153` 内存态与 `state.json`；`:155-196` listen；`:216-299` accept（`:224` 越界判定、`:259`/`:267-282` agent/raw 判定、`:295-298` close）
- `packages/exec/src/c2.ts:301-321` finishSession；`:323-379` agent 协议；`:399-412` requireLive + guard；`:414-521` task；`:523-571` collectRaw（`:550-566` 收口缺陷、`:551` 两分支同值）；`:573-600` read/write；`:620-629` 列表与关闭

**worker 面**
- `packages/worker/src/tools.ts:31-56` 能力级闸；`:84-97` 命令允许性；`:103-127` gateTool；`:137-197` runShell（`:178-186` 证据落盘）；`:207-304` installTool
- `packages/worker/src/command-guard.ts:6-13` 命令提案（digest、不落参数）；`:17-27` fence 校验；`:39-67` reviewBeforeDispatch（manual 24h / auto 90s）；`:69-73` 结果回写
- `packages/worker/src/exec-tools.ts:8-16` 设计约束；`:60-114` shellJob；`:126-172` shellSession（`:135` 自造 verdict）；`:191-262` c2Tool（`:199` 自造 verdict、`:240-244` 仅 task 判范围、`:245` 只支持 exec）
- `packages/worker/src/pi-loop.ts:440-471` shell 工具；`:473-490` shell_job；`:492-510` shell_session；`:512-537` c2；`:1960-2014` 分发 switch

**控制面**
- `packages/control-plane/src/command-approval.ts:6-8` 审批提示词；`:11-13` 执行器边界；`:17-50` 审查与放行条件；`:53-58` 用户回执；`:61-64` 策略回执
- `packages/control-plane/src/assignments.ts:18-21` 任务提示词（只允许 local_check）；`:96-101` 幂等提交；`:109-112` 授权范围（`capability: observe`、`targets: ["local:submitted-materials"]`）；`:135-138` 结果回执；`:159-174` fence 与过期；`:188-262` 主流程；`:265-274` 白名单执行；`:277-289` 写证据 + 目标达成；`:292-323` 会话内确认；`:327-352` 审批不可用后重试
