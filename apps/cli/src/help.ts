/**
 * 默认帮助只保留核心作战与复核交付。
 * 冻结的 P8/P9 与模拟命令通过 `gy --help-experimental` 查看，直接调用仍然可用。
 */
export type HelpMode = "default" | "experimental";

const DEFAULT_HELP = `
GongYuAI CLI (single-user MVP)

核心作战:
  gy serve [--data-dir DIR] [--port N] [--isolated]
  gy run --goals FILE --target URL [--target URL ...] --auth NOTE [--name NAME]
       [--mock] [--wait] [--concurrency N]
       [--capability observe|scan|active-lab|full]
       [--max-wall-ms MS] [--max-tool-calls N] [--max-tokens N] [--max-installs N]
  gy status [taskId]
  gy hint <taskId> "<text>"     # inject tactical Hint into History
  gy logs <taskId>
  gy report <taskId>
  gy pause <taskId>             # 请求暂停；确认 worker 退出后记录为 paused
  gy resume <taskId>            # 从 paused 继续；启动时读取最新任务坐标（操作配置）
  gy scope <taskId> --file SCOPE.json   # { "auth": {...}, "reason": "..." }
  gy stop <taskId>
  gy archive <taskId>
  gy unarchive <taskId>
  gy handoff <taskId> [--next-owner NAME] [--now ISO]   # 跨班接手包
  gy jobs <taskId> [--receipts]        # 持久作业列表
  gy job-submit <taskId> --kind material-check|evidence-pack|parse-import
        --label TEXT --input PATH[,PATH] [--sha SHA] [--asset A] [--options JSON]
  gy job-retry <taskId> <jobId>        # unknown/failed/paused 才可重试
  gy job-ack <taskId> <jobId> --key K [--by NAME]   # 幂等回执（重复投递只记一次）
  gy consults <taskId>                 # 人工求助列表
  gy consult <taskId> --question TEXT [--options a,b] [--blocking true|false]
  gy answer <taskId> <consultId> "答复" --by NAME
  gy consult-sweep <taskId> [--now ISO]  # 24h 转非阻塞（可控时钟）
  gy material <taskId> --path P --file LOCAL --asset A [--kind K] [--secret-ref REF]
  gy materials <taskId>
  gy matrix <taskId> | gy freshness <taskId>
  gy changes <taskId> | gy change <taskId> --kind K --asset A --location L --rollback CMD [--before FILE]
  gy rollback <taskId> --out FILE
  gy graph <taskId> assets|surface|execution | gy causality <taskId> <findingId> | gy today

复核交付:
  gy findings <taskId>
  gy finding-verify <taskId> --finding ID --evidence FILE[,FILE] --repro TEXT
  gy finding-validate <taskId> --finding ID --verdict confirmed|refuted|inconclusive|out-of-scope
       --method evidence-only|replay|control-compare|manual [--evidence FILE[,FILE]]
       [--note TEXT] [--validator NAME]
  gy finding-retract <taskId> --finding ID --reason TEXT
  gy validations <taskId> [--finding ID]
  gy accept <taskId> --finding ID --note TEXT --evidence FILE
  gy audit <taskId>
  gy chain <taskId>                 # 事件哈希链头 + 校验
  gy command-reset <taskId> [--reason TEXT]
  gy review <taskId> --file REVIEW.json
  gy retest <taskId> --finding ID --result fixed|still-present|partially-fixed
            --evidence FILE[,FILE] --repro TEXT [--note TEXT]
  gy retest-request <taskId> --requester NAME --finding ID[,ID] --reason TEXT
       [--role R] [--evidence PATH]     # 客户从正常入口发起复测申请
  gy retest-requests <taskId>
  gy peer-review <taskId> --reviewer NAME --role ROLE --source TASKID --basis TEXT
       [--decision confirm|challenge|retest-requested] [--finding ID | --fact ID]
       [--evidence PATH]                # 同一委托内跨任务署名复核
  gy peer-reviews <taskId>
  gy reconcile <taskId> --baseline PATH --current PATH [--key host] [--required a,b]
       [--name NAME] [--out FILE]       # 从原始材料算差异（新增/移除/变更/未变/缺件）
  gy scorecard <taskId> [--out FILE]    # 交付记分卡；--out 导出可复算快照
  gy scorecard --recompute FILE         # 只读快照，离线复算分子/分母
  gy coverage-snapshot <taskId> --out FILE [--data-dir DIR]
  gy coverage-compare SNAPSHOT REFERENCE --snapshot-sha256 HASH --reference-sha256 HASH
  gy coverage-cell <taskId> --asset A --technique CWE-89 --state manual|verified --reviewer N --reason TEXT
  gy evidence <taskId> --path P --file LOCAL   # 导入材料（utf8 文本）
  gy correct <taskId> --reason TEXT [--findings ID,ID] [--notice pending|notified]
  gy correction-notice <taskId> <correctionId> --status notified|confirmed [--evidence FILE]
  gy corrections <taskId>
  gy session import <taskId> --name NAME --host HOST [--cookie COOKIE] [--header "Name: Value"]
  gy session list <taskId>
  gy session delete <taskId> --name NAME

Defaults: all budget gates unlimited (0). Pass --max-* only when you want a hard cap.
Data dir defaults to <repo>/.gongyuai (not cwd). Legacy ~/.gongyuai tasks are imported on boot.

Environment:
  GY_DATA_DIR  GY_HOST  GY_PORT  GY_RUNTIME  OPENAI_API_KEY
  GY_RELAY_TOKEN_THRESHOLD  GY_RELAY_MIN_TOOL_CALLS

冻结实验命令已收起。运行 gy --help-experimental 查看；直接调用这些命令仍然可用。
`.trim();

const EXPERIMENTAL_HELP = `
GongYuAI CLI 冻结实验命令

以下命令属于冻结支线（P8 跨任务记忆、P9 提案飞轮与评测趋势、角色与供应商故障模拟）。
默认帮助不再展开。直接调用这些命令仍然可用，行为与收起前一致。

  gy memory list | gy memory draft --file F | gy memory review <id> --decision confirm|retract --reviewer N --reason TEXT
  gy memory refs <id> | gy memory inject <taskId> [--asset A] | gy contact --targets A,B
  gy proposals | gy proposal <id> | gy proposal-create --file F
  gy proposal-decide <id> --decision approve|reject --by NAME [--reason TEXT]
  gy proposal-promote <id> --by NAME --eval RUNID | gy proposal-rollback <id> --by NAME --reason TEXT
  gy eval-run --file F | gy evals [--suite S] | gy trend [--tenant T]
  gy role <taskId> --role planner|reviewer|assistant --kind plan|review|incident [--file F]
  gy provider-fault <taskId> --provider NAME --fault rate-limit|timeout|insufficient-balance|egress-denied
        [--attempt N] [--fallback true] [--billing billed] [--tokens N]
`.trim();

export function renderHelp(mode: HelpMode): string {
  return mode === "experimental" ? EXPERIMENTAL_HELP : DEFAULT_HELP;
}

/** `help` / `--help` / `-h` 走默认帮助；`--help-experimental` 与 `help-experimental` 走冻结命令帮助。 */
export function renderHelpForCommand(cmd: string): string | undefined {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return renderHelp("default");
  if (cmd === "--help-experimental" || cmd === "help-experimental") return renderHelp("experimental");
  return undefined;
}
