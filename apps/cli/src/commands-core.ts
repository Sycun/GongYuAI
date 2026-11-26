/**
 * 核心作战命令：serve / run / status / pause / resume / stop / scope / hint / logs / report / archive，
 * 以及主航道上的交接、作业、求助、材料、覆盖视图、变更回滚与图谱。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUDGET_UNLIMITED,
  CreateTaskRequestSchema,
  DEFAULT_MAX_CONCURRENT_EXPLORES,
  UpdateScopeRequestSchema,
  isTerminalTaskStatus,
} from "@gongyuai/contracts";
import { bootControlPlane, resolveCanonicalDataRoot, resolveInstallRoot } from "@gongyuai/control-plane";
import { flag, flags, has, type GlobalOpts } from "./args.js";
import { api, ensureServer, splitCsv, withServer } from "./client.js";

type Handler = (rest: string[], opts: GlobalOpts) => Promise<void>;

async function serve(rest: string[], opts: GlobalOpts): Promise<void> {
  const plane = await bootControlPlane({
    dataRoot: opts.dataDir || undefined,
    host: opts.host,
    port: opts.port,
    // 隔离模式（恢复演练）：不导入旧任务、不起 watchdog、不自动续跑。
    isolated: has(rest, "--isolated") || process.env.GY_ISOLATED === "1",
  });
  for (const rehome of plane.rehomed) {
    console.log(`[gy] 数据目录归属：${rehome.taskId} ${rehome.from || "(空)"} → ${rehome.to}`);
  }
  console.log(`GongYuAI control plane listening on ${plane.url}`);
  await new Promise(() => undefined);
}

async function run(rest: string[], opts: GlobalOpts): Promise<void> {
  const goalsPath = flag(rest, "--goals");
  const targets = flags(rest, "--target");
  const auth = flag(rest, "--auth");
  const name = flag(rest, "--name") ?? "mvp-run";
  const mock = has(rest, "--mock");
  const wait = has(rest, "--wait");
  const concurrency = Number(flag(rest, "--concurrency") ?? DEFAULT_MAX_CONCURRENT_EXPLORES);
  const capability = (flag(rest, "--capability") ?? "active-lab") as
    | "observe"
    | "scan"
    | "active-lab"
    | "full";
  if (!goalsPath || !targets.length) {
    throw new Error("gy run requires --goals --target");
  }
  const goals = JSON.parse(readFileSync(resolve(goalsPath), "utf8"));
  const body = CreateTaskRequestSchema.parse({
    tenantId: "default",
    name,
    mock,
    auth: {
      authorizationNote: auth ?? "",
      targets,
      outOfScope: [],
      capability,
    },
    goals,
    execution: {
      maxConcurrentExplores: concurrency,
    },
    budget: {
      maxTokens: Number(flag(rest, "--max-tokens") ?? BUDGET_UNLIMITED),
      maxWallMs: Number(flag(rest, "--max-wall-ms") ?? BUDGET_UNLIMITED),
      maxToolCalls: Number(flag(rest, "--max-tool-calls") ?? BUDGET_UNLIMITED),
      maxInstalls: Number(flag(rest, "--max-installs") ?? BUDGET_UNLIMITED),
      relayTokenThreshold: Number(
        flag(rest, "--relay-token-threshold") ?? process.env.GY_RELAY_TOKEN_THRESHOLD ?? 30_000,
      ),
      relayMinToolCalls: Number(
        flag(rest, "--relay-min-tool-calls") ?? process.env.GY_RELAY_MIN_TOOL_CALLS ?? 2,
      ),
    },
  });

  const owned = await ensureServer(opts);
  const created = await api(opts, "POST", "/tasks", body);
  if (created.status >= 400) {
    throw new Error(created.text);
  }
  const task = (created.json as { task: { id: string; status: string } }).task;
  console.log(JSON.stringify(task, null, 2));

  if (wait) {
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await api(opts, "GET", `/tasks/${task.id}`);
        const current = (st.json as { task: { id: string; status: string } }).task;
        process.stderr.write(`\r[gy] status=${current.status}   `);
        if (isTerminalTaskStatus(current.status)) {
          console.log();
          console.log(JSON.stringify(current, null, 2));
          break;
        }
      }
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (owned.close) {
    console.error(
      "[gy] embedded control plane stays up for this process; prefer `gy serve` for long-lived use",
    );
  }
}

async function status(rest: string[], opts: GlobalOpts): Promise<void> {
  await withServer(opts, async () => {
    const id = rest[0];
    if (!id) {
      const all = await api(opts, "GET", "/tasks");
      console.log(all.text);
      return;
    }
    const one = await api(opts, "GET", `/tasks/${id}`);
    console.log(one.text);
  });
}

async function hint(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const text = rest.slice(1).join(" ").trim();
  if (!id || !text) throw new Error('gy hint <taskId> "<text>"');
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/hints`, { text, source: "human" });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function logs(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy logs <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/logs`);
    process.stdout.write(response.text);
  });
}

async function report(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy report <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/report`);
    process.stdout.write(response.text);
  });
}

async function pauseOrResume(cmd: "pause" | "resume", rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error(`gy ${cmd} <taskId>`);
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/${cmd}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function scope(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const path = flag(rest, "--file");
  if (!id || !path) throw new Error("gy scope <taskId> --file SCOPE.json");
  const body = UpdateScopeRequestSchema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/scope`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function stop(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy stop <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/stop`);
    console.log(response.text);
  });
}

async function archiveOrUnarchive(cmd: "archive" | "unarchive", rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error(`gy ${cmd} <taskId>`);
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/${cmd}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function handoff(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy handoff <taskId>");
  const qs = new URLSearchParams();
  const nextOwner = flag(rest, "--next-owner");
  const now = flag(rest, "--now");
  if (nextOwner) qs.set("nextOwner", nextOwner);
  if (now) qs.set("now", now);
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/handoff?${qs.toString()}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function jobs(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy jobs <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/jobs${has(rest, "--receipts") ? "?receipts=1" : ""}`);
    console.log(response.text);
  });
}

async function jobSubmit(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const kind = flag(rest, "--kind");
  const label = flag(rest, "--label") ?? "job";
  const inputs = splitCsv(flag(rest, "--input"));
  if (!id || !kind || inputs.length === 0) {
    throw new Error("gy job-submit <taskId> --kind K --label L --input PATH[,PATH]");
  }
  const sha = flag(rest, "--sha");
  const options = flag(rest, "--options");
  const asset = flag(rest, "--asset");
  const body = {
    kind,
    label,
    ...(asset ? { asset } : {}),
    submittedBy: flag(rest, "--by") ?? "operator",
    inputs: inputs.map((path) => ({ path, sha256: sha ?? null })),
    options: options ? JSON.parse(options) : {},
  };
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/jobs`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function jobOrRetry(cmd: "job" | "job-retry", rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const jobId = rest[1];
  if (!id || !jobId) throw new Error(`gy ${cmd} <taskId> <jobId>`);
  await withServer(opts, async () => {
    const response = cmd === "job"
      ? await api(opts, "GET", `/tasks/${id}/jobs/${jobId}`)
      : await api(opts, "POST", `/tasks/${id}/jobs/${jobId}/retry`, {});
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function jobAck(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const jobId = rest[1];
  const key = flag(rest, "--key");
  if (!id || !jobId || !key) throw new Error("gy job-ack <taskId> <jobId> --key K");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/jobs/${jobId}/receipt`, {
      deliveryKey: key,
      deliveredBy: flag(rest, "--by") ?? "operator",
      note: flag(rest, "--note") ?? "",
    });
    console.log(response.text);
  });
}

async function consults(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy consults <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/consults`);
    console.log(response.text);
  });
}

async function consult(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const question = flag(rest, "--question");
  if (!id || !question) throw new Error("gy consult <taskId> --question TEXT");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/consults`, {
      question,
      options: splitCsv(flag(rest, "--options")),
      context: flag(rest, "--context") ?? "",
      blocking: (flag(rest, "--blocking") ?? "true") !== "false",
      askedBy: flag(rest, "--by") ?? "agent",
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function answer(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const consultId = rest[1];
  const text = flag(rest, "--answer") ?? rest[2];
  if (!id || !consultId || !text) throw new Error('gy answer <taskId> <consultId> "答复" --by NAME');
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/consults/${consultId}/answer`, {
      answer: text,
      answeredBy: flag(rest, "--by") ?? "operator",
      injectHint: true,
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function consultSweep(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy consult-sweep <taskId> [--now ISO]");
  const now = flag(rest, "--now");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/consults/sweep`, {
      ...(now ? { now } : {}),
    });
    console.log(response.text);
  });
}

async function material(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const path = flag(rest, "--path");
  const file = flag(rest, "--file");
  const asset = flag(rest, "--asset");
  if (!id || !path || !file || !asset) throw new Error("gy material <taskId> --path P --file LOCAL --asset A");
  const content = readFileSync(resolve(file), "utf8");
  const kind = flag(rest, "--kind");
  const observedAt = flag(rest, "--observed-at");
  const secretRef = flag(rest, "--secret-ref");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/materials`, {
      path,
      content,
      asset,
      ...(kind ? { kind } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(secretRef ? { secretRef } : {}),
      source: flag(rest, "--source") ?? "operator-import",
      locator: flag(rest, "--locator") ?? "",
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function materials(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy materials <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/materials`);
    console.log(response.text);
  });
}

async function matrixOrFreshness(cmd: "matrix" | "freshness", rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error(`gy ${cmd} <taskId>`);
  const endpoint = cmd === "matrix" ? "coverage-matrix" : "freshness";
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/${endpoint}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function changes(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy changes <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/changes`);
    console.log(response.text);
  });
}

async function change(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const kind = flag(rest, "--kind");
  const asset = flag(rest, "--asset");
  const location = flag(rest, "--location");
  const rollbackCmd = flag(rest, "--rollback");
  if (!id || !kind || !asset || !location || !rollbackCmd) {
    throw new Error("gy change <taskId> --kind K --asset A --location L --rollback CMD");
  }
  const before = flag(rest, "--before");
  const body = {
    kind,
    asset,
    location,
    rollbackCmd,
    registeredBy: flag(rest, "--by") ?? "operator",
    note: flag(rest, "--note") ?? "",
    ...(before
      ? { beforeMaterial: { path: `changes/${Date.now()}-before.txt`, content: readFileSync(resolve(before), "utf8") } }
      : {}),
  };
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/changes`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function rollback(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const out = flag(rest, "--out");
  if (!id) throw new Error("gy rollback <taskId> [--out FILE]");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/rollback`);
    if (response.status >= 400) throw new Error(response.text);
    if (out) {
      writeFileSync(resolve(out), response.text);
      console.log(`rollback script written: ${resolve(out)}`);
    } else {
      console.log(response.text);
    }
  });
}

async function graphOrCausality(cmd: "graph" | "causality", rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const target = rest[1];
  if (!id || !target) {
    throw new Error(`gy ${cmd} <taskId> ${cmd === "graph" ? "assets|surface|execution|memory" : "<findingId>"}`);
  }
  await withServer(opts, async () => {
    const path = cmd === "graph" ? `/tasks/${id}/graphs/${target}` : `/tasks/${id}/causality/${target}`;
    const response = await api(opts, "GET", path);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function today(_rest: string[], opts: GlobalOpts): Promise<void> {
  await withServer(opts, async () => {
    const response = await api(opts, "GET", "/today");
    console.log(response.text);
  });
}

async function inspect(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const dataRoot = resolveCanonicalDataRoot({
    installRoot: resolveInstallRoot(),
    explicit: opts.dataDir || undefined,
    envValue: process.env.GY_DATA_DIR,
  });
  const path = resolve(dataRoot, "tasks", id ?? "", "worker-status.json");
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  console.log(readFileSync(path, "utf8"));
}

const handlers: Record<string, Handler> = {
  serve,
  run,
  status,
  hint,
  logs,
  report,
  pause: (rest, opts) => pauseOrResume("pause", rest, opts),
  resume: (rest, opts) => pauseOrResume("resume", rest, opts),
  scope,
  stop,
  archive: (rest, opts) => archiveOrUnarchive("archive", rest, opts),
  unarchive: (rest, opts) => archiveOrUnarchive("unarchive", rest, opts),
  handoff,
  jobs,
  "job-submit": jobSubmit,
  job: (rest, opts) => jobOrRetry("job", rest, opts),
  "job-retry": (rest, opts) => jobOrRetry("job-retry", rest, opts),
  "job-ack": jobAck,
  consults,
  consult,
  answer,
  "consult-sweep": consultSweep,
  material,
  materials,
  matrix: (rest, opts) => matrixOrFreshness("matrix", rest, opts),
  freshness: (rest, opts) => matrixOrFreshness("freshness", rest, opts),
  changes,
  change,
  rollback,
  graph: (rest, opts) => graphOrCausality("graph", rest, opts),
  causality: (rest, opts) => graphOrCausality("causality", rest, opts),
  today,
  inspect,
};

export function coreCommandNames(): string[] {
  return Object.keys(handlers);
}

export async function handleCoreCommand(cmd: string, rest: string[], opts: GlobalOpts): Promise<boolean> {
  const handler = handlers[cmd];
  if (!handler) return false;
  await handler(rest, opts);
  return true;
}
