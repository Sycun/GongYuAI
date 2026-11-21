---
name: web-app
description: 授权 Web 目标的内容发现、注入与配置面测试。
---

# Web 应用

1. `httpx`/`whatweb` 确认栈；`ffuf`/`gobuster`/`feroxbuster` 做内容发现。
2. 参数面用 `arjun`；XSS 候选用 `dalfox`；SQL 注入仅在有手工迹象后用 `sqlmap`。
3. CMS 目标可开 `wpscan`/`nikto`/`wapiti`（各自 MCP 开关）。
4. 每个发现写 evidence，再 `assert_goal`。

