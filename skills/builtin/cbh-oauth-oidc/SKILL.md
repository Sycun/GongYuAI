---
name: cbh-oauth-oidc
description: >-
  复测 OAuth 2.0/OIDC 登录、授权回调、账号绑定和令牌接收方。围绕 redirect_uri、state、PKCE、nonce、issuer 和 audience，区分配置线索与实际会话或授权边界失效。
license: CC-BY-4.0
metadata:
  upstream: elementalsouls/Claude-BugHunter
  upstream-commit: edcae6f8964c13e3b2f2e0153fb941a1f0da46ea
  upstream-skill: hunt-oauth
---

# OAuth / OIDC 复测

1. 在授权的测试客户端和账号内跑一遍正常登录。记录 IdP、客户端、授权入口、回调、令牌交换方及最终绑定的测试身份。每次使用新事务，避免一次性 code 或旧会话污染对照。
2. 每次只变一个边界。回调地址测试比较注册值、实际 Location 和最终接收端。会话绑定测试比较原始会话与另一受控会话的回调结果。令牌测试区分客户端、签发者和接收资源。按场景读 [对照和案例](references/validation.md)。
3. 用产品可观察的结果判定影响，例如授权码到达未注册但由项目控制的接收端，或受控会话完成错误的账号绑定。仅有重定向、前端参数可改或 JWT 字段可读时，记录为线索。保持测试账号、回调和 IdP 在授权范围内。
4. 需要 HTTP 证据时调用当前 Agent 可用的 `mac_network` 抓包工具。用 `capture_start` 为授权主机准备抓包，确认 `capture_ready=true` 后走项目代理，按请求顺序核对 Proxyman。导出时遮盖 Cookie、授权码、令牌和 verifier，保留参数差异及最终身份标记。结束用本次 `capture_id` 调用 `capture_stop`。

沿用项目的通用 Web 测试和报告流程，标明失效的是授权端、客户端还是资源端的校验。

改编自 Sachin Sharma 的 [Claude-BugHunter · hunt-oauth](https://github.com/elementalsouls/Claude-BugHunter/blob/edcae6f8964c13e3b2f2e0153fb941a1f0da46ea/skills/hunt-oauth/SKILL.md)，许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本地改编以对照实验替代通用枚举，并接入项目抓包。
