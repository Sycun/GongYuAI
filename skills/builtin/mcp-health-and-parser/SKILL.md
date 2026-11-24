---
name: mcp-health-and-parser
description: >-
  选 MCP 前先看二进制是否安装、能力级别是否够；nmap/httpx/nuclei/ffuf 必须用机读输出
  （-oX - / -json / -jsonl / -of json），否则 parser lane 不记账。用于「工具调不动」、
  资产图很薄、或 MCP 返回 not found / 未安装时。
metadata:
  tags: [渗透测试, MCP, 工具, 解析]
---

## 选工具

1. 先看 prompt 的 MCP 目录行：`（未安装）` 的不要 enable，换等价工具或先 `install_tool`（需 ≥scan）。
2. 看 capability：scan 级任务不能 enable active-lab 的 MCP（sqlmap/hydra/netexec 等）。
3. 一次只 enable 需要的；enable 会写 Fact 和审计事件。

## 机读输出（强制）

| 工具 | 必须加的 flag | 解析后落什么 |
| --- | --- | --- |
| nmap | `-oX -` | 主机/端口/服务资产 |
| httpx | `-json` | endpoint/状态码/技术栈 |
| nuclei | `-jsonl` | tentative finding + endpoint |
| ffuf | `-of json -o <file>` | 暴露路径 |

- MCP 的默认 flags 已带机读参数；用 shell 直接跑时自己加。
- 输出不是机读格式时，工具结果会带 `[parser] mandatory: ...`；按提示重跑，不要用 grep 手搓。
- 解析只搬运，不升级结论；finding 仍是 tentative，要 `finding_verify`。

## 常见故障

- `MCP 二进制不存在`：Kali 没装；不要反复 enable。
- `MCP 未启用`：先 `enable_mcp`。
- `scope` 拒绝：target 不在 auth.targets；不要改 target 绕过。
- 同一命令被 `repeat-guard` 拦：改参数/换手法，或让操作员 `gy command-reset`。
