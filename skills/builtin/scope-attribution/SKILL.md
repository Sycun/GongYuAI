---
name: scope-attribution
description: >-
  归属 ≠ 授权。whois/ASN/ICP/CDN 只能证明「这资产可能属于谁」，不能扩大 auth.targets；
  内网 pivot 只走 auth.pivotPolicy 的 declared 网段；重定向、DNS、C2 对端都要过 scope。
  用于目标归属争议、CDN/共享 IP、内网横向、或想「顺手看一眼」相邻资产时。
metadata:
  tags: [渗透测试, 授权, 范围, 归属]
---

## 三条分开

1. **授权**：`auth.targets` / `outOfScope` / `capability` / `pivotPolicy`。只有操作员能改。
2. **归属**：whois/ASN/ICP/CDN 结果只是证据，不是授权。写 Fact 时注明来源和查询时间。
3. **接触**：重定向后的 host、DNS 解析出的 IP、C2 回连来源、SSH 隧道对端，都要重新过 scope。

## 常见错误

- 「这个 IP 是客户的」→ 直接扫。错：先把归属写成证据，再由操作员确认范围。
- CDN 共享 IP：只测域名，不把 CDN 边缘 IP 当客户资产扫。
- 内网发现：`pivotPolicy=off` 时一律 oos；只有 RoE 显式声明的 CIDR 才准入。
- 隧道/代理：只绑 127.0.0.1，不改主机路由/VPN/代理；越界立即停并记 blocked。

## 输出

- 归属证据：whois/ASN/ICP 原文 + 查询时间，写 Fact，标 `attribution`。
- 范围结论：`admitted / oos / needs-operator`，不要用「应该可以」。
- 需要扩围：停手，写清目标、理由、风险，交给操作员改 auth；不要自动扩。
