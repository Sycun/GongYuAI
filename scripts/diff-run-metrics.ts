/**
 * First-hour (or full-run) differential for two task directories.
 *
 * Compares the same counters on a baseline run and a candidate run so a
 * regression shows up before another 6h board clear. `--window-minutes 60`
 * keeps only events inside the first N minutes after each run's own start.
 *
 * Usage:
 *   pnpm tsx scripts/diff-run-metrics.ts <baselineTaskDir> <candidateTaskDir> --window-minutes 60
 *   pnpm tsx scripts/diff-run-metrics.ts --baseline <dir> --candidate <dir> --window-minutes 60
 *
 * Reads, when present:
 *   history is not required; submit receipts come from evidence JSON and progress text
 *   execution-trace.sqlite, traffic/index.sqlite
 *   workspace/PROGRESS.md, workspace/progress.log, worker.log
 *   workspace/relay/πN.json, evidence/goals, evidence/engagement
 *   durable.sqlite entries of kind pi.compaction
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type EvidenceLanding = {
  files: number;
  bytes: number;
  /** Key deliverable, e.g. goals/autonomous-progress.md. */
  keyPath: string;
  keyBytes: number;
  status: "missing" | "landed" | "after-window";
};

export type RunMetrics = {
  label: string;
  taskDir: string;
  windowMinutes: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  activityAfterWindow: boolean;
  solved: number;
  submitCorrect: number;
  solvedCodes: string[];
  totalTokens: number;
  steps: number;
  avgTokensPerStep: number | null;
  avgTokensPerSolve: number | null;
  rounds: number;
  toolCalls: number;
  avgToolCallsPerRound: number | null;
  evidenceStallForces: number;
  compactions: number;
  compactionsInDb: number;
  relayFiles: number;
  trafficBytes: number;
  trafficWalBytes: number;
  trafficRows: number;
  goals: EvidenceLanding;
  engagement: EvidenceLanding;
  notes: string[];
};

type Stamp = number | null;

type ProgressLine = { at: Stamp; text: string };

type TraceStep = {
  at: number;
  slot: number;
  tokens: number;
  toolCalls: number;
};

const KEY_LEDGER = "goals/autonomous-progress.md";
const KEY_REPORT = "engagement/report.md";

function parseStamp(line: string): Stamp {
  const head = line.trim();
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/.exec(head);
  if (iso?.[1]) {
    const t = Date.parse(iso[1]);
    return Number.isFinite(t) ? t : null;
  }
  const bj = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(head);
  if (!bj?.[1] || !bj[2]) return null;
  const t = Date.parse(`${bj[1]}T${bj[2]}+08:00`);
  return Number.isFinite(t) ? t : null;
}

