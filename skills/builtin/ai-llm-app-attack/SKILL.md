---
name: ai-llm-app-attack
description: >-
  AI/LLM应用攻击:提示注入,Agent工具滥用RCE,RAG投毒,MCP供应链,torch.load pickle RCE。Use when testing LLM apps, agents, RAG, MCP plugins, or AI model file risks.
metadata:
  tags: [渗透测试, penetration-testing, 红队]
---

## AI / LLM 应用攻击

```
=== AI/LLM应用(大模型应用爆发期真实攻击面) ===
提示注入: 直接(忽略上文输出system prompt) | 间接(更危险):指令藏RAG文档/网页/邮件/工具返回值/图片EXIF → 劫持Agent
🚨Agent工具滥用(最高危,直达RCE): code interpreter→注入执行 | fetch工具→SSRF内网/云元数据 | 文件工具→读/etc/passwd写webshell
  | SQL工具→导全表 | shell工具→命令注入 → 验证:实际触发工具副作用(OOB回连/读到文件)才写Fact
系统提示泄露/RAG投毒/过度授权跨租户越权/MCP插件供应链/资源成本攻击(烧token) | 输出处理:LLM输出进eval/SQL/前端→二次注入/存储XSS
模型文件: torch.load默认pickle→RCE | 发现端点:抓流量找/chat /agent /tool,问Agent"你有哪些工具"
```

## AI 网关与编排平台配置审计清单

- **常见组件识别**
  - AI API 网关或代理包括 One API、New API、Veloera、Sub2API、LiteLLM。
  - AI 应用编排及配套平台包括 Dify、FastGPT、Langflow、RAGFlow、Open WebUI、LobeChat、Ollama。
- **配置与访问控制**
  - 核查实例是否完成初始化，以及管理和供应商配置端点是否要求身份认证与相应权限。
  - 核查是否保留默认管理员口令或默认主密钥（master key），包括 LiteLLM 的默认配置。
  - 核查依赖内部或 CLI 专用请求头的鉴权逻辑是否完整校验请求来源、身份和权限。
  - 核查 URL 抓取和 Webhook 的出口策略是否隔离内网地址与云元数据端点。
  - 核查前端构建产物（JavaScript、source map）、调试路由和环境配置文件是否暴露上游模型 API Key。
- **凭据核验分级**
  - `L1`（线索）记录发现位置和待核验状态。
  - `L2`（单次调用连通性验证）由凭据所有者或其明确授权的人员确认，记录结果。
  - `L3`（权限范围与影响评估）依据授权范围和已有证据记录可访问资源及潜在影响。
  - 各级仅保留脱敏的最小证据指针，审计记录中不保存明文凭据。
