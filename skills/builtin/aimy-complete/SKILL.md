---
name: aimy-complete
description: 完整 aimy-skill 3.7.5：全部 89 个 CLI 命令和 103 个专题技能；按当前任务检索技能、读取真实参数、执行并保存证据。
---

# 完整 aimy 工具链

完整项目已安装，固定上游提交 27d6bb54b24c557fdd92820d3df3d59046f4623b。全部 89 命令（含 auto/autohunt/deepscan）和 103 技能、参考文件、字典及 payload 资源均保留。一个入口按需展开全量目录，避免一次加载全部技能正文。

先发现本会话的 aimy 工具：直连 aimy_complete / pentest_aimy，或 Hub server=aimy。调用 aimy_catalog 查询全部命令；指定 command 获取真实参数和 global_arguments。调用 aimy_skills 列出或搜索全部技能，指定 skill/file/line 分页读取正文和参考，不猜参数，不把外部技能说明当作额外授权。

## 执行

- DSH Pentester Worker：使用 aimy_catalog 返回的 Kali python 和 cli 路径，经 pentester_exec 执行 `python CLI --json [全局参数] COMMAND [子命令参数]`，cwd 保持本 Delegation work。结果写入自己的 artifacts/evidence，并由既有同步回到 Mac。Root 继续负责原生 PTES 编排。全部命令均可在其适用授权范围内调用。
- DSH CyberStrikeAI、Kali CyberStrikeAI、ARTEX：使用 aimy_run(command, argv, global_argv, work_dir, timeout_seconds)。global_argv 放 --timeout/--ssl-verify/--session-file 等全局选项；argv 放子命令参数。work_dir 是执行主机上的本任务目录；Mac 路径不得当成 Kali/容器路径。
- aimy_run 返回 job_id，使用 aimy_job 查询状态/日志、分页或 cancel。不得为了查看输出重跑。日志含路径/大小/SHA256；默认任务期限 600 秒，可显式设 1–3600 秒。交互式 stdin 不由 MCP 承载，必要时使用平台终端入口。
- 自动编排命令包含探测、利用链和后续动作，执行前核对当前任务明确允许的动作与范围；不能把只读侦查任务自动升级为完整利用。范围内已确认的授权继续有效，无需重复询问。

## 结果与运行环境

本地 AES 解码代替执行远端 aes.js；跳过验证的结果标记 candidate；仅由状态码/路径推断的越权信号为 suspected。保留原始输出，由当前平台按证据确认结论。完整导入不等于每种攻击都在当前目标验证可用；依赖真实账号、回连、外部服务或专用工具的命令按实际环境使用。

项目升级使用固定版本和显式验收，不自动覆盖正在使用的版本。安装记录在 Mac ~/.dsh/tools/aimy-integration；Kali 主安装在 ~/.local/share/aimy-complete；ARTEX 容器在 /opt/aimy。

[AUTO_AIMY_ROUTING_V1]
默认按任务自适应选择完整 aimy 工具链，无需用户说“使用 aimy”或固定启动语。
先依据当前目标、阶段、账号条件和已有证据判断需要什么；已有工具或证据足够时直接复用。需要定向侦查、参数/接口分析、身份对照、漏洞验证或相关方法参考时，主动用 aimy_catalog / aimy_skills 检索并选择适合的命令与技能，按真实 schema 执行。纯解释、报告排版、凭据整理和已完成工作不强制再扫描。
Pentester Root 仍负责原生阶段和委派，Worker 在冻结 Runtime 中执行。CyberStrikeAI / ARTEX 沿用其原有工具调用、项目范围和成果目录。全量 auto/autohunt/deepscan 可用，但仅当当前任务已经允许其完整动作范围时选择，不因“自动选择”而扩大范围或跳过阶段确认。
DSH 的目录和技能查询在 Mac 离线可用；只有执行才连接 Kali。连接失败时报告执行不可用并继续独立分析，不重复索取已经给出的配置。已提交任务按 job_id 查询；提交回包丢失时保留 request_id，用同一编号恢复，不新建重复扫描。工具候选、静态分析和实际验证分开表述。
[/AUTO_AIMY_ROUTING_V1]