function inWindow(at: Stamp, start: Stamp, end: Stamp): boolean {
  if (end == null) return true;
  if (at == null) return false;
  if (start != null && at < start) return false;
  return at <= end;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function loadProgress(taskDir: string): ProgressLine[] {
  const files = [
    join(taskDir, "workspace", "PROGRESS.md"),
    join(taskDir, "workspace", "progress.log"),
    join(taskDir, "progress.log"),
    join(taskDir, "worker.log"),
  ];
  const seen = new Set<string>();
  const out: ProgressLine[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readText(file).split(/\n/)) {
      const text = raw.replace(/^\[progress\]\s*/, "").replace(/^[-*]\s+/, "").trim();
      if (!text || text.startsWith("#")) continue;
      const at = parseStamp(text);
      const key = `${at ?? "na"}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ at, text });
    }
  }
  return out;
}

function openReadonly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 500");
    return db;
  } catch {
    return null;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as { n: number } | undefined;
  return Boolean(row);
}

function loadSteps(taskDir: string): TraceStep[] {
  const db = openReadonly(join(taskDir, "execution-trace.sqlite"));
  if (!db) return [];
  try {
    if (!tableExists(db, "steps")) return [];
    const rows = db.prepare("SELECT summary FROM steps").all() as Array<{ summary: string }>;
    const steps: TraceStep[] = [];
    for (const row of rows) {
      try {
        const summary = JSON.parse(row.summary) as {
          at?: string;
          tokens?: number;
          workerSlot?: number;
          tools?: string[];
          shellCallCount?: number;
        };
        const at = summary.at ? Date.parse(summary.at) : NaN;
        if (!Number.isFinite(at)) continue;
        const tools = Array.isArray(summary.tools) ? summary.tools : [];
        const shells = tools.includes("shell")
          ? Math.max(Number(summary.shellCallCount ?? 0), 1)
          : Number(summary.shellCallCount ?? 0);
        const others = tools.filter((name) => name !== "shell").length;
        steps.push({
          at,
          slot: Number(summary.workerSlot ?? 0),
          tokens: Number(summary.tokens ?? 0),
          toolCalls: shells + others,
        });
      } catch {
        /* skip a corrupt step */
      }
    }
    return steps;
  } finally {
    db.close();
  }
}

function tokenTotal(steps: TraceStep[]): number {
  const bySlot = new Map<number, TraceStep[]>();
  for (const step of steps) {
    const list = bySlot.get(step.slot) ?? [];
    list.push(step);
    bySlot.set(step.slot, list);
  }
  let total = 0;
  for (const list of bySlot.values()) {
    list.sort((a, b) => a.at - b.at);
    let prev = 0;
    for (const step of list) {
      total += step.tokens >= prev ? step.tokens - prev : step.tokens;
      prev = step.tokens;
    }
  }
  return total;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out;
}

type Receipt = { code: string | null; at: Stamp; receipt: boolean };

function pushSolved(into: Receipt[], code: string | null, at: Stamp, receipt: boolean) {
  into.push({ code, at, receipt });
}

function consumeJson(value: unknown, at: Stamp, into: Receipt[]): void {
  if (Array.isArray(value)) {
    for (const item of value) consumeJson(item, at, into);
    return;
  }
  if (!value || typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  const nestedAt = typeof rec.submittedAt === "string" ? Date.parse(rec.submittedAt) : at;
  const when = Number.isFinite(nestedAt) ? nestedAt : at;
  const code = typeof rec.unique_code === "string"
    ? rec.unique_code
    : typeof rec.code === "string"
      ? rec.code
      : null;
  let correct = rec.correct === true;
  const response = rec.response;
  if (typeof response === "string") {
    if (/"correct"\s*:\s*true\b/.test(response)) correct = true;
    try {
      const inner = JSON.parse(response) as { correct?: unknown };
      if (inner.correct === true) correct = true;
    } catch {
      /* response is not JSON */
    }
  } else if (response && typeof response === "object" && (response as { correct?: unknown }).correct === true) {
    correct = true;
  }
  if (correct) pushSolved(into, code, when, true);
  else if (rec.is_completed === true && code) pushSolved(into, code, when, false);
}

function loadReceipts(taskDir: string, progress: ProgressLine[]): Receipt[] {
  const found: Receipt[] = [];
  const evidence = join(taskDir, "evidence");
  for (const file of listFiles(evidence)) {
    if (!file.endsWith(".json")) continue;
    const base = file.slice(evidence.length + 1);
    if (!/submit|ALL_COMPLETE|all_complete/i.test(base)) continue;
    try {
      consumeJson(JSON.parse(readText(file)), null, found);
    } catch {
      const text = readText(file);
      if (/"correct"\s*:\s*true\b/.test(text)) {
        const code = /"unique_code"\s*:\s*"([^"]+)"/.exec(text)?.[1]
          ?? /"code"\s*:\s*"([^"]+)"/.exec(text)?.[1]
          ?? null;
        pushSolved(found, code, null, true);
      }
    }
  }
  for (const line of progress) {
    if (!/"correct"\s*:\s*true\b/.test(line.text)) continue;
    const code = /"unique_code"\s*:\s*"([^"]+)"/.exec(line.text)?.[1]
      ?? /"code"\s*:\s*"([^"]+)"/.exec(line.text)?.[1]
      ?? null;
    pushSolved(found, code, line.at, true);
  }
  return found;
}

function relayTimes(taskDir: string): number[] {
  const dir = join(taskDir, "workspace", "relay");
  if (!existsSync(dir)) return [];
  const times: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^π\d+\.json$/u.test(name) && !/^pi\d+\.json$/i.test(name)) continue;
    const path = join(dir, name);
    let at = statSync(path).mtimeMs;
    try {
      const parsed = JSON.parse(readText(path)) as { createdAt?: string };
      if (parsed.createdAt) {
        const t = Date.parse(parsed.createdAt);
        if (Number.isFinite(t)) at = t;
      }
    } catch {
      /* keep mtime */
    }
    times.push(at);
  }
  return times;
}

function countCompactions(taskDir: string): number {
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(taskDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^durable(-w\d+)?\.sqlite$/.test(name)) continue;
    const db = openReadonly(join(taskDir, name));
    if (!db) continue;
    try {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%entries'",
      ).all() as Array<{ name: string }>;
      for (const table of tables) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) continue;
        try {
          const row = db.prepare(
            `SELECT count(*) AS n FROM ${table.name} WHERE json_extract(record, '$.kind') = 'pi.compaction'`,
          ).get() as { n: number };
          total += Number(row.n ?? 0);
        } catch {
          /* table has no JSON record column */
        }
      }
    } finally {
      db.close();
    }
  }
  return total;
}

function trafficStats(taskDir: string, start: Stamp, end: Stamp): {
  bytes: number;
  walBytes: number;
  rows: number;
} {
  const path = join(taskDir, "traffic", "index.sqlite");
  if (!existsSync(path)) return { bytes: 0, walBytes: 0, rows: 0 };
  const bytes = statSync(path).size;
  const walPath = `${path}-wal`;
  const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
  const db = openReadonly(path);
  if (!db) return { bytes, walBytes, rows: 0 };
  try {
    if (!tableExists(db, "exchanges")) return { bytes, walBytes, rows: 0 };
    if (end == null || start == null) {
      const row = db.prepare("SELECT count(*) AS n FROM exchanges").get() as { n: number };
      return { bytes, walBytes, rows: Number(row.n) };
    }
    const row = db.prepare(
      "SELECT count(*) AS n FROM exchanges WHERE started_at >= ? AND started_at <= ?",
    ).get(new Date(start).toISOString(), new Date(end).toISOString()) as { n: number };
    return { bytes, walBytes, rows: Number(row.n) };
  } finally {
    db.close();
  }
}

function earliestTraffic(taskDir: string): Stamp {
  const db = openReadonly(join(taskDir, "traffic", "index.sqlite"));
  if (!db) return null;
  try {
    if (!tableExists(db, "exchanges")) return null;
    const row = db.prepare("SELECT min(started_at) AS t FROM exchanges").get() as { t?: string };
    if (!row.t) return null;
    const t = Date.parse(row.t);
    return Number.isFinite(t) ? t : null;
  } finally {
    db.close();
  }
}

function landing(taskDir: string, keyPath: string, end: Stamp): EvidenceLanding {
  const abs = join(taskDir, "evidence", keyPath);
  const dir = join(taskDir, "evidence", dirname(keyPath));
  const files = listFiles(dir).filter((file) => {
    const rel = file.slice(join(taskDir, "evidence").length + 1);
    return rel === keyPath || rel.startsWith(`${dirname(keyPath)}/`);
  });
  let bytes = 0;
  let counted = 0;
  for (const file of files) {
    try {
      const st = statSync(file);
      if (end != null && st.mtimeMs > end) continue;
      bytes += st.size;
      counted += 1;
    } catch {
      /* skip */
    }
  }
  if (!existsSync(abs)) {
    return { files: counted, bytes, keyPath, keyBytes: 0, status: "missing" };
  }
  try {
    const st = statSync(abs);
    if (st.size <= 0) {
      return { files: counted, bytes, keyPath, keyBytes: 0, status: "missing" };
    }
    if (end != null && st.mtimeMs > end) {
      return { files: counted, bytes, keyPath, keyBytes: st.size, status: "after-window" };
    }
    return { files: Math.max(counted, 1), bytes: bytes || st.size, keyPath, keyBytes: st.size, status: "landed" };
  } catch {
    return { files: counted, bytes, keyPath, keyBytes: 0, status: "missing" };
  }
}

function landingCell(item: EvidenceLanding): string {
  if (item.status === "missing") return `未落盘（${item.keyPath}）`;
  if (item.status === "after-window") return `窗口后才有写入（${item.keyPath} ${item.keyBytes}B）`;
  return `已落盘（${item.keyPath} ${item.keyBytes}B / 目录 ${item.files} 文件）`;
}

export function collectRunMetrics(
  taskDir: string,
  opts: { windowMinutes?: number | null; label?: string } = {},
): RunMetrics {
  const root = resolve(taskDir);
  const label = opts.label ?? root;
  const windowMinutes = opts.windowMinutes && opts.windowMinutes > 0 ? opts.windowMinutes : null;
  const notes: string[] = [];
  const progress = loadProgress(root);
  const steps = loadSteps(root);
  const relays = relayTimes(root);
  const receipts = loadReceipts(root, progress);
  const trafficStart = earliestTraffic(root);
  const stamps = [
    ...progress.map((line) => line.at),
    ...steps.map((step) => step.at),
    ...relays,
    ...receipts.map((item) => item.at),
    trafficStart,
  ].filter((at): at is number => at != null);
  const windowStart = stamps.length ? Math.min(...stamps) : null;
  const windowEnd = windowMinutes != null && windowStart != null
    ? windowStart + windowMinutes * 60_000
    : null;
  const activityAfterWindow = windowEnd != null && stamps.some((at) => at > windowEnd);

  const keptSteps = steps.filter((step) => inWindow(step.at, windowStart, windowEnd));
  const totalTokens = tokenTotal(keptSteps);
  const toolCalls = keptSteps.reduce((sum, step) => sum + step.toolCalls, 0);
  const roundMarks = progress
    .filter((line) => inWindow(line.at, windowStart, windowEnd))
    .map((line) => /续跑 #(\d+)/.exec(line.text))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]));
  const sawWork = keptSteps.length > 0
    || progress.some((line) => inWindow(line.at, windowStart, windowEnd));
  const rounds = roundMarks.length ? Math.max(...roundMarks) : (sawWork ? 1 : 0);

  const seenReceipts = new Set<string>();
  const solved = new Set<string>();
  let submitCorrect = 0;
  for (const item of receipts) {
    if (!inWindow(item.at, windowStart, windowEnd)) continue;
    if (item.code) solved.add(item.code);
    if (!item.receipt) continue;
    const key = `${item.code ?? "?"}|${item.at == null ? "na" : Math.floor(item.at / 60_000)}`;
    if (seenReceipts.has(key)) continue;
    seenReceipts.add(key);
    submitCorrect += 1;
  }

  const evidenceStallForces = progress.filter((line) =>
    inWindow(line.at, windowStart, windowEnd) && /evidence_stall force-conclude/.test(line.text),
  ).length;
  const loggedCompactions = progress.filter((line) =>
    inWindow(line.at, windowStart, windowEnd) && /\bcompaction\b/i.test(line.text),
  ).length;
  const compactionsInDb = countCompactions(root);
  let compactions = compactionsInDb;
  if (windowEnd != null && activityAfterWindow) {
    compactions = loggedCompactions;
    notes.push(
      `原生 compaction：运行超出窗口，且 pi.compaction 条目没有墙钟。窗口内进度日志 ${loggedCompactions} 次；durable 全量 ${compactionsInDb} 次未计入本列。`,
    );
  } else if (compactionsInDb === 0 && loggedCompactions > 0) {
    compactions = loggedCompactions;
  }

  const traffic = trafficStats(root, windowStart, windowEnd);
  if (traffic.walBytes > 0) {
    notes.push(`traffic/index.sqlite-wal 另有 ${traffic.walBytes} 字节（未计入主文件体积）。`);
  }
  if (windowEnd != null) {
    notes.push("traffic 体积是当前 index.sqlite 文件大小，不会按窗口回放缩小；记录数已按 started_at 过滤。");
  }
  notes.push("工具调用按 execution-trace：每步 shell 逐次计，其他工具名在步内去重。Token 按各 worker slot 的累计值做正向差分。");
  notes.push("续跑轮数取进度里「续跑 #N」的最大 N；没有续跑标记但已有活动时记为 1。");
  notes.push("解题数是 correct:true 或 is_completed 的不重复代码；submit 回执按代码与分钟去重。");
  notes.push("进度文本读取 workspace/PROGRESS.md、workspace/progress.log 与 worker.log，相同时间戳行只计一次。");

  const solvedCount = solved.size;
  return {
    label,
    taskDir: root,
    windowMinutes,
    windowStart: windowStart == null ? null : new Date(windowStart).toISOString(),
    windowEnd: windowEnd == null ? null : new Date(windowEnd).toISOString(),
    activityAfterWindow,
    solved: solvedCount,
    submitCorrect,
    solvedCodes: [...solved].sort(),
    totalTokens,
    steps: keptSteps.length,
    avgTokensPerStep: keptSteps.length ? totalTokens / keptSteps.length : null,
    avgTokensPerSolve: solvedCount ? totalTokens / solvedCount : null,
    rounds,
    toolCalls,
    avgToolCallsPerRound: rounds ? toolCalls / rounds : null,
    evidenceStallForces,
    compactions,
    compactionsInDb,
    relayFiles: relays.filter((at) => inWindow(at, windowStart, windowEnd)).length,
    trafficBytes: traffic.bytes,
    trafficWalBytes: traffic.walBytes,
    trafficRows: traffic.rows,
    goals: landing(root, KEY_LEDGER, windowEnd),
    engagement: landing(root, KEY_REPORT, windowEnd),
    notes,
  };
}

function n(value: number | null, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (digits === 0) return String(Math.round(value));
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function delta(baseline: number | null, candidate: number | null, digits = 0): string {
  if (baseline == null || candidate == null) return "—";
  const diff = candidate - baseline;
  const body = digits === 0
    ? String(Math.round(diff))
    : (Number.isInteger(diff) ? String(diff) : diff.toFixed(digits));
  const signed = diff > 0 ? `+${body}` : body;
  if (baseline === 0) return signed;
  const pct = (diff / baseline) * 100;
  return `${signed} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

function row(name: string, base: string, cand: string, change: string): string {
  return `| ${name} | ${base} | ${cand} | ${change} |`;
}

export function renderDiffMarkdown(baseline: RunMetrics, candidate: RunMetrics): string {
  const windowLine = baseline.windowMinutes
    ? `窗口：各自起点后 ${baseline.windowMinutes} 分钟（baseline ${baseline.windowStart ?? "未知"} → ${baseline.windowEnd ?? "未知"}；candidate ${candidate.windowStart ?? "未知"} → ${candidate.windowEnd ?? "未知"}）`
    : "窗口：全量运行";
  const lines = [
    "# 跑批差分",
    "",
    windowLine,
    "",
    "| 指标 | baseline | candidate | Δ candidate−baseline |",
    "| --- | ---: | ---: | ---: |",
    row("解题数", n(baseline.solved), n(candidate.solved), delta(baseline.solved, candidate.solved)),
    row("submit correct:true", n(baseline.submitCorrect), n(candidate.submitCorrect), delta(baseline.submitCorrect, candidate.submitCorrect)),
    row("总 token", n(baseline.totalTokens), n(candidate.totalTokens), delta(baseline.totalTokens, candidate.totalTokens)),
    row("平均 token/步", n(baseline.avgTokensPerStep, 1), n(candidate.avgTokensPerStep, 1), delta(baseline.avgTokensPerStep, candidate.avgTokensPerStep, 1)),
    row("平均 token/题", n(baseline.avgTokensPerSolve, 1), n(candidate.avgTokensPerSolve, 1), delta(baseline.avgTokensPerSolve, candidate.avgTokensPerSolve, 1)),
    row("续跑轮数", n(baseline.rounds), n(candidate.rounds), delta(baseline.rounds, candidate.rounds)),
    row("平均工具调用/轮", n(baseline.avgToolCallsPerRound, 1), n(candidate.avgToolCallsPerRound, 1), delta(baseline.avgToolCallsPerRound, candidate.avgToolCallsPerRound, 1)),
    row("evidence_stall 强制换面", n(baseline.evidenceStallForces), n(candidate.evidenceStallForces), delta(baseline.evidenceStallForces, candidate.evidenceStallForces)),
    row("原生 compaction", n(baseline.compactions), n(candidate.compactions), delta(baseline.compactions, candidate.compactions)),
    row("relay π 文件", n(baseline.relayFiles), n(candidate.relayFiles), delta(baseline.relayFiles, candidate.relayFiles)),
    row("traffic/index.sqlite 字节", n(baseline.trafficBytes), n(candidate.trafficBytes), delta(baseline.trafficBytes, candidate.trafficBytes)),
    row("traffic 记录数", n(baseline.trafficRows), n(candidate.trafficRows), delta(baseline.trafficRows, candidate.trafficRows)),
    row("evidence/goals", landingCell(baseline.goals), landingCell(candidate.goals), baseline.goals.status === candidate.goals.status ? "持平" : "变化"),
    row("evidence/engagement", landingCell(baseline.engagement), landingCell(candidate.engagement), baseline.engagement.status === candidate.engagement.status ? "持平" : "变化"),
    "",
    `- baseline: \`${baseline.taskDir}\``,
    `- candidate: \`${candidate.taskDir}\``,
  ];
  if (baseline.solvedCodes.length || candidate.solvedCodes.length) {
    lines.push(`- 解题代码 baseline: ${baseline.solvedCodes.join(", ") || "—"}`);
    lines.push(`- 解题代码 candidate: ${candidate.solvedCodes.join(", ") || "—"}`);
  }
  const notes = [...baseline.notes, ...candidate.notes.filter((note) => !baseline.notes.includes(note))];
  if (notes.length) {
    lines.push("", "## 口径");
    for (const note of notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): { baseline: string; candidate: string; windowMinutes: number | null } {
  const positional: string[] = [];
  let windowMinutes: number | null = null;
  let baseline: string | undefined;
  let candidate: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg == null) continue;
    if (arg === "--window-minutes") {
      const raw = argv[i + 1];
      i += 1;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error("--window-minutes 必须是 >= 0 的数字");
      windowMinutes = n === 0 ? null : n;
      continue;
    }
    if (arg === "--baseline") {
      baseline = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--candidate") {
      candidate = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") throw new Error("help");
    if (arg.startsWith("--")) throw new Error(`未知参数 ${arg}`);
    positional.push(arg);
  }
  const left = baseline ?? positional[0];
  const right = candidate ?? positional[1];
  if (!left || !right) throw new Error("help");
  return { baseline: resolve(left), candidate: resolve(right), windowMinutes };
}

const USAGE = `用法:
  pnpm tsx scripts/diff-run-metrics.ts <baselineTaskDir> <candidateTaskDir> [--window-minutes 60]
  pnpm tsx scripts/diff-run-metrics.ts --baseline <dir> --candidate <dir> --window-minutes 60`;

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const baseline = collectRunMetrics(args.baseline, { windowMinutes: args.windowMinutes, label: "baseline" });
    const candidate = collectRunMetrics(args.candidate, { windowMinutes: args.windowMinutes, label: "candidate" });
    process.stdout.write(renderDiffMarkdown(baseline, candidate));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "help") {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${message}\n${USAGE}\n`);
      process.exitCode = 1;
    }
  }
}
