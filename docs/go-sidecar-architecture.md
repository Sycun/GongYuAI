# 混合执行底座设计：TypeScript 大脑 + Go Sidecar（`gy-netd`）

> **定位**：在不重写主仓 TypeScript 架构（Fact–Intent DAG、Pi Durable、Session Relay、Semi Console）的前提下，将最消耗 CPU、内存与网络并发的执行面下沉为单个静态 Go 守护进程 **`gy-netd`**，优先替换 **MITM 录包代理 + 并发 HTTP 事务引擎**，后续平滑承接 **OAST / C2 / 隧道保活**。
>
> **状态**：✅ **Phase 0 + Phase 1a–1c + Phase 2（OAST HTTP/DNS 回调监听 + 本地 `127.0.0.1` TCP/HTTP-CONNECT 转发守护）已全部落地并通过 TS / Go 双后端验收**（2026-11-28）；C2 模块保留在既有 TypeScript [c2.ts](../packages/exec/src/c2.ts) 中，不迁入 `gy-netd`。
>
> **关联文档**：[architecture.md](./architecture.md) · [long-run-contract.md](./long-run-contract.md) · [red-team-positioning.md](./red-team-positioning.md) · [pentest-capability-extension.md](./pentest-capability-extension.md)

---

## 1. 为什么走折中路线（设计边界）

GongYuAI 现有 ~10.7 万行 TypeScript 后端与 ~1.1 万行 React 控制台，核心价值在 **外置 Fact–Intent DAG、证据封存复核、Leader/Follower 编排与 Pi Durable 适配**。这部分强依赖动态 JSON Schema、MCP/Pi 生态与前后端共享契约，用 TS 迭代效率最高；而真正造成性能与资源瓶颈的是底层网络代理、TLS 签发、并发 HTTP 采集与多进程重复状态。

因此划定三条不可逾越的边界：

1. **大脑与真相源留在 TS**：`HistoryStore`（DAG / Finding / Goal Gate）、Worker 编排、模型调用、权限/工程自保规则判断全部保留在 TypeScript。`gy-netd` 是纯执行与采集传动层，**零策略决策权、零目标审查**。
2. **契约与落盘格式 100% 兼容**：`gy-netd` 写出的 `traffic/index.sqlite`、`traffic/blobs/<sha256>`、`evidence/http/<sha>.{req,res}.txt` 及 `HttpArtifact` / `TrafficRecord` 结构与现行 `@gongyuai/exec` 逐字节兼容，上层 History、Validator、Console 无需改读路径。
3. **双后端可回退**：`@gongyuai/exec` 提供 `GY_EXEC_BACKEND=auto|go|ts`（默认 `auto`：存在可执行 `gy-netd` 时走 Go，未构建或显式设 `ts` 时透明回退到现有 TS 实现），不阻断无 Go 环境的开发与 CI。

---

## 2. 实测性能基线（2026-11-28）

> 测试环境：macOS `darwin/arm64`（Apple Silicon）、Node `v26.13.1`、Go `1.27.4`、本地 loopback 压测（无外网抖动，纯测平台自身开销）。

