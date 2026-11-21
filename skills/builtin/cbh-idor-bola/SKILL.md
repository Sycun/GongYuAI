---
name: cbh-idor-bola
description: >-
  复测 Web/API 对象级越权（IDOR、BOLA、跨租户资源访问）。在已有受控账号和对象引用时，用归属基线、交叉身份请求和权限对照判断服务端是否校验对象归属。
license: CC-BY-4.0
metadata:
  upstream: elementalsouls/Claude-BugHunter
  upstream-commit: edcae6f8964c13e3b2f2e0153fb941a1f0da46ea
  upstream-skill: hunt-idor
---

# IDOR / BOLA 复测

1. 从项目授权范围内的现有 API 清单或抓包选择一个对象操作。用两个互不授权的测试账号 A、B 及其测试对象，记清各自租户、角色和共享状态。
2. 先验证 A 访问 A 的对象、B 访问 B 的对象，再固定接口、方法和 A 的对象引用，只切换到 B 的身份。记录预期权限与实测结果。必要时加无会话对照，以区分对象授权和认证问题。
3. 对比真实的归属标记、返回字段或持久化状态。响应码相同、通用响应或客户端隐藏按钮只能当线索。若入口在 GraphQL、批量接口、文件下载或软删除资源中，再读 [对照矩阵](references/validation.md)。
4. 写入、删除和状态变化须在授权允许的专用测试对象上做，先确认恢复方法。使用最少的样本证明边界，记录可重复的正常请求、交叉请求和受影响对象。
5. 需要 HTTP 证据时调用当前 Agent 可用的 `mac_network` 抓包工具。先 `capture_start`，确认 `capture_ready=true` 后通过项目代理发送测试请求，核对 Proxyman 中的对照流量。证据保留请求差异和对象标记，遮盖会话值与个人信息。结束时用本次 `capture_id` 调用 `capture_stop`。抓包未就绪时如实标明取证状态。

沿用项目现有的通用 Web 测试、事实验证和报告流程，报告中给出对象、身份、操作和影响。

改编自 Sachin Sharma 的 [Claude-BugHunter · hunt-idor](https://github.com/elementalsouls/Claude-BugHunter/blob/edcae6f8964c13e3b2f2e0153fb941a1f0da46ea/skills/hunt-idor/SKILL.md)，许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本地改编提取了双身份验证流程，并接入项目抓包。
