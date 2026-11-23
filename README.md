# GongYuAI

GongYuAI 是面向授权安全评估的单用户长程 Agent 工作台。它把委托目标、每一步判断的依据和交付时引用的原件保存在任务里。一次评估即使跨过多个会话，下一位接手者也能查清上次停在哪里、哪些结论有证据、还有哪些问题需要人来确认。

一个典型问题是「这项结论当时依据哪份材料？」同一路径的附件可能已被新版覆盖，聊天记录也可能只剩一句“已经核对”。GongYuAI 在目标首次通过时封存所用的证据版本。复核人可以从报告取回当时的字节，沿记录找到后来的更正，再判断今天还能交付什么。

[离线设计导览](docs/design-atlas.html) · [架构说明](docs/architecture.md) · [交付与验收记录](docs/delivery-record.md) · [授权使用说明](DISCLAIMER.md)

## 先跑一份可以亲手复核的报告

准备 **Node.js 22.19.0 或更高版本**、**pnpm 10.15.0**。下面的例子只用本地合成台账，安装依赖后即可离线运行，无需模型密钥或 Docker。已有源码时，从仓库根目录的安装命令开始。

```sh
git clone https://github.com/Sycun/GongYuAI.git
cd GongYuAI
pnpm install --frozen-lockfile
pnpm build
GY_REVIEW_OUTPUT="$PWD/out/readme-review" pnpm review:offline
```

终端会打印本次生成的 `report.md` 路径。打开报告里的「逐项目标复核」，检查收件凭据 **R-017** 的两个目标。

| 在报告里怎么查 | 应当读到什么 |
| --- | --- |
| 打开「核对收件归属」下的「断言时证据」 | 封存件里的收件号是 R-017，归属是 B。同一运行目录下的工作副本 `evidence/archive/receipt.json` 最后已改为 C。 |
| 顺着「已撤回」往下读 | 误记为 A 的判断保留了撤回理由。沿用 A 的汇总标为待复核，更正为 B 的记录有自己的复核依据。 |
| 查看「核对签收人」 | `signoff.json` 已收到，内容是 `signed=false`。签收目标仍为「未验证」，本次两个目标中只有一个通过。 |

每次运行都会在 `out/readme-review/` 下新建一个目录。把其中的 `report.md` 和同级 `report-evidence/` 一起交给另一位读者，对方仅凭这两项就能复核报告引用的原版。[案例推演](docs/evidence-review.md) · [验收用例](packages/history/src/review-acceptance.test.ts)

## 长任务怎样接续

| 遇到的问题 | 项目怎样处理 |
| --- | --- |
| 下一步为什么值得做？ | **Fact–Intent DAG** 用事实（Fact）记录观察，用意图（Intent）记录基于哪些观察要做什么。新观察连回产生它的意图，读者可以沿有向无环图回查依据。目标（Goal）单独约定交付条件。 |
| 进程中断后从哪里继续？ | **控制面与 Pi Durable Worker** 分别管理任务生命周期和执行进度。Worker 写入检查点，控制面通过租约和 Watchdog 识别失联的执行进程，恢复时重新打开该任务的持久状态。 |
| 模型上下文快用完时交给谁？ | **Session Relay** 在换会话时写下当前进度、相关记录和待办。继任会话按交接线索回到 History 查原件。进程意外退出时，恢复所依赖的是上一次已经落盘的检查点和记录。 |
| 怎样判断目标已经完成？ | **证据校验**检查目标声明的文件匹配规则，以及该目标配置的内容判据。报告分别列出历史通过、当前仍有证据支持和人工覆盖情况。读者可以据此决定哪些结论需要重核。 |

这些选择有三条设计来源。Cairn 的 Fact–Intent 图把观察与后续工作连起来。女娲的接班思路要求继任者能从任务记录重建进度。Super-agent 的设计则提出把规划、执行和复核分工，并用对照实验衡量分工的收益。控制台里的多角色会议场景是这项设计的演示。[Fact–Intent 设计](docs/theory-fact-intent-dag.md) · [女娲与交接](docs/absorb-sapper-v2-nuwa.md) · [Super-agent 设计](docs/absorb-super-agent.md) · [运行与恢复契约](docs/long-run-contract.md)

## 打开 Web 工作台

完成构建后，从仓库根目录启动本机控制面。以下命令使用独立的数据目录，适合初次体验。`--isolated` 会跳过旧任务导入、Watchdog 和后台作业队列。

```sh
pnpm gy serve --isolated --data-dir "$PWD/out/readme-demo" --host 127.0.0.1 --port 8787
```

保持这个终端运行，在浏览器打开 [本机工作台](http://127.0.0.1:8787/)。想先看界面，可进入「设置与功能 → 演示场景」，逐条查看两份会议纪要怎样形成一致结论和待确认项。这个内置演示使用固定数据，无需模型。也可以从另一终端执行 `curl -fsS http://127.0.0.1:8787/health`，确认服务返回 `"ok": true`。结束体验时，在服务终端按 Ctrl+C。

### 提交一项材料核对任务

1. 在「设置与功能 → 模型配置」中选择协议，填入服务地址、主模型 ID 和服务所需的密钥，勾选「设为新任务的默认模型」并保存。任务模型会收到这次提交的文字和附件，请选择适合处理这些材料的服务。
2. 在会话首页附上两份 UTF-8 文本。例如甲版写「周三评审，预算 8 万元」，乙版写「周三评审，预算 10 万元」。输入「请列出两份纪要的一致项和待确认项，并注明各自出处」后发送。
3. 提交后会得到任务 ID。回到「设置与功能 → 任务」可按该 ID 找到同一项任务。在「证据」查看 `task-result.md`，核对结果是否保留了共同的评审日、两项预算及各自来源。工作区的默认交付条件检查结果文件是否已提交，内容是否准确仍可对照原件复核。
4. 如果任务暂停，先看会话里的原因。材料不足时可补充材料。涉及本地只读检查时，服务端先判断命令是否在任务授权范围与执行器支持范围内，超出范围直接拦截并给出原因；范围内的命令再按「命令执行前如何确认」处理：低风险自动审批由审批模型判定后直接执行，逐次确认则在会话的审批卡里由你「允许本次 / 拒绝本次」，确认后卡片回显实际执行成败，审批配置在「设置与功能 → 命令审批」。

**任务记录的位置。** 本例把服务端记录保存在 `out/readme-demo/`，使用同一目录重启即可再查。常规数据根默认为安装目录下的 `.gongyuai/`，可通过 `--data-dir` 或 `GY_DATA_DIR` 指定。会话列表和项目分组保存在当前浏览器。前面的 R-017 离线报告是独立生成的文件，可直接按终端给出的路径阅读。

**参考资料的位置。** 在「设置与功能 → 参考资料」可以按共享范围或所选任务的委托范围检索文档段落。关键词检索可直接使用，混合检索还会使用已配置的向量索引。报告引用可以定位到资料版本和段落，任务本身发生过什么则回到该任务的 History 和证据核对。[资料库与引用契约](docs/knowledge-library-api.md)

### 从命令行核对同一项任务

保持上面的服务运行，在仓库根目录的新终端执行。把 `TASK_ID` 的值换成完整的任务 ID，打开任务详情后可从地址栏末尾复制。

```sh
TASK_ID='替换为任务 ID'
pnpm gy status "$TASK_ID"
pnpm gy scorecard "$TASK_ID" --out out/scorecard.json
pnpm gy scorecard --recompute out/scorecard.json
```

第一条查询当前状态。第二条导出计算记分卡所用的快照。最后一条只读快照文件，复算目标计数并校验摘要，输出中的 `sealValid` 表示快照校验是否通过。

开发控制台时，可在另一终端运行 `GY_CONSOLE_API=http://127.0.0.1:8787 pnpm dev:console`，从 Vite 打印的地址打开页面。这里显式指定了后端端口，因为 Vite 的默认代理指向 8877，而上述 CLI 服务监听 8787。

## 已有实验能说明什么

仓库保存了一组关于交接成本的模型实验。六份合成台账各分六批阅读，每份重复两次，每次核对五个字段。下表可用仓库内保留的逐次记录离线复算。

| 历史材料如何交给模型 | 正确字段 | 五项全对的题次 | 输入与输出 Token 合计 |
| --- | ---: | ---: | ---: |
| 保留完整对话（bare） | 49 / 60 | 9 / 12 | 80,787 |
| 完整对话加 DAG 祖先材料 | 34 / 60 | 6 / 12 | 90,316 |
| DAG 加 Session Relay，批次间换会话 | 54 / 60 | 7 / 12 | 71,017 |

在这组材料上，Relay 用量最低，正确字段最多，完整对话组的整题全对次数最多。评分要求按指定 JSON 字段交付，一些写进笔记的正确答案因此丢分。实验衡量的是固定台账和交接方式。真实委托上的判断质量、连续运行表现和供应商故障切换仍需单独验证。[完整实验、错例与复算命令](docs/experiments/2026-11-22-ledger-relay/README.md) · [第九轮验收边界](docs/owner-unverified-r9.md)

## 仓库导航

| 入口 | 适合从这里了解什么 |
| --- | --- |
| [apps/console](apps/console) · [apps/cli](apps/cli) | React / Semi Design 工作台，以及与控制面交互的 `gy` 命令。 |
| [packages/contracts](packages/contracts) · [packages/history](packages/history) | 任务与目标的数据契约、SQLite 历史图、证据封存和报告生成。 |
| [packages/control-plane](packages/control-plane) · [packages/worker](packages/worker) | HTTP 服务、任务生命周期、作业队列、执行检查点和会话接力。 |
| [examples/offline-review](examples/offline-review) · [docs/experiments](docs/experiments) | 合成题面、对照协议、逐次输出和评分结果。 |
| [文档索引](docs/README.md) · [开发手册](docs/dev-handbook.md) · [实施台账](docs/implementation-ledger.md) | 从总体设计查到对应代码、阶段验收和待验证项。 |

项目面向自有系统或取得明确书面授权的安全评估。正式委托应记录授权说明、允许的目标与排除范围。当前工作台按单用户模式设计。[授权使用说明](DISCLAIMER.md)