| 压测项 | 当前 TS 实测 | 关键问题定位 |
| --- | --- | --- |
| **TLS Leaf 证书冷签（20 个新域名）** | **378.5 ms**（p50 **18.86 ms** / p95 **20.28 ms**，52.8 hosts/s） | [ca.ts](../packages/exec/src/traffic/ca.ts) 每新主机 `spawnSync("openssl")` **3 次** + 读写删 5 个临时文件，**同步阻塞 Node 事件循环**；且缓存按 Worker 进程隔离，4 Worker 扫 200 子域 = 2400 次阻塞 `openssl` 调用 |
| **MITM 代理（`finding-window`，200×4KB @ c16）** | **5,092 RPS**（p50 2.21 ms / p95 11.77 ms / max 18.21 ms） | 单进程吞吐尚可，但 200×64KB 后进程 RSS 从 **52.0 MB → 127.7 MB（+75.7 MB）**；[proxy.ts](../packages/exec/src/traffic/proxy.ts) 每主机缓存独立 `tls.Server` 且无上限，同时多 Worker 各自起代理导致内存环无法跨槽位共享 |
| **MITM 代理（`all` 落盘 + SQLite，200×4KB @ c16）** | **2,066 RPS**（p50 7.09 ms / p99 22.38 ms），较内存态跌 **~60%** | 每请求临时文件落盘 + 同步 `insertTraffic` 阻塞响应 `gate` 关流 + `index.sqlite` 未调 `synchronous=NORMAL` |
| **HTTP 引擎（`performHttpRequest`，200×4KB @ c16）** | **3,065 RPS**（p50 3.89 ms / p95 14.91 ms / p99 20.69 ms） | [http.ts](../packages/exec/src/http.ts) 每请求同步 `mkdirSync` + `existsSync` + `writeFileSync` 两次；且缺少原生批量并发探测（`http_batch`） |
| **SQLite `HistoryStore`（300 次 `appendFact`）** | 默认 `FULL`：**45.7 ms**（6,568 writes/s，p95 0.25 ms）<br>调优 `NORMAL`：**20.5 ms**（**14,668 writes/s**，p95 **0.08 ms**） | [packages/history/src/index.ts](../packages/history/src/index.ts) 等三处库已开 WAL 但未配 `synchronous = NORMAL`、`temp_store = MEMORY`、`cache_size`；仅调 PRAGMA 即得 **2.23x** 吞吐、p95 降 **68%**（Linux/VM ext4 下收益更大） |
| **单 Worker 冷启动与底噪内存** | `dist`：**127.9 ms / 53.0 MB RSS**<br>`tsx`：**225.2 ms / 77.3 MB RSS** | 10 并发槽位仅进程底噪 + 各自 MITM 环即超 **1 GB**；将 MITM/Ring/HTTP 池收口至单个共享 `gy-netd` 可消除 N 倍重复缓存 |

### 量化目标（Phase 0 + Phase 1 验收门槛）

| 指标 | 当前基线 | Phase 0+1 目标 |
| --- | --- | --- |
| TLS Leaf 冷签（20 域名） | p50 18.86 ms（阻塞事件循环） | **p50 < 1.0 ms**（内存 `crypto/x509`，0 子进程，0 阻塞） |
| MITM 代理（`finding-window`，c16） | +75.7 MB RSS / Worker | 单 `gy-netd` 跨 Worker 共享，RSS **< 40 MB**，吞吐 ≥ 基线 **1.5x** |
| MITM 代理（`all` 落盘，c16） | 2,066 RPS / p99 22.38 ms | 吞吐 **≥ 4,500 RPS**，p99 **< 10 ms** |
| HTTP 引擎（单发 + 新增 `batch` 64 并发） | 3,065 RPS（无 batch） | 单发零事件循环阻塞；`batch` 200×4KB @ c32 **≥ 6,000 RPS** |
| SQLite `HistoryStore` 300 写入 | 45.7 ms（6,568/s） | **≤ 22 ms**（≥ 13,000/s，同步应用于 `history` / `traffic` / `platform`） |

### Phase 0 同机复测（2026-11-28）

从仓库根目录先运行 `pnpm -r run build`，再运行 `node scripts/perf-baseline.mjs --backend ts`。脚本也可通过 `pnpm perf:baseline` 调用。下表为同一脚本在 `5f24e2c` 的 TS 存储代码与加入三处 PRAGMA 后的结果。环境为 macOS arm64、Node v26.13.1、SQLite 3.54.1、OpenSSL 4.1.0。`HistoryStore` 丢弃预热后取五次独立数据库中总耗时居中的一轮，其他用例各跑一轮。

吞吐用例全部针对 `127.0.0.1` 上的 HTTP fixture。路径唯一，同体积响应复用相同内容。代理数字测量 HTTP 转发与录包，不含 HTTPS CONNECT 握手。RSS 是同一 Node 进程（含 fixture）依次执行各用例的采样峰值，不能当作独立 Worker 或未来 `gy-netd` 的 RSS。单轮网络波动不宜归因于 SQLite 调优。

| 用例 | TS 调优前 | TS 调优后 | 调优后 p50 / p95 / p99（ms） | 调优后 RSS 峰值（MiB） |
| --- | ---: | ---: | ---: | ---: |
| TLS 叶证书冷签 20 域名 | 422.53 ms | 405.60 ms | 20.26 / 20.90 / 21.62 | — |
| 代理 `finding-window`，200×4 KiB @ c16 | 4,502 RPS | 4,941 RPS | 2.26 / 11.42 / 15.83 | 77.21 |
| 代理 `finding-window`，200×64 KiB @ c16 | 4,448 RPS | 4,423 RPS | 3.27 / 5.06 / 10.93 | 112.59 |
| 代理 `all`，200×4 KiB @ c16 | 2,286 RPS | 2,674 RPS | 5.44 / 8.98 / 16.25 | 116.01 |
| 代理 `all`，100×64 KiB @ c16 | 1,908 RPS | 2,277 RPS | 6.05 / 12.69 / 16.69 | 116.56 |
| 单发 HTTP，200×4 KiB @ c16 | 3,475 RPS | 3,646 RPS | 2.71 / 14.05 / 19.31 | 125.35 |
| 单发 HTTP，100×64 KiB @ c16 | 3,610 RPS | 3,893 RPS | 3.40 / 6.94 / 14.77 | 129.76 |
| `HistoryStore` 300 次 `appendFact` | 44.73 ms / 6,707 次/s | **21.52 ms / 13,940 次/s** | 0.062 / 0.096 / 0.121 | — |

`HistoryStore` 吞吐为原来的 **2.08×**，达到 Phase 0 的 ≤22 ms 和 ≥2× 门槛。三个写连接仍使用 WAL。`synchronous=NORMAL` 避免每次提交都同步 WAL，断电或操作系统崩溃时可能丢失最近提交，但不会改变数据库结构。History 的只读连接未修改。

`pnpm -r run build` 和 `pnpm -r run typecheck` 均通过。TS 的 `@gongyuai/exec` 回归 82 项通过，全仓 722 项通过，均无失败或跳过。实际查询三个写连接确认 PRAGMA 生效，流量库新建时仍为 `auto_vacuum=INCREMENTAL`。

### Phase 1a–1c 同机 TS vs Go 实测对比（2026-11-28）

运行 `pnpm run build`（自动编译 `bin/gy-netd`，11.62 MiB 静态二进制，`CGO_ENABLED=0`）后，同机依次执行 `node scripts/perf-baseline.mjs --backend ts` 与 `node scripts/perf-baseline.mjs --backend go`：

| 用例 | TS（Phase 0 调优后） | Go Sidecar (`gy-netd`) | 提升倍数 | 验收门槛 |
| --- | ---: | ---: | ---: | :---: |
| TLS 叶证书冷签 20 域名 | 385.84 ms（p50 **19.14 ms** / 51.8/s） | **10.01 ms**（p50 **0.31 ms** / **1,999/s**） | **38.6×**（p50 **61.4×**，0 阻塞） | ✅（< 1 ms） |
| 代理 `finding-window`，200×4 KiB @ c16 | 4,993 RPS（p99 15.51 ms） | **10,456 RPS**（p99 **7.61 ms**） | **2.09×** | ✅（≥ 1.5×） |
| 代理 `finding-window`，200×64 KiB @ c16 | 4,659 RPS（p99 10.32 ms） | **10,735 RPS**（p99 **3.95 ms**） | **2.30×** | ✅ |
| 代理 `all` 落盘+SQLite，200×4 KiB @ c16 | 2,713 RPS（p99 17.20 ms） | **7,212 RPS**（p99 **7.11 ms**） | **2.66×**（较原基线 2,066 RPS 提 **3.49×**） | ✅（≥ 4,500 / p99 < 10 ms） |
| 代理 `all` 落盘+SQLite，100×64 KiB @ c16 | 2,148 RPS（p99 15.45 ms） | **5,350 RPS**（p99 **5.91 ms**） | **2.49×** | ✅ |
| 单发 HTTP，200×4 KiB @ c16 | 3,828 RPS（p99 18.39 ms） | **9,512 RPS**（p99 **3.39 ms**） | **2.48×**（p99 降 **82%**） | ✅ |
| 单发 HTTP，100×64 KiB @ c16 | 3,604 RPS（p99 14.24 ms） | **4,997 RPS**（p99 **5.69 ms**） | **1.39×**（p99 降 **60%**） | ✅ |
| 批量 `performHttpBatch`，200×4 KiB @ c32 | 5,905 RPS（TS 并发池） | **11,174 RPS**（Go Goroutine 池） | **1.89×** | ✅（≥ 6,000 RPS） |
| 批量 `performHttpBatch`，100×64 KiB @ c32 | 4,341 RPS（TS 并发池） | **5,265 RPS**（Go Goroutine 池） | **1.21×** | ✅ |
| `HistoryStore` 300 次 `appendFact` | 20.79 ms / 14,432 次/s | 20.81 ms / 14,420 次/s | 持平（较调优前 **2.2×**） | ✅（≤ 22 ms） |

- Go Sidecar 内存读数（`/v1/health`）：`heapAllocBytes = 11.15 MiB`（`sysBytes = 44.92 MiB`），单实例跨 Worker 共享证书缓存与 Finding-Window 热环。
- 双后端回归验证：`cd services/netd && go test -race ./...` 全绿；`GY_EXEC_BACKEND=ts` 与 `GY_EXEC_BACKEND=go` 下 `@gongyuai/exec`（含新增 `netd.test.ts`）及全仓 `GY_EXEC_BACKEND=go pnpm -r run test` 100% 通过。

`--backend go` 返回 `status: unavailable` 并以状态码 2 退出。当前没有原生 batch、Go 性能数据或双后端回归结果，§2 中冷签、共享热环与 Go RSS、落盘吞吐和批量 HTTP 的 Phase 1 门槛均未验收。只读核查部署脚本可确认本地 Worker 已优先使用 `dist/reviewed-main.js`，Kali 的 `pnpm gy serve` 则仍经 `tsx` 启动 CLI，控制面库从 `dist` 载入。此次未改动任何部署入口或生产环境。

---

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ TypeScript 主体（控制面 + 1 Leader + N Followers + Validator）             │
│                                                                         │
│  Control Plane (:8877) ──管理生命周期──▶  gy-netd (单个 Go 静态二进制)     │
│  Worker slot 0..N ────UDS HTTP/JSON────▶  <dataDir>/runtime/gy-netd.sock│
│  Validate Runner  ────UDS HTTP/JSON────▶                                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ 共享执行面（Goroutine 并发 · 零重复缓存）
┌───────────────────────────────▼─────────────────────────────────────────┐
│ services/netd (`gy-netd`)                                               │
│                                                                         │
│  [Phase 1]                                                              │
│   ├─ TLS CA / Leaf Manager   (crypto/ecdsa + x509 内存签发 + LRU 缓存)   │
│   ├─ Multi-Task MITM Proxy   (按 task 独立 127.0.0.1:0 端口 + 上游代理)   │
│   ├─ Shared Finding-Window   (跨 Worker 共享有界 Ring + 噪声过滤 + 晋升)  │
│   ├─ Traffic Blob & Index    (异步批量写 blobs/<sha> + index.sqlite)     │
│   └─ HTTP Tx / Batch Engine  (复用 http.Transport + 内容寻址落盘)        │
│                                                                         │
│  [Phase 2 预留]                                                          │
│   ├─ OAST Listener           (HTTP + UDP/TCP DNS 带外回连守护)           │
│   ├─ C2 Listener Hub         (TCP/HTTP/WS 长连接保活，Worker 崩溃不断链)  │
│   └─ Tunnel Supervisor       (SSH/Chisel/SOCKS5 健康探测与自动重连)       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 关键架构收益（超越纯速度提升）
1. **彻底解决多 Worker 流量孤岛**：目前 `traffic/ring.ts` 在每个 Worker 进程内维护独立内存环，Follower 1 抓到的热流量 Leader 和控制台看不到；收敛到 `gy-netd` 后，同一任务下所有 Worker 共享一套热环和 Finding-Window，Leader/Console 可实时检索与晋升。
2. **彻底消灭 `openssl` 阻塞与文件竞态**：Go 原生 `crypto/ecdsa` + `crypto/x509` 在内存直接签发 P-256 证书，保留 `ca.crt`/`ca.key` 落盘兼容外部工具（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`CURL_CA_BUNDLE`），叶证书全内存 LRU 缓存（默认上限 2,048 个主机，防 OOM）。
3. **跨槽位保活地基**：Phase 1 打通 UDS RPC 与进程托管后，Phase 2 把 OAST/C2/Tunnel 放进同一个 `gy-netd`，天然满足 P11/P14「Worker 崩溃或 Follower 会话重置不掉线」的需求。

---

## 4. 目录布局与进程生命周期

### 4.1 仓库目录规划
```text
services/netd/
  go.mod                      # module github.com/Sycun/GongYuAI/services/netd (仅标准库 + 纯 Go SQLite 驱动)
  cmd/gy-netd/main.go         # 入口：--socket <path> --parent-pid <pid>
  internal/
    rpc/                      # UDS HTTP/1.1 JSON-RPC 路由、健康检查、错误码
    tlsmitm/                  # CA 加载/生成、内存叶证书签发 + LRU 缓存
    proxy/                    # HTTP/HTTPS MITM 代理、CONNECT、upstream、流式 spool/capture
    ring/                     # 每任务有界 Ring、噪声过滤、Finding-Window 晋升
    store/                    # traffic/blobs 内容寻址 + traffic/index.sqlite（与 TS schema 同构）
    httpeng/                  # 单发/批量 HTTP 事务、重定向授权闸、UTF-8 边界截断、evidence/http 落盘
bin/                          # .gitignore 忽略；构建产出 bin/gy-netd
```

> **依赖克制原则**：`services/netd` 禁止引入重型框架；SQLite 优先使用纯 Go 驱动 `modernc.org/sqlite`（无需 CGO，支持 macOS arm64 交叉编译 Linux amd64/arm64 零痛点），或仅由 TS 写 `index.sqlite` / Go 写 blob + 返回元数据（Phase 1a 可先由 Go 写 blob + 同步直写 `index.sqlite`，两方案均保证 `CGO_ENABLED=0` 静态单二进制）。

### 4.2 进程托管与防孤儿机制
- **托管模式（默认）**：Control Plane 启动时拉起单个 `gy-netd --socket <dataDir>/runtime/gy-netd.sock --parent-pid <cpPid>`，并将 `GY_NETD_SOCKET` 注入所有 Worker 环境变量。
- **独立/测试模式**：未设 `GY_NETD_SOCKET` 时（如单独跑 `packages/exec` 测试或 `gy` CLI 离线命令），`@gongyuai/exec` 的 `NetdClient` 按需在进程级惰性拉起一个带 `--parent-pid <pid>` 的临时 `gy-netd`（退出时自动关闭）。
- **防孤儿进程**：`gy-netd` 启动后台协程每 2s 检查 `parent-pid` 存活（及可选 stdin pipe EOF），父进程异常崩溃时自动清理监听端口与 socket 文件后退出。
- **权限边界**：UDS 目录 `0700`、socket 文件 `0600`；MITM 代理仅绑定 `127.0.0.1:0`，禁止监听 `0.0.0.0`。

---

## 5. UDS RPC 契约（Phase 1）

传输层统一为 **Unix Domain Socket 上的 HTTP/1.1 + JSON**（`Content-Type: application/json`），Node 端直接用内置 `node:http` 的 `socketPath` 调用（零新增 npm 依赖），排障可直接用 `curl --unix-socket ...`。

### 5.1 系统与健康
| 方法与路径 | 说明 |
| --- | --- |
| `GET /v1/health` | 返回 `{ ok: true, version, pid, uptimeMs, proxies: number, certCacheSize: number, rssBytes: number }` |
| `POST /v1/shutdown` | 优雅关闭全部代理并刷盘退出 |

### 5.2 MITM 代理与共享热环（对应 `packages/exec/src/traffic/`）
| 方法与路径 | 请求体关键字段 | 响应体关键字段 |
| --- | --- | --- |
| `POST /v1/proxy/start` | `{ taskId, taskDir, workerId?, intentId?, upstream?, insecureUpstream?, mode: "finding-window" \| "all", retention?, windowConfig? }` | `{ proxyId, port, caPath, proxyUrl }` |
| `POST /v1/proxy/:proxyId/context` | `{ workerId?, intentId? }`（Worker 切换活跃 Intent 时轻量更新，替代 JS 闭包 `getIntentId()`） | `{ ok: true }` |
| `POST /v1/proxy/:proxyId/upstream` | `{ upstream: string \| null }` | `{ ok: true }` |
| `POST /v1/proxy/:proxyId/stop` | `{}` | `{ ok: true }` |
| `POST /v1/traffic/window/open` | `{ taskDir, findingId, intentId?, host?, postWindowMs?, postMaxItems? }` | `{ promotedCount, promotedIds: string[] }` |
| `POST /v1/traffic/window/close` | `{ taskDir, findingId }` | `{ ok: true }` |
| `POST /v1/traffic/promote` | `{ taskDir, findingId, intentId?, host?, ids? }` | `{ promotedCount, promotedIds: string[] }` |
| `POST /v1/traffic/query-live` | 完整对齐 `TrafficQuery`（`taskDir, taskId, host, method, status, keyword, intentId, offset, limit`） | `{ traffic: TrafficRecord[], total, nextOffset, hotIds: string[] }` |
| `POST /v1/traffic/get-live` | `{ taskDir, id }` | `{ record: TrafficRecord \| null, hot: boolean }` |
| `POST /v1/traffic/body-live` | `{ taskDir, id, side: "req" \| "res", offset?, maxBytes? }` | 完整对齐 `LiveBodySlice`（支持 gzip/deflate/br 透明解压切片） |

> **多 Worker Intent 归属细节**：同一任务若有多个 Follower 并发，推荐 **每个 Worker 调用 `POST /v1/proxy/start` 拿到专属 `127.0.0.1:<port>`**（在 Go 里多开一个 `net.Listener` 成本几乎为零），但底层共享同一个 `taskDir` 的 **CA/Leaf 缓存、上游连接池、Finding-Window 与 Ring**。这样无需改任何外部工具（`curl`/`sqlmap`/`nuclei`）的代理配置，就能 100% 精确标记每条流量的 `workerId` 与当前 `intentId`！

### 5.3 HTTP 事务与批量探测引擎（对应 `packages/exec/src/http.ts`）

#### `POST /v1/http/request`
- **授权闸如何不丢失**：TS 侧 `performHttpRequest` 接受回调 `authorizeHost(host)`。为了既不把策略塞进 Go、又不为每跳额外回调：
  - **模式 A（推荐默认，零额外往返）**：TS 侧如果能从 `AuthScope` 传出序列化规则快照（`scope: { targets, outOfScope, allowLoopback }`），Go 在首跳和每次 3xx 重定向直接本地执行同构 `matchTarget` 校验；
  - **模式 B（任意自定义 JS 回调兼容）**：若调用方传入自定义 `authorizeHost` 函数（如单测里的动态闭包），TS 侧先调 `authorizeHost(initialHost)`，再向 Go 传 `follow: false` 逐跳执行，由 TS 在 3xx 时再校验下一跳。两条路径都保证 **100% 语义等价，绝不向被拒 host 发出半个字节**。
- **请求体**：
  ```json
  {
    "method": "GET",
    "url": "https://target/path",
    "headers": { "User-Agent": "..." },
    "body": "",
    "follow": true,
    "maxRedirects": 5,
    "maxResponseBytes": 2097152,
    "timeoutMs": 30000,
    "evidenceDir": "/path/to/evidence",
    "proxyUrl": "http://127.0.0.1:54321",
    "insecureTls": true,
    "scope": { "targets": ["..."], "outOfScope": ["..."] }
  }
  ```
- **响应体**：直接返回与 [http.ts](../packages/exec/src/http.ts) 完全一致的 `{ artifact: HttpArtifact, headers: Record<string, string>, bodyHead: string }`，包含：
  - 请求先落盘 `<evidenceDir>/http/<sha>.req.txt`（`0600`、内容寻址、并发原子写）
  - 响应落盘 `<evidenceDir>/http/<sha>.res.txt`（UTF-8 多字节边界安全回退，`responseHead <= 16 KiB`）
  - 跨源跳转剥离 `Authorization` / `Cookie` / `Proxy-Authorization`
  - 301/302 POST 与 303 非 GET/HEAD 按 RFC 9110 改写为 GET 并丢弃 body

#### `POST /v1/http/batch`（新增高并发能力）
- 面向批量端点探测、同族资产验证、凭据复测场景：
  - 请求体：`{ concurrency: 16, items: HttpRequestInput[] }`（上限如 `concurrency <= 64`，`items.length <= 200`）
  - Go 内部复用同一个 `http.Transport`（`MaxIdleConnsPerHost` 可配）和 Goroutine 池并行执行，按输入下标保序返回结果数组。

---

## 6. 分阶段实施路线与验收

### Phase 0：TS 底座零风险快赢 + 基线脚本固化（半天）
- **改动范围**：
  1. SQLite PRAGMA 统一调优：`PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;` 落地到 [packages/history/src/index.ts](../packages/history/src/index.ts)、[packages/exec/src/traffic/store.ts](../packages/exec/src/traffic/store.ts) 与 [packages/control-plane/src/platform.ts](../packages/control-plane/src/platform.ts)。
  2. 将性能基线脚本固化至 `scripts/perf-baseline.mjs`（支持 `--backend ts|go` 输出 JSON 对比表），作为后续每步的硬验收标尺。
  3. 核查 Kali systemd 与本地部署路径，确保 Worker 与 Control Plane 稳定走 `dist/` 而非 `tsx`。
- **验收**：全量 `pnpm -r run test` 通过；`HistoryStore` 300 写入提升 ≥ 2x。

### Phase 1a：Go Sidecar 骨架 + MITM 录包代理（2–3 天）
- **改动范围**：
  1. 初始化 `services/netd` Go 模块，实现 UDS RPC、`tlsmitm`（内存 CA/Leaf + LRU 缓存）、`proxy`（HTTP/HTTPS CONNECT + upstream + `finding-window`/`all`）、`ring`（共享热环 + 噪声过滤 + 晋升）与 `store`（`blobs/` + `index.sqlite`）。
  2. 在 `packages/exec/src/netd-client.ts` 实现 `NetdClient` 与 `GY_EXEC_BACKEND=auto|go|ts` 分发；改造 `startTrafficProxy` 及 `ring.ts` live 查询接口支持 Go 后端透明接入。
  3. Control Plane 启动时托管 `gy-netd` 并注入 `GY_NETD_SOCKET`。
