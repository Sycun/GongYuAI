---
name: cbh-business-logic
description: >-
  复测业务状态机、审批/兑换/订单规则、价格数量边界、一次性动作及幂等性。在已有正常流程时，验证服务器是否允许跳步、重放、使用旧状态或重复入账。
license: CC-BY-4.0
metadata:
  upstream: elementalsouls/Claude-BugHunter
  upstream-commit: edcae6f8964c13e3b2f2e0153fb941a1f0da46ea
  upstream-skill: hunt-business-logic
---

# 业务逻辑复测

1. 先跑一条授权的正常流程，写清服务端必须守住的规则，例如一次兑换只增加一次额度、确认时使用当前价格版本。定位哪一步最终写入状态。
2. 从可重置的测试账号、测试订单或沙箱数据开始。每次只改一项，优先做缺失步骤、重复提交、陈旧版本、数量边界或跨对象关联的顺序对照。按场景读 [状态对照和案例](references/validation.md)。
3. 比对操作前后的权威记录，例如订单状态、额度余额、审批历史或积分流水。重复响应、报价页变化或请求成功提示只能当线索。并发复测须在授权明确允许并发与请求预算时，从最小并发开始。
4. 避免引入真实付款、发货、通知或不可逆操作。在允许的测试数据上做最小验证，完成后恢复数据或按项目规则清理，记录是否恢复。
5. 需要 HTTP 证据时调用当前 Agent 可用的 `mac_network` 抓包工具。先 `capture_start` 并确认 `capture_ready=true`，走项目代理并在 Proxyman 核对基线、变体和状态读取请求。遮盖凭据和个人信息，最后用本次 `capture_id` 调用 `capture_stop`。

沿用项目现有的漏洞验证和报告流程，写清违反的业务规则和实测状态差异。

改编自 Sachin Sharma 的 [Claude-BugHunter · hunt-business-logic](https://github.com/elementalsouls/Claude-BugHunter/blob/edcae6f8964c13e3b2f2e0153fb941a1f0da46ea/skills/hunt-business-logic/SKILL.md)，许可为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本地改编收敛测试条件和并发预算，并接入项目抓包。
