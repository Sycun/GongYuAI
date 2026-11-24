---
name: independent-validation
description: >-
  Finder ≠ Validator：发现者不得自证。对已验证 finding 做独立复核时，用四态 verdict
  （confirmed / refuted / inconclusive / out-of-scope），先找对照再下结论；confirmed/refuted
  必须有证据，inconclusive 不得写成 refuted。用于高/严重 finding 交付前复核、客户质疑、
  或 findingsGate.requireIndependent 被拒之后。
metadata:
  tags: [渗透测试, 验证, 复核, dogfood]
---

## 何时用

- 一条 `verified` finding 要进交付，且严重度为 high/critical。
- `assert_goal` 返回「缺独立确认」。
- 客户/同事对结论提出质疑，需要可复核的反驳或确认记录。
- 你自己想换一个 worker/操作员视角重新看证据。

## 铁律

```
1. 复核者 ≠ 验证者。finding.verifiedBy 是谁，谁就不能再提交 finding_validate；
   History 会直接拒绝 self-validation。
2. 先找对照，再看 payload：
   - baseline：不带 payload/不带越权身份的正常请求；
   - proof：带 payload/带另一身份的目标请求；
   - 两者差异才是结论，单张 200/500 截图不算。
3. confirmed / refuted 必须附 ≥1 份证据（原始证据或新的重放/对照记录）。
   - refuted 只在「对照成立且结论不成立」时使用；
   - 目标不可达、WAF 拦截、证据不足 → inconclusive，不许写成 refuted。
4. out-of-scope 是合法结论：复现需要超出原授权时，停手并记录，不自行扩围。
5. 复核不改写原 finding、不改证据字节、不派 Intent；它只追加一条 validation。
```

## 工具路径

- Worker 会话：`finding_validate(findingId, verdict, method, evidencePaths, note)`
  - 同 worker 自证会被拒；换一个 worker 会话或操作员身份。
- 操作员/CLI：`gy finding-validate <taskId> --finding ID --verdict ... --method ... --evidence ...`
- 只读回看：`gy validations <taskId> --finding ID`、`gy audit <taskId>`。

## 四态判定表

| verdict | 什么时候 | 交付影响 |
| --- | --- | --- |
| confirmed | 独立重放/对照成立，证据链可复查 | 可进交付；高/严重可过 requireIndependent |
| refuted | 对照成立但结论不成立（误报） | 人工决定 finding_retract；复核者不直接改状态 |
| inconclusive | 目标不可达、证据不足、环境变化 | 保留原状态，报告标待复核 |
| out-of-scope | 复现会超出授权 | 停手，写清缺口；不得扩 scope |

## 反模式

- 用同一条命令、同一个 worker 再跑一遍就称「独立」。
- 只有 proof 没有 baseline，或只有截图没有请求/响应。
- 把 WAF 403 写成「漏洞已修复」。
- 复核时顺手把 finding 状态改成 retracted/verified。
