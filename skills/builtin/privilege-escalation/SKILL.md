---
name: privilege-escalation
description: 已获低权会话后的本机提权检查清单（授权环境）。
---

# 权限提升

- 清点 sudo/SUID/cron/capabilities/容器逃逸线索。
- 用 shell 收集只读信息；敏感操作写 evidence。
- AD 环境可启用 `enum4linux`/`smbmap`/`netexec` MCP。

