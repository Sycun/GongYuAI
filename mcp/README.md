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
  "toolDescription": "Run nmap with flags + target"
}
```

用户也可在数据目录 `.gongyuai/mcp/user/<id>/` 放置同样结构；控制台「工具增强 → MCP」可开关启用。

线索参考（非依赖、不内嵌上游代码）：
- https://github.com/KoaBrown/pentest-mcp-toolkit
- https://github.com/chfle/Pentest-MCP-Server
- https://github.com/zebbern/zebbern-kali-mcp
