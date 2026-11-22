# 吸收对照：Agent 差分评测方法学（P7 基准采纳）

调研日：2026-11-22。状态：**定案采纳，P7 差分按此执行**（不改代码）。  
外部来源：
- [Benchmarking AI Agent Performance: A Practical Protocol（MLflow, 2026）](https://mlflow.org/articles/benchmarking-ai-agent-performance/)
- [Efficient Benchmarking of AI Agents（arXiv:2603.23749, 2026）](https://arxiv.org/html/2603.23749v1)
- [Inspect AI（UK AISI）](https://github.com/UKGovernmentBEIS/inspect_ai) · [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness)
- 本仓既有实践：[offline-review](../docs/experiments/2026-11-22-offline-review/README.md) · [ledger-relay](../docs/experiments/2026-11-22-ledger-relay/README.md)（冻结协议 / trials.jsonl / 离线复算已先行）

## 结论（先读这四句）

1. **结论先行：排名与配对差比绝对分数可信**。Agent 评测中脚手架差异造成的分数波动可达模型差异的 10 倍（ClawBench 口径）；绝对分数在脚手架/时间漂移下塌陷，而**排名保真稳定**（arXiv 2603.23749：ρ≈0.93–0.95）。P7 只报相对差分与配对结论，不报「绝对能力」。
2. **任务子集用中难度带**：历史通过率 **30–70%** 的任务携带最强区分信号，可削减 **44–70%** 任务量而保持排名保真（IRT 依据）；随机抽样方差大、贪心过拟合，均不采用。TSecBench 子集先取 **8 题**（Web/AD/内网分层，每类 ≥2，至少 2 题触发 Relay），历史通过率不足时用离线夹具校准或放宽到 25–75%。
3. **统计与记录是硬要求**：每配置 **≥3 次重复**（成本允许 5 次），报 mean±std + bootstrap 95% CI（≥1000 重采样）；**成本（token/墙钟/工具调用）一等公民**；**脚手架指纹**必须记录（P7 的路由配置就是处理变量本身：模型版本、pi-durable 版本、路由配置、prompt hash、工具版本、日期）。
4. **确定性主判 + 门控裁判**：完成判定以证据闸与确定性检查为主（本仓天然满足）；LLM 裁判只在确定性不可用处作为**次要信号**且限权。holdout 只验不调；单次运行结论一律不得作为晋升依据。

## 调研事实（摘录）

| 来源 | 事实 |
| --- | --- |
| MLflow 协议 | ≥3 seeds（发表级 5+），报告 mean±std；全量 trace；中难度过滤（30–70%）省 44–70% 任务；脚手架指纹（插件配置波动可达模型 10 倍）；成本每任务一等公民；bootstrap 95% CI（≥1000 次）；确定性检查优先、LLM 裁判 ≤20–30% 权重；预算硬帽 + `BUDGET_EXCEEDED`；失败尝试 token 消耗可达成功 4 倍（token snowball） |
| arXiv 2603.23749 | 8 benchmark / 33 scaffold / 70+ 配置：绝对分预测在脚手架/时间漂移下崩（R² 0.90→0.50），**排名保真稳**（ρ 0.90–0.96，最优策略 τ 最差 0.80）；中难度过滤 30–70% 削减 44–70%（中位 58%）且保真最好；随机种子等高方差；冷启动需 5–10 个全量跑、15 个稳定；用于常规排名，全量跑留给初始化/漂移检查/大版本跳变 |
| Inspect AI / lm-eval-harness | 评测框架化：任务定义/评分器/日志/复算分离；可复现产物（任务、种子、日志、评分代码）随结果发布 |

## P7 采纳协议（冻结后执行）

**处理变量**：A=全强模型（基线） vs B=三层路由（reason 强 / explore 快 / bootstrap 快）。同预算：token、工具调用、墙钟上限一致；同工具白名单；同 prompt（除路由配置）。

**流程**：
1. 协议先冻结提交（任务集、预算、重复次数、路由配置、prompt hash、日期）；冻结后才跑。
2. 离线夹具先行（零成本）验证计量与形状（形状不对不进真平台）。
3. 真 TSecBench 子集 **8 题**：Web/AD/内网分层各 ≥2，至少 2 题需 Relay；按历史通过率 30–70% 选；数据不足先做 3 题冷启动校准或放宽 25–75%。
4. 每配置每题 **≥3 次重复**（预算允许到 5）；逐题配对（同题 A/B 差值），aggregate 之外必须报配对。
5. 指标：Goal 通过率（证据闸确定性主判）、finding precision（E1 后补）、token/墙钟/工具调用、gate 拒绝数、交接损失。
6. 统计：mean±std + bootstrap 95% CI（1000 重采样）+ **配对差 CI**；CI 重叠不宣称胜负。
7. 记录：结果 JSONL（逐次请求摘要/用量/终态）＋脚手架指纹 manifest，可离线复算（沿用 `scripts/review-model.mjs` 模式与 `trials.jsonl` 纪律）。
8. **晋升门**：B 相对 A 成本显著下降（配对 CI 上限 < 0）且通过率非劣（配对差 95% CI 下限 ≥ **-5pp**）→ 路由可升默认；否则保持 A。阈值 -5pp 为默认，可调但须先写进冻结协议。

## 明确不做

- 单次运行/单题结论；随机抽样代替中难度带；贪心选任务；绝对分数排行榜。
- holdout 参与调参；LLM 裁判当主判；预算不设帽；不记脚手架指纹。
- 用赛会 AK/单次分替代本协议差分；把 TSecBench 成绩外推为通用能力。

## 若再动手

- F1 记分卡落地后，把本协议的统计列（CI、配对差、成本）直接接进记分卡报表。
- E1/E6 完成后，finding precision 纳入本协议指标集。
- 需要更强结论时再扩到 10 题或第二数据集；扩题前保持 8 题基线可比。