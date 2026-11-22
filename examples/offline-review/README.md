# 离线台账真模型对照协议

本实验测量读者复核同一批台账的准确率和模型用量。题目只包含合成档案；模型服务完成推理，本地 SQLite 保存图和交接文件。第一批与第二批均来自固定的 [cases.json](./cases.json)。R017 复用原离线验收情境，LEGACY、BYTES 改编自历史版本和二进制附件回归；其余三题分别检查多级依赖、按目标撤回和独立重核。例行整理条目按题库中的 noise 个数生成。题库内 gold 仅用于评分。

## 分组与执行

每题分两次模型调用。第一次三组收到完全相同的原始时间线和最终问题，先写一份工作笔记。每条有依赖的原始记录都带来源编号。第二次揭示后续材料并要求 JSON 答案。

- **bare** 保留第一阶段完整对话，按时间顺序追加第二批材料。
- **DAG** 同样保留完整对话。通过项目 HistoryStore 建立 Fact–Intent 边，从第二批节点反向遍历全部祖先，将命中的第一批原文和依赖编号附在第二批材料之后。检索不读问题答案、人工标签或最终报告。
- **DAG + Relay** 使用同一份第二批材料和祖先索引。第一阶段模型笔记经项目的 writeRelayProtocol 落盘，再由 listRelayProtocols 和 formatRelayInjection 读回。第二次请求新建消息列表，只携带公共系统指令、交接和当前批次。这个实验在预定批次边界触发一次交接。

使用同一 deepseek-flash 服务、temperature 0、关闭 thinking、JSON 输出。每题每组统一上限 **16,384 个输入加输出 Token**。第一次最多生成 384 Token，第二次最多 256 Token。发送前按 UTF-8 字节加消息封装预留检查，收到响应后按服务端 usage 再检查。交接记录的生成、重读和重发历史的用量全部计入。

每题两次重复，固定 6 种组别顺序，第二轮反转题序并更换各题的组别顺序，每批并行处理两道不同的题。同一题内三组依次执行。从实测中保留输入、输出、缓存命中、响应模型、请求摘要以及用于评分的模型文本。服务故障不会作为错误答案或零 Token 计数；使用同一输出目录可恢复已完成调用。

## 评分

每题五个字段逐项与固定标准答案比对，只忽略字符串首尾空白。缺键、错类型、错值均丢失该字段分数。最终输出无法解析或被截断时该题五项记零。主指标为字段准确率；同时报告五项全对的题次比例、每题和每组总 Token、相对 bare 的配对差额。两次重复共享题面，独立题目数为六。模型返回的缓存命中计入输入，用量与货币费用分别解释。

## 复现

在仓库根目录安装锁文件依赖，先构建 contracts 和 history。准备环境变量 GY_MODEL、OPENAI_BASE_URL 和 OPENAI_API_KEY。只复算评分时无需配置模型凭据。

```sh
pnpm --filter @gongyuai/contracts build
pnpm --filter @gongyuai/history build
node --import tsx scripts/review-model.mjs run .gongyuai/review-model
node --import tsx scripts/review-model.mjs score .gongyuai/review-model/trials.jsonl
```

这是对文档复核时的历史表示和一次会话交接的比较。没有调用生产执行循环、外部目标、Shell 工具或 MCP。部分题材继承回归用例，样本适合核对测量和发现具体错误。
