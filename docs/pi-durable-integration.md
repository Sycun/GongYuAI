# Pi 底座能力盘点与深化路线（pi-durable / chord）

2026-11-22 调研。底座：`@earendil-works/pi-ai` / `pi-durable` / `pi-schema` / `chord` ^1.6.0（**pi-durable 自标 Experimental，API 随版本变**）。  
配套：[pentest-ops-design.md](./pentest-ops-design.md)（P11）· [dev-handbook.md](./dev-handbook.md) · [long-run-contract.md](./long-run-contract.md)

## 结论（先读这四句）

1. **底座已付费的能力远超当前使用量**：handoff/compaction/subagents/child tasks/task graph/Code Mode/hooks 全是原生；GongYuAI 主循环仍以手写 OpenAI fallback 为主纪律，Pi 路径只用了 Harness+storage+resume+提示扩展+usage 心跳。
2. **职责重新划线**：pi storage 管**会话持久性**（turn/工具级崩溃恢复），History DAG 管**攻击路径真相**（语义级）。checkpoint 手造层逐步委托底座；自研精力集中图/证据/记忆。**底座管活，图管对**。
3. **Code Mode 是渗透最大红利**：模型写 JS 编排脚本调工具，QuickJS 沙箱、崩溃原地续跑、已完成调用不重放、嵌套调用全过 hook 闸——sapper「auto_pivot.py + 文档传承」的结构化 durable 版本；工具遗产（P8 ToolArtifact）可直接是 codemode 脚本。
4. **pi transcript 永不成为真相源**（反模式 1）；compaction 摘要不是 Fact；迁移按增量开、每步过差分再升主纪律，fallback 保留作 bare 基线。

## 能力映射（缺口 → 原生）

| 缺口/提案 | 原生能力 | 现状 |
| --- | --- | --- |
| Relay 手写 π + 清 buffer | `reset(handoff note)` + 工具 `control:{handoff}`；旧 entries 留 storage（append-only 同构） | 未用；π 字段保留为 handoff 内容规范，机制委托底座 |
| 上下文饱和 85/90 | Compaction：reserveTokens/keepRecentTokens/backgroundTokens 自动 + 手动带指令；压缩时会话不停 | 未配置 |
| P7 模型分层/脑手分离 | Subagents：子会话配便宜模型、ownership 崩溃重放复用、禁递归 | 未用；`execution.models` 映射子会话 configure |
| 工具单闸/相位过滤 | `beforeTool` hook：block/rewrite/wait；`afterTool`/`onYield`/`afterTools` | 相位过滤已走扩展；闸未走 hook |
| 长任务 120s 被杀（P11） | chord **jobs**（outlive the call）+ Code Mode durable 脚本 | 未用 |
| 执行图数据源（P10） | `watchTaskGraph`：owner 边/status/waiting 依赖 | 未用 |
| 会话管理器骨架（P11） | extension + chord document/job + OutputBuffer（有界输出窗口） | 需建，底座承载 |
| 并行编排 | Child tasks：waiting/allSettled/failFast/any，abort 自底向上 | 未用（现多进程 slot） |
| checkpoint 计数 | Harness「Your Own State」+ SQLite WAL storage | 部分手造 |

## 混合架构判断

- **进程 slot 与 subagents 并存**：重并行 Explore 保留多进程（OS 隔离 + 独立 checkpoint）；轻量委派（**独立 AI 复核 Fact**——女娲 PPT 机制、报告起草、单点验证）用便宜模型 subagent，replay-safe。
- **会话/作业是任务级 chord 对象**：worker 崩溃/暂停不杀；重启 reconnect（P11 暂停保活的底座依据）。
- **作业完成回流** = `root.submit()` durable 通知，模型不轮询。

## 深化增量（每步差分验收，不一次性重写）

1. Compaction 配置上 Pi 路径（reserve/keepRecent 对照 Relay 双触发调参）。
2. Relay 机制切 `reset(handoff)`/`control:{handoff}`，π 协议字段不变。
3. gateTool 收口 `beforeTool` hook（拒绝/限速等待统一入口）。
4. Code Mode opt-in（内存限额 + 嵌套调用过闸 + 脚本遗产人审）。
5. Subagent 独立复核 Fact（便宜模型）+ `watchTaskGraph` 喂执行图。
6. 差分证明 Pi 路径 ≥ fallback 后，主纪律切换；fallback 降为 bare/回归基线。

## 风险与纪律

- Experimental API：**锁版本 + 适配层隔离**，升级走回归。
- transcript/compaction 摘要不写 Fact；图仍是跨会话权威。
- Code Mode 脚本 = 模型生成代码：沙箱限额 + 全调用过闸 + 破坏性 denylist + 遗产人审。
- 底座能力不改变授权语义：scope/证据闸/推荐≠授权在 hook 层之上照常。