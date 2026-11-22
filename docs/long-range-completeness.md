# 长程渗透完备性（P12）：定调后的方向与角色设计

2026-11-22 起草；同日用户定调重构。  
配套：[MASTER-DESIGN.md](./MASTER-DESIGN.md) · [attack-chain-graph.md](./attack-chain-graph.md) · [pentest-ops-design.md](./pentest-ops-design.md)

## 用户定调（2026-11-22）

| 方向 | 定调 |
| --- | --- |
| D1 事实保鲜 / D2 防御反馈 / D3 Provider 韧性 | **必须补充** |
| D4 Engagement 程序层 | **先调研**，不直接设计 |
| D5 战役规划 | **给一个规划者（Planner 角色）** |
| D6 事故应急 | **给一个辅助者（Assistant 角色）** |
| D7 断网部署 | **不考虑**（无断网场景）；内网语义另行澄清（见下） |
| D8 法律级证据 | **通过** |
| 新增 | **漏洞攻击链图**：可与四图融合，点击漏洞节点重点展现攻击链 |

**内网语义澄清（用户原话）**：内网不是独立部署场景，而是「**从外网通过组合漏洞拿到 C2 或 getshell**」之后进入的——这部分如何建模见 [attack-chain-graph.md](./attack-chain-graph.md)：内网穿越 = 一条授权步骤的因果链，不是新阶段/新 scope。

## D1 目标漂移与事实保鲜（必补）

网络是活目标：补丁/重启/凭据轮换/WAF 更新会让旧 Fact 失效。

- Fact `freshness` 派生态（不修改原 Fact）：按资产类/事实类 TTL 建议值；过期标「待复核」。
- **基线差分**：周期 revalidation Intent（轻量重扫关键面）→ 与旧 Fact 比对 → 差异写新 Fact（否定/更新）。
- 凭据/会话健康 monitor（E2/P11）：到期前主动验证；失效写否定 Fact + 触发 re-acquire Playbook。
- 纪律：保鲜是 Reason 图调度；TTL 只建议不删 Fact（append-only）。

## D2 防御响应反馈与 OPSEC 自适应（必补）

蓝队会在长跑中反应，系统必须感知并自适应。

- **封锁检测**：403 突增/连接重置/验证码墙模式 → 否定 Fact + 模型自判退避（联动 rateGuidance）。
- **蜜罐/诱饵启发式**：异常一致指纹/无业务逻辑开放面 → confidence 降级 + 交叉验证 Intent。
- **金丝雀规避**：canary token 特征识别，触碰即告警客户；RoE 默认禁触发（硬 denylist）。
- **噪音预算**：生产/测试资产分级节奏，生产默认保守。
- 纪律：信号写 Fact/Hint（建议层）；不建自动绕过 EDR 能力。

## D3 Provider 韧性与模型经济（必补）

数日长跑必撞限流/配额/故障。

- **Key 池 + 多 provider failover**：settings 级凭据池；429/5xx 指数退避 + 自动切换（pi-ai provider 承载）。
- **成本预测**：燃烧率 → 剩余预算/时间预测（飞轮记分卡孪生）。
- **模型分层经济**（P7）：指挥贵/执行快/复核便宜。
- 纪律：key 池属保活/资源层（控制面），不进战术；凭据明文不进 History/记忆。

## D4 Engagement 程序层（调研完成 ✅ · 四问已定案）

调研产出：[absorb-engagement-team.md](./absorb-engagement-team.md)（PTES/RoE 指南/AttackForge/PentAGI 对照；授权共享与经验共享分离；三处 schema 留位提案）。**四问定案**：客户可主动触发复测；reviewer 可跨任务署名复核整程序；member-admin 按最佳实践做（单用户隐藏）；跨团队=AI 侧接手直接继承授权上下文。设计三刀：E-schema → E-api → E-ui。

## D5 战役规划 → 规划者（Planner 角色）

**给一个规划者**，不是新真相源：

- **定位**：Reason 层的战役规划算子增强——强模型子会话（pi subagent）或 slot 0 Reason 扩展；读目标层级 + 覆盖矩阵 + 攻击链图，产出**里程碑计划与下一波 Intent 提案**。
- **契约**：Goal 增可选 `parentGoalId` / `milestone`；进度自底向上 rollup；控制台 Goals 树 + 报告按里程碑组织。
- **触发**：里程碑边界 / 周期战役复盘（Reason lease 内）；不是固定 kill-chain 剧本。
- **权限**：产出走正常 `intent_propose` 硬闸（sourceFactIds 强制）——规划者推荐≠授权；计划本身写 draft Fact/Hint，不直接派单。
- **底座**：pi subagent（强模型、replay-safe）或 hook onYield；与 P7 模型路由共用配置。

## D6 事故应急 → 辅助者（Assistant 角色）

**给一个辅助者**，安全/事故专职：

- **定位**：独立轻量会话（pi subagent，便宜模型），监视信号：错误率突增、破坏性闸命中、consult 紧急、金丝雀触碰、scope 漂移、疑似生产影响。
- **权限（关键设计）**：
  - **有 pause 权**：break-glass 自动暂停（非终态、可逆、全审计）——暂停是保活层安全动作，不是战术决策；与 Watchdog 零策略不冲突（辅助者是独立角色，不是看门狗）。
  - **无** stop/resume/扩 scope/派 Intent 权；恢复必须人。
  - 事故记录 draft + 客户通知 draft：人审后才发送。
  - lab-first 建议：破坏性/利用类打法先靶场验证再生产复现。
- **数据最小化**：遇个人信息/真实用户数据 → 不拖取不存储，记接触 Fact。
- **底座**：hook afterTools 信号检查 + 独立 subagent；pause 走控制面 API（P11 生命周期）。
- 纪律：辅助者不自动修复客户系统；事故判定信号写 Fact，pause 动作留痕可复盘。

## D7 断网部署 —— 删除

用户定调：无断网场景，不考虑。本地模型栈仅作为 D3 provider 韧性的一个兜底 provider 保留（非独立部署 profile）。  
内网相关建模移交 [attack-chain-graph.md](./attack-chain-graph.md)。

## D8 证据法律级与报告合规（通过）

- 事件哈希链（防篡改审计）+ 可选可信时间戳（TSA）锚定。
- write-once 导出交付包 + 校验清单。
- 报告模板：PTES/OSSTMM/NIST SP 800-115 映射；等保/ISO27001 审计格式；执行摘要 vs 技术报告分层。
- CVSS 3.1/4.0 + CWE 映射；修复复测工作流（retested：复测 Intent→证据→状态迁移）。
- 纪律：vector+人审不变；合规映射是渲染不改图语义。

## 分期（定调后）

| 优先 | 内容 |
| --- | --- |
| 必补 | D1 / D2 / D3（正确性与运行底线） |
| 角色 | D5 规划者 / D6 辅助者（随 P7/P11 落地） |
| 通过 | D8（随 P6 E1 报告层） |
| 调研 | D4（产出 absorb 文档后再设计） |
| 删除 | D7 |

依赖：D1/D2 依赖 P6+P11；D3 依赖 P7；D5/D6 依赖 pi subagent 深化；D8 依赖 E1。差分验收口径不变。

## 明确不做

- 自动绕过 EDR/修复客户系统/拖取真实数据；TTL 强制删 Fact。
- 固定 kill-chain 战役剧本；规划者/辅助者绕过建议层与硬闸。
- 辅助者 stop/resume/扩 scope 权；断网独立 profile。