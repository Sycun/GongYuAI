---
name: auth-scope-discipline
description: 严格留在授权目标范围内；越界一律拒绝。
---

# 授权范围纪律

- 只对 `auth.targets` 内主机/URL/IPv4 CIDR/`*.domain` 执行探测与利用（匹配规则见 contracts `targetAllows`）。
- 发现的子域/IP 用 `asset_record` 写入资产清单；自动准入或标 `oos`，**不要**改 `auth.targets`。
- 范围外资产可记账为 `oos`，不触碰、不扇出利用 Intent。
- 调用任何 MCP / shell 前核验目标是否在授权清单。
- 禁止改动主机 VPN/代理/全局网络路径，除非任务明确授权。

