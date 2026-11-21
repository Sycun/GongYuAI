---
name: recon
description: 授权范围内的端口/服务/子域与指纹侦察。
---

# 侦察

1. 先用 MCP `nmap` / `naabu` 做端口面，再 `httpx` / `whatweb` 指纹。
2. 有域名时用 `subfinder` + `dnsrecon`/`dig`，结果落入 evidence。
3. 发现服务后优先 `nuclei` 低噪模板，再决定是否加深。
4. 输出：开放端口、版本、候选 CVE、证据路径列表。

