# 吸收对照：Engagement 程序层与多人协作（D4 调研）

调研日：2026-11-22。状态：**调研完成，设计待定**（不改代码）。  
外部来源：
- [PTES（Penetration Testing Execution Standard）概览](https://blog.securelayer7.net/penetration-testing-execution-standard/) · [9 个渗透框架对照](https://novee.security/blog/penetration-testing-frameworks/)
- [RoE 与 scope 指南（Safeguard, 2026）](https://safeguard.sh/resources/blog/how-to-scope-a-penetration-test-and-define-rules-of-engagement) · [2026 Scope/RoE 指南（Stingrai）](https://www.stingrai.io/blog/how-to-scope-a-penetration-test-2026)
- [AttackForge Project Teams and Access](https://support.attackforge.com/app/getting-started/project-teams-and-access)（客户/工程/测试三类利益方；三级访问）
- [PentAGI（vxcontrol/pentagi）README](https://github.com/vxcontrol/pentagi)（多用户角色与令牌继承）
- 本仓对照：[memory-layer.md](./memory-layer.md) · [pentest-ops-design.md](./pentest-ops-design.md) · [evidence-review.md](./evidence-review.md) · [long-range-completeness.md](./long-range-completeness.md) D4

## 结论（先读这四句）

1. **真实团队实践的核心不是「角色戏」，是「最小权限访问级别 + 审计 + 可独立复核的交接包」**。AttackForge 的 View/Upload/Edit 三级访问（高含低）与「**project role 不授权**」是本仓最该吸收的结构——与本仓「推荐≠授权」同构：角色只是标签，权限来自访问级别。
2. **授权共享语义**：client → engagement（授权上下文容器）→ tasks。跨任务凭据复用只在**同 engagement 且目标资产在目标任务 scope 内**时允许，且留审计——这是**授权语义**，与 P8 全局记忆（经验语义）严格分离；两者不可互相替代。
3. **RoE 十节清单与本仓契约一眼对得上**：测试窗口/blackout=timeWindow、环境类别（生产/测试）=rateGuidance 与噪音预算、数据处理规则=数据最小化、通信与升级=consult+通知、紧急停止=紧急停止+联系人、报告格式与复测=D8；唯一值得新增的是 scope 的**第三类「ask-before-testing」**（介于 in/out 之间）。
4. **本仓节奏不变**：MVP 保持单用户（全角色=操作员），但 **schema 现在为 engagement / 角色 / ask-before 留位**（只留字段不建 UI），避免日后迁移；吸收停留在机制层，不做 SaaS 化。

## 一、外部事实（调研记录）

| 来源 | 事实 |
| --- | --- |
| PTES / NIST SP 800-115 | 标准化的是**阶段与engagement制品**（pre-engagement、scoping、RoE、报告），不定义团队角色矩阵；角色来自交付组织实践与平台产品 |
| Safeguard RoE 指南 | RoE 最小十节：双方与联系人（技术+业务）、授权范围、测试窗口（起止/时段/时区）、允许手法（DoS/物理/社工须**单独明确授权**，默认不含）、数据处理、通信协议（状态节奏/安全通道）、紧急停止与升级、授权函、报告格式与交付期限、双方签署；建议 `scope.yaml` 含 **ask_before_testing** 类；每日状态节奏缺失视为升级触发器；关键漏洞发现 1 小时内通知；收尾需**书面确认清理**（测试账号/webshell/持久化） |
| AttackForge | 项目访问三级且高含低：**View**（客户：看/按需报告/申请复测/导出）→ **Upload**（开发：+上传文件/备注）→ **Edit**（测试：+建漏洞/范围/用例/攻击链/执行摘要/复测）；**project role 只用于展示（dashboard/报告署名），不授权**；组访问与 member admin（访问级别上限可配）；通知按事件分级（daily start/stop、按严重度新漏洞、复测生命周期、团队变更）；测试窗口可用性视图防双排 |
| PentAGI | 多用户角色与权限；API token **继承所属用户的角色权限**；产品内部是 AI 多角色委派（与本仓 D4 无关，别混） |

## 二、吸收表（机制 → 本仓落点）

| 机制 | 本仓落点 | 状态 |
| --- | --- | --- |
| client→engagement→tasks 容器 | 新契约：`EngagementRecord { id, clientId, name, auth 契约模板, roe, timeWindow, rateGuidance, deliveryConvention }`；任务创建可选挂 engagementId 并继承 auth | **提案 D4-E（schema 留位）** |
| 跨任务凭据复用边界 | 复用条件=同 engagement + 凭据 asset ∈ 目标任务 scope + 审计事件（credentialId 而非明文）；禁止跨 engagement | **提案 D4-E（授权层判定）** |
| View/Upload/Edit 三级 + 角色不授权 | 控制台访问级别（未来多用户）；单用户 MVP = Edit。报告/看板显示角色标签 | **留位不实现** |
| scope 第三类 ask-before-testing | `AuthScope.askBefore: string[]`（命中需 consult 或显式确认，默认空） | **提案（小字段）** |
| RoE 十节 | 已有/已提案映射：timeWindow/roe/rateGuidance/consult/紧急停止/数据处理/D8 报告与复测；补「通信节奏与联系人」「清理书面确认」进交付清单 | **部分已有**；补两项进 D8/D6 |
| 关键漏洞 SLA + 状态节奏 | consult urgency + 通知分级（按 severity/事件） | **提案（通知集成）** |
| 复测工作流 | retested 状态细化：flag→request→retest→close，客户可申请（View 级） | **提案（D8 联动）** |
| 人-人交接包 | 交接包 = report.md + report-evidence/（SHA-256）+ coverage-snapshot + 待答 consult 列表 + 会话/作业清单 + 变更台账 + engagement scope 版本 + 未吸收 Hint；必须可独立复核 | **提案（对齐 evidence-review 口径）** |
| 令牌继承角色权限（PentAGI） | 未来多用户 API 鉴权参考；单用户不需要 | **不吸收（当前）** |

## 三、授权 vs 经验：两条共享通道必须分开

| | 授权共享（engagement） | 经验共享（P8 全局记忆） |
| --- | --- | --- |
| 内容 | 凭据/会话/finding/scope 在本委托内复用 | Lesson/Playbook/工具遗产 |
| 边界 | 同 engagement + scope 覆盖 + 审计 | 无授权含义；注入只走建议层 |
| 载体 | engagement 容器（授权层） | 记忆图谱（建议层） |
| 铁律 | 跨 engagement 复用一律拒绝 | 旧 Fact 直写新任务图一律拒绝 |

## 四、定案（2026-11-22 用户拍板）

| 问题 | 定案 | 设计落点 |
| --- | --- | --- |
| 客户能否触发复测 | **可以**：View 级客户可直接发起复测，不必 operator 转批 | D8 retest 工作流：finding → retest Intent（sourceFactIds=finding fact）→ 复测证据 → retested/closed；权限 = View 级 |
| reviewer 跨任务 | **可以**：reviewer 属 **engagement 级角色**，可跨任务署名复核整程序；复核记录仍逐任务落表 | engagement 级 reviewer + 跨任务复核 API；覆盖快照盲评沿用 |
| member-admin | **做**，按调研最佳实践（AttackForge 模式）：访问级别上限、组访问、member admin 默认最低访问；单用户 MVP 隐藏入口但 schema 留位 | E-schema/E-api 阶段；权限判定先于 UI |
| 跨团队接手 | **直接继承**。本仓是单人 MVP，「跨团队」指 **AI 侧接手**（继任 Worker/新会话/交接包）——直接继承 engagement 授权上下文，不重签；不同法律实体转手不在当前范围 | 交接包 = 继承载体；AI 接手走 Relay π + 交接包，图仍权威 |

## 五、分期建议（调研完成 + 定案后）

```text
E-schema：engagement 容器 + askBefore + 角色标签（owner/operator/reviewer/viewer，reviewer 作用域=engagement）（纯留位，单用户行为不变）
E-api   ：engagement CRUD + 任务挂载/继承 + 跨任务凭据复用判定（同 engagement + scope 覆盖 + 审计）
          + 客户触发复测入口（View 级）+ 跨任务复核 API
E-ui    ：控制台 Engagement 页 + 成员/访问级别/复测申请（单用户隐藏 member-admin 入口）
依赖：P11 S1（会话/作业清单进交接包）、E2（凭据）、evidence-review（交接包口径）、D8（复测状态机）
```

## 六、明确不吸收

- 多租户 SaaS / 计费 / SSO / 客户端实时看板优先级。
- 角色戏 UI（本项目面板不出现虚拟角色军团）。
- 把 project role 当权限（与推荐≠授权冲突，看到就停）。
- 跨 engagement 的凭据「方便复用」。