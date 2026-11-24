# GongYuAI MCP 目录

每个子目录是一份**独立** MCP（一工具一目录），禁止塞进单体 kali-mcp。

```
mcp/
  builtin/<id>/mcp.json   # 仓库预设（Kali 渗透常用工具）
  user/<id>/mcp.json      # 你自备的 MCP；平台启动时自动发现
```

`mcp.json` 最小字段：

```json
{
  "id": "nmap",
  "name": "nmap",
  "description": "TCP/服务发现",
  "category": "network",
  "transport": "builtin",
  "binary": "nmap",
  "defaultEnabled": true,
  "toolName": "run",
  "toolDescription": "Run nmap with flags + target",
  "capability": "scan",
  "targetFlag": "",
  "defaultFlags": "-sV -T4 --top-ports 100 -oX -",
  "parser": "nmap",
  "timeoutMs": 600000,
  "whenToUse": "Use for TCP/UDP port and service discovery."
}
```

字段约定（P15 起）：

| 字段 | 作用 |
| --- | --- |
| `capability` | `observe/scan/active-lab/full`；决定 enable/invoke 的能力闸，不再只按 id 硬编码 |
| `targetFlag` | 目标前的 flag（`-u`/`-d`/`-H`/`-host`）；空 = 位置参数。子命令（`dir`/`smb`/`enum`）留在 `defaultFlags` 最前 |
| `parser` | `nmap/httpx/nuclei/ffuf`；MCP 原始 stdout 交给 parser lane，不把 JSON 包装串当输出 |
| `timeoutMs` | 单次执行上限；默认 600000 |
| `whenToUse` | 合并进工具描述，告诉模型何时选它 |
| `binary` | 健康检查用；Kali 未安装时目录标「未安装」，enable 直接拒绝 |

机读输出是强制的：nmap `-oX -`、httpx `-json`、nuclei `-jsonl`、ffuf `-of json -o /dev/stdout`。

用户也可在数据目录 `.gongyuai/mcp/user/<id>/` 放置同样结构；控制台「工具增强 → MCP」可开关启用。

线索参考（非依赖、不内嵌上游代码）：
- https://github.com/KoaBrown/pentest-mcp-toolkit
- https://github.com/chfle/Pentest-MCP-Server
- https://github.com/zebbern/zebbern-kali-mcp