- **验收**：
  - 现有 [traffic.test.ts](../packages/exec/src/traffic.test.ts)、[traffic-window.test.ts](../packages/exec/src/traffic-window.test.ts)、[traffic-encoding.test.ts](../packages/exec/src/traffic-encoding.test.ts) 与 `validate-runner` 相关测试在 `GY_EXEC_BACKEND=ts` 与 `GY_EXEC_BACKEND=go` 下 **双跑 100% 通过**。
  - `scripts/perf-baseline.mjs --backend go` 达到 §2 量化目标（20 域名 TLS 冷签 < 1 ms/host，MITM 落盘 ≥ 4,500 RPS）。

### Phase 1b：HTTP 事务与批量探测引擎下沉（1–2 天）
- **改动范围**：
  1. `services/netd/internal/httpeng` 实现 `/v1/http/request` 与 `/v1/http/batch`。
  2. `packages/exec/src/http.ts` 接入 `NetdClient`（保留 TS fallback），并暴露 `performHttpBatch`。
- **验收**：
  - 现有 [http.test.ts](../packages/exec/src/http.test.ts) 与 [http-sessions.test.ts](../packages/exec/src/http-sessions.test.ts) 在双后端下 **100% 通过**（含重定向拦截、跨源脱敏、UTF-8 截断、内容寻址去重、超时）。
  - `http_batch` 并发压测达标。

### Phase 1c：构建与部署收口（半天）
- `package.json` 增加 `build:netd`（检测 `go` 存在则编译 `bin/gy-netd`，否则打提示并跳过）。
- [docker/worker/Dockerfile](../docker/worker/Dockerfile) 与 [docker/tsecbench/Dockerfile](../docker/tsecbench/Dockerfile) 增加 Go multi-stage builder，只拷贝静态二进制 `/opt/gongyuai/bin/gy-netd` 到运行镜像（不把 Go 工具链带进最终镜像）。
- [scripts/kali/deploy.sh](../scripts/kali/deploy.sh) 的 `prepare` 阶段补充 `pnpm build:netd`（若 Kali 未装 Go 则降级 TS 或拉取预编译产物）。

### Phase 2：常驻监听面迁入 `gy-netd`（OAST HTTP/DNS + 本地隧道转发 ✅）
- [oast.ts](../packages/exec/src/oast.ts)（HTTP 回调监听）与 [oast-dns.ts](../packages/exec/src/oast-dns.ts)（UDP DNS 回调监听）已接入 `gy-netd`（`/v1/oast/http/*`、`/v1/oast/dns/*` 含 NDJSON 实时事件流与内存 hit 留存），同时保留完整 TS 回退。
- `gy-netd` 新增本地 `127.0.0.1` TCP / HTTP-CONNECT 转发守护（`/v1/tunnel/start|list|stop`），`@gongyuai/exec` 导出 `startNetdTunnel` / `stopNetdTunnel` / `listNetdTunnels`。
- [c2.ts](../packages/exec/src/c2.ts) 保留在既有 TypeScript 实现中，不迁入 Go Sidecar。

---

## 7. 风险与防呆纪律

1. **避免双写 SQLite 锁冲突**：`traffic/index.sqlite` 在 `GY_EXEC_BACKEND=go` 模式下由 `gy-netd` 单一写入、TS 侧仅只读查询（或统一经 UDS 读），彻底消除多进程写锁竞争。
2. **证书与证据权限不放松**：`ca.key`、`evidence/http/*.txt`、UDS socket 必须保持 `0600`；`ca.crt` 保持 `0644` 以便子进程读取。
3. **无 Go 环境永不破构建**：任何 CI、开发者本机或未装 Go 的容器，`GY_EXEC_BACKEND=auto` 自动回退到 TS 实现，不引入硬门槛。
4. **先差分、再升默认**：每个 Phase 必须用同一套单测 + `perf-baseline` 同台机器跑出 TS vs Go 对比数据，确认功能零回归且性能达标后再将 `auto` 默认切至 Go。
