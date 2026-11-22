# GongYuAI 控制台定位调研

## 结论

产品面应定位为 **Mission Control（长程任务控制台）**，而不是对话页或 JSON API。  
市面高星渗透/Agent 产品几乎都是：**左侧导航 + 总览 KPI + 任务深潜多面板 + 实时输出**。

## 对标样本（2026-11）

| 产品 | Stars 量级 | 控制台骨架 |
| --- | --- | --- |
| [PentAGI](https://github.com/vxcontrol/pentagi) | ~34k | Flow 列表 → 详情：Agent 进度 / Plan / Terminal / Analytics / Report |
| [ARTEX](https://github.com/BaaRai/ARTEX)（本机 Kali 已装） | fork ~2k | Dashboard → Tasks → Assets/Coverage/Traffic/Findings → System(LLM/MCP/Approvals) |
| [CyberStrikeAI](https://github.com/Sycun/CyberStrikeAI) | 自研 | 对话控制台 + 任务管理 + 设置/MCP |
| HexStrike | ~13k | 偏 MCP 工具面；进程 dashboard API，不是完整业务控制台 |
| AgentOps / flux7-console | 模板/治理向 | Observe(Traces/Sessions) + Govern(Approvals/Policies) + KPI |

## 共性信息架构（必须对齐）

1. **总览**：活跃任务、完成数、失败/恢复、用量。
2. **任务列表**：状态徽章、目标摘要、可点进深潜。
3. **任务深潜**（同一任务内多 Tab）：
   - Live / 进度
   - Plan 或 Goals
   - 终端/日志
   - 证据 / Findings
   - 报告
4. **系统区**：模型、运行时、工具/授权（可后置）。
5. **实时感**：轮询或 SSE；状态要“活着”，不能只刷新整页 JSON。

## GongYuAI 差异化（不要做成 ARTEX/PentAGI 仿制品）

| 别人强调 | 我们强调 |
| --- | --- |
| 双图探索 / 多 Agent 角色戏 | **Durable 长程**：lease、fence、checkpoint、崩溃恢复 |
| 聊天驱动 | **任务契约驱动**：授权范围 + Goal 证据闸门 |
| Findings 卡片墙 | **分层 History**：title → summary → evidence |
| 工具目录 | Worker 工具 + 缺工具自装审计 |

产品一句话：

> **给授权渗透长程任务的 Mission Control：任务可断点续跑，完成必须有证据。**

## 控制台 IA（定案）

```text
Overview          KPI + 最近任务 + 恢复事件
Tasks             任务列表 / 新建入口（CLI 先，Web 后）
  └ Task detail
       Live       状态 / lease / phase / 预算燃烧
       Assets     授权靶标 + 运行中发现（与 History 资产投影同表，轮询实时）
       Goals      证据闸门清单 + Fact–Intent DAG
       History    Fact–Intent DAG + 分层列表
       Evidence   证据文件
       Report     报告
       Logs       worker 日志
Settings          runtime / model / dataDir（先只读）
```

资产 Tab 定案见 [asset-inventory.md](./asset-inventory.md)：开局 N 条 seed、发现后 N+M，人机双向同一清单。

图视图族增量（P10 提案，见 [graph-views.md](./graph-views.md)）：任务深潜新增 **Graph workspace**——DAG / 资产 / 攻击面 / 执行 / 记忆五视图切换，全部只读投影、跨图同 ID 导航；既有列表 Tab 保留（图看关系，列表看明细）。

视觉：深色操作台、等宽数据、侧栏导航；避免紫霓虹仿 ARTEX Neon，也避免奶油纸风。
