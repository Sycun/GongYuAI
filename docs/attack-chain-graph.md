# 攻击链图（Attack Chain Graph）：漏洞因果链与内网穿越建模

2026-11-22 用户定调起草。状态：**提案，未动工**（P10 扩展，G2+）。  
用户原话：「要有一个图，关于漏洞的攻击链路，或者可以和之前的四个图融合，我点击漏洞节点的时候重点展现出来」；「内网是从外网通过组合漏洞拿到 C2 或者 getshell 的事情，这部分我还没想好怎么增加」。  
配套：[graph-views.md](./graph-views.md) · [pentest-ops-design.md](./pentest-ops-design.md) · [pentest-enhancements.md](./pentest-enhancements.md) · [long-range-completeness.md](./long-range-completeness.md)

## 结论（先读这四句）

1. **攻击链不是新真相源，是 Fact–Intent DAG 血缘的投影**：链 = 溯源图上的有向路径。每个 hop 本来就是一条「Intent 挂前驱 Fact → 执行 → 产出新 Fact/凭据/会话」的授权步骤——链图只是把这条因果路径**显影**出来。
2. **内网穿越的答案：不加新阶段/新 scope，加两个溯源字段 + 一个投影**。外网→组合漏洞→getshell/C2→内网，每一跳都是既有机制（Intent 硬闸/会话/隧道台账/资产自动准入）；缺的只是把「这个会话/隧道是从哪个 finding/Intent 来的」记下来（provenance），链就能自动连起来。
3. **融合而非第五张独立图**：攻击链是**攻击面图的链模式**+ 跨视图聚焦——点击任何视图里的漏洞（finding）节点，上下闭包高亮整条链，其余淡出。独立成图会重复表面/访问实体，融合保持「一图一真相」。
4. **缺溯源不编造**：provenance 断点显示「溯源缺失」灰节点，不臆造连接（Resurface 纪律）；链叙述从血缘渲染，LLM 只填散文。

## 一、链的节点与边（全部可派生）

| 节点类型 | 来源 | 例 |
| --- | --- | --- |
| **入口 entry** | 外网资产 + 端点 Fact | `https://shop.example.com/login` |
| **利用 exploit** | finding / technique Intent | SQLi（CWE-89, verified） |
| **访问 access** | credential / session（含 getshell/C2 beacon） | 面板凭据 / SSH shell / C2 channel |
| **穿越 pivot** | tunnel session + change 台账（E5） | chisel 反向隧道 → 10.0.0.0/24 |
| **内网资产** | asset_record（自动准入） | `10.0.0.5` |
| **终态 goal** | Goal / flag / engagement 目标 | 核心区数据访问证明 |

边（因果，派生自既有字段）：

```text
entry ──Intent.sourceFactIds──▶ exploit
exploit ──finding.factIds / credential.sourceFindingId──▶ access
access ──session.sourceIntentId / change.credentialId──▶ pivot
pivot ──asset_record Fact.intentId──▶ 内网资产
内网资产 ──Intent.sourceFactIds──▶ 下一跳 exploit …（递归）
```

**需要补的 provenance 字段（仅两个半）**：
- `session.sourceIntentId` / `session.sourceCredentialId`（P11 S1 会话管理器加字段）；
- `change.intentId`（E5 台账已有）；`credential.sourceFindingId`（E2 已有）。
- C2 建模：`session.kind` 增 `c2`（beacon/channel 会话）；C2 框架集成（sliver/mythic 类）是**工具层可选**，链只建模「访问」不绑框架。

## 二、内网穿越 = 授权步骤的因果链（回答「怎么加」）

```text
外网 /login SQLi ─▶ 面板凭据 ─▶ SSH getshell ─▶ chisel 隧道 ─▶ 10.0.0.5
      │                │             │              │             │
   finding#1      credential#1   session#ssh    change#net1    asset(live)
      └────────────── 每一跳都是 Intent 挂前驱 Fact，过同一套硬闸 ──────────────┘
```

