# 台账交接修订与六批次对照协议

沿用上轮六份合成台账、30 个评分字段及原标准答案。先运行两批回归，再运行六批对照。每个条件包含 bare、DAG、DAG + Relay 三组；每题各重复两次，沿用原组序平衡规则。所有输入材料在本地准备，模型请求只携带合成台账。

## 交接中记录什么

写交接时，`withdrawals` 分开记录发布意见的 `notice`、被撤回的原记录 `subject` 和适用范围 `scope`。`history` 分开保存目标 `goal`、历史日志状态 `recorded`、原版能否复验 `recheck` 和来源 `source`。举例来说，一项历史验收可以同时是 `passed` 和 `unverifiable`。接班时再次解释这两对字段。每一批只写新增信息；缺少材料可以留空。

这份结构用于离线文档复核。模型自己填写字段；程序仅检查结构、枚举和记录编号是否已出现，不从答案填充或纠正结论。格式校验失败时，原文连同标记交给下一任；不追加模型请求。每次交接继续通过项目 Session Relay 落盘。继任会话累计读回所有已写世代，再阅读本批材料与 DAG 祖先。

## 两批回归与六批对照

两批回归复用旧批次和 bare、DAG 提示，只修订 Relay 的写入与读回约定。重点分开计分：四题的 `withdrawn` 共 8 项，LEGACY 的 `old_goal` 共 2 项，并核对其 `version`、`owner_then` 和全部字段。历史对照取自已公布的 72 次调用，本轮另外实际运行三组。不依据回归结果调整六批提示或评分。

六批条件按原顺序等分全部 F 记录，向每批顺序分入原有例行归档行。每一行只发一次新材料，每批至少一条 F，前驱先于派生记录。三组共用相同批次；DAG 在本批到达后才写图，只回读本批引用的已到达祖先。bare 和 DAG 保留往返消息。Relay 在五个批次边界新建会话，五次笔记的写入和历次读回都计入用量。批次间不增加材料或评分字段。

同一模型 `deepseek-flash`、temperature 0、关闭 thinking、JSON 输出。两种批数都沿用每题次总上限 16,384 个输入加输出 Token，每个中间批次输出上限 384，最终批次 256。预算预检使用 UTF-8 上界和封装余量，对未变的历史前缀可复用已实测的输入计数；最终使用服务端 usage。若剩余额度不足以发送下一批，保留已有耗用，该题次按未完成计零分。服务错误单独处理。每次调用保留请求摘要、结束原因及输入、输出、缓存计数。

预先定义的联合判据为：六批 Relay 的总 Token 比同条件 DAG 少，并且正确字段数和整题全对数都至少与 DAG 持平。另列与 bare 的差额及每题结果。这里的“较长”指同一台账连续六次读件、五次交接；独立样本仍只有六份。

```sh
node --test examples/offline-review/ledger-handoff.test.mjs
node --import tsx scripts/review-model.mjs run-2 .gongyuai/ledger-v2/two
node --import tsx scripts/review-model.mjs run-6 .gongyuai/ledger-v2/six
node --import tsx scripts/review-model.mjs score .gongyuai/ledger-v2/six/trials.jsonl
```
