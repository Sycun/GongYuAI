---
name: aimy-skill
description: Prohao42/aimy-skill (v3.7.5) 渗透测试工具链：支持结构化 JSON 输出的 CLI（aimy）与 MCP（aimy-mcp），覆盖侦察、注入、鉴权、业务逻辑、WAF 绕过与漏洞验证。
---

# aimy-skill 渗透测试工具链（GongYuAI 原生适配）

上游仓库：`https://github.com/Prohao42/aimy-skill`（v3.7.5，MIT）。提供 89 个 CLI 命令与 `aimy-mcp`（104 个工具），全部支持 `--json` 机读输出，适合在 GongYuAI 的授权范围与证据链内按需调用。

## 1. 调用入口选择

1. **优先 MCP（若已启用 `aimy` MCP）**：直接调用 `aimy` MCP 暴露的对应工具。
2. **CLI 回退（经 GongYuAI `shell` 工具）**：
   - 先检查可用性：`which aimy || python3 -m main list`
   - **禁止猜参数**：调用前先跑 `aimy --json manifest` 或 `aimy <command> --help` 确认真实参数。
   - **强制结构化输出**：所有命令加 `--json --mode veteran`（stdout 为含 `_meta` 的 JSON，进度日志走 stderr）。
   - **代理与流量留证**：在 GongYuAI Worker 中 `shell` 已自动注入任务本地 MITM `HTTP_PROXY/HTTPS_PROXY`，所有 HTTP 探测包会自动进入流量库；需要跳过 TLS 校验时显式确认 `--ssl-verify` 参数。

## 2. 常用命令速查（按阶段）

| 阶段 | 命令 | 用途 |
| --- | --- | --- |
| 发现/侦察 | `portscan`, `dirfuzz`, `crawl`, `param-mine`, `fuzz` | 端口/目录/爬虫/隐藏参数挖掘 |
| 注入类 | `sqlcheck`, `sqli-blind`, `sqli-oob`, `xsscheck`, `xss-validate`, `cmdi`, `ssti`, `ssrf`, `nosqli`, `lfi` | 常见服务端/客户端注入探测与验证 |
| 认证/鉴权 | `auth-bypass`, `jwt`, `jwt-exploit`, `cors` | 鉴权绕过、JWT 攻击、CORS 误配 |
| 业务逻辑 | `bizlogic`, `race`, `workflow`, `chain` | 竞态条件、工作流跳过、漏洞串联 |
| 深度/协议 | `graphql`, `deser`, `proto-pollution`, `waf`, `waf-heavy`, `payload-mutate` | GraphQL、反序列化、原型链污染、WAF 探测与绕过 |
| 武器化 | `sqli-weaponize`, `ssrf-pwn`, `ssrf-lateral`, `deser-weaponize` | 仅在 `auth.capability >= active-lab` 且范围明确允许时使用 |
| 自动编排 | `deepscan`, `autohunt`, `auto` | 组合流水线；仅在目标范围与能力档位明确允许时使用 |

常用全局选项：`--json`、`--mode veteran`、`--timeout <sec>`、`--delay <sec>`、`--session-file <path>`、`--auth-type` / `--auth-url` / `--auth-user` / `--auth-pass`、`--quiet`。

## 3. 与 GongYuAI 纪律对齐

- **范围与能力闸**：只对当前任务 `targets` 内资产运行；`observe` 档位不跑主动利用/武器化命令。
- **证据与定级**：`aimy` 输出的 `candidate` / `suspected` 只是线索，必须结合 GongYuAI `traffic_search` / `http_request(compareWith=...)` 留存可复现证据，再执行 `finding_record` / `finding_verify`。
- **未安装时的降级**：若当前执行环境未安装 `aimy`（`command not found`），记录一次工具缺失提示并立即切换使用 GongYuAI 内置 `http_request`、MCP（`nmap/httpx/nuclei/ffuf/sqlmap`）或 `shell` 原生工具，不要反复重试安装。