- **不新建内网 scope**：内网资产经既有 CIDR 自动准入（授权契约里本就含内网段）；若授权只给外网，穿隧道发现的内网资产记 oos——**链可以展示，利用仍被硬闸拒**（链图≠授权）。
- **getshell/C2 = 会话对象**（P11）：持久、暂停保活、跨 slot 复用；链上 access 节点点击可跳会话详情（输出日志/证据）。
- **组合漏洞 = 链的分叉与汇合**：多前驱 Intent（凭据+开放端口共同触发利用）天然表达「组合」；链图显示多入边汇合节点。
- **审计价值**：一键回答「我们怎么从外网 URL 走到这台内网主机」——每 hop 带证据 SHA-256 与复核状态；客户报告 §Attack Chain 从链渲染。

## 三、点击漏洞聚焦（交互定案）

- **触发**：任何视图（攻击面/DAG/报告/记忆）点击 finding 节点 → Graph workspace 切攻击面图**链模式**并聚焦。
- **上闭包**：沿因果边回溯到 entry/origin——「这个漏洞是怎么被打出来的」（前置凭据/入口/组合条件）。
- **下闭包**：沿 provenance 前推——「这个漏洞打开了什么」（凭据→会话→隧道→内网资产→后续 finding/goal）。
- **呈现**：链路径高亮（severity 着色 hop），其余淡出；侧栏链叙述面板：逐 hop 列表（类型/资产/证据链接/复核状态/耗时 token），断点标「溯源缺失」。
- **多链**：一个 finding 可能属多条链（共享节点）；侧栏链切换器；「全链总览」子模式显示所有链的合并 DAG。
- 键盘可达：finding 节点 Enter 触发聚焦；Esc 退出回表面模式。

## 四、与四图的融合关系

| 视图 | 链的角色 |
| --- | --- |
| 攻击面图 | **链模式宿主**：表面模式 ⇄ 链模式切换；finding 点击默认进链模式 |
| DAG 视图 | finding 的 Fact 邻域 = 链的局部；「查看完整攻击链」跳链模式 |
| 资产图 | 内网资产节点徽章「经链到达」；点击跳链上 pivot hop |
| 执行图 | 链 hop 关联 stepId——「这一跳花了多少 token/谁打的」 |
| 记忆图 | 链蒸馏为 Playbook（整链打法传承，P8）；链模式 hop 可跳源 Playbook |

跨图同 ID 总线不变（address/factId/intentId/findingId/sessionId/changeId）。

## 五、分期与验收

| 刀 | 内容 | 依赖 |
| --- | --- | --- |
| **C1** | provenance 字段（session.sourceIntentId/sourceCredentialId、session.kind=c2）+ 链派生函数（上下闭包） | P11 S1 / E2 |
| **C2** | 攻击面图链模式 + finding 点击聚焦 + 链叙述面板 + 断点不编造 | C1 + P10 G2 |
| **C3** | 报告 §Attack Chain 渲染 + 整链 Playbook 蒸馏 + 跨图跳转 | C2 + P6 E1 + P8 M1 |

验收：单测（闭包正确性：多前驱汇合/环不可能（DAG）/断点标缺失不编造）；smoke mock 链「外网 SQLi→凭据→SSH→隧道→内网」点击 finding 高亮 5 hop；oos 内网资产链可见但利用被拒（硬闸回归）。

## 六、明确不做

1. 链当授权依据（链可见≠可利用；scope 硬闸照常）。
2. 为链建第二套存储（纯投影，可丢弃重建）。
3. 臆造断点连接（缺 provenance 显示缺失）。
4. 绑定特定 C2 框架（链建模访问，框架是工具层可选）。
5. 独立第五张图重复表面/访问实体（融合为链模式）。
6. 链上编辑真相（写走既有 API）。