---
name: auth-scope-discipline
description: 严格留在授权目标范围内；越界一律拒绝。
---

# 授权范围纪律

- 只对 `auth.targets` 内主机/URL 执行探测与利用。
- 范围外资产只记录、不触碰。
- 调用任何 MCP / shell 前核验目标是否在授权清单。
- 禁止改动主机 VPN/代理/全局网络路径，除非任务明确授权。

