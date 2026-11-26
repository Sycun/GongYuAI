/**
 * 活跃红队任务作战路由（Active Task Operations Routes）。
 *
 * 仅承载围绕单兵红队工作台与 `Fact–Intent–Goal` DAG 真相核的实战运行接口：
 * - 今日工作面（`/today`）
 * - 驻留会话（`http-sessions`）、持久作业（`jobs`）、人工求助与交接（`consults` / `handoff`）
 * - 证据材料与覆盖矩阵（`materials` / `coverage-cells` / `coverage-matrix` / `freshness`）
 * - 靶标变更与回滚脚本（`changes` / `rollback`）、只读历史接触（`asset-history`）
 * - 事件哈希链（`chain`）、命令熔断重置（`command-reset`）、审计与独立复核（`audit` / `validations`）
 * - 战场态势投影（`p14`）、图谱与因果链（`graphs` / `causality`）、空转告警（`alerts`）
 *
 * 冻结的 P8/P9 支线（全局记忆、提案飞轮、基准评测、趋势）及模拟推演接口（`roles` / `provider` / `model-request`）
 * 已解耦至 `./routes-frozen.ts`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AckJobSchema,
  AnswerConsultSchema,
  BoundaryError,
  CONSULT_BLOCKING_TTL_MS,
  CreateConsultSchema,
  ImportMaterialSchema,
  ManualCoverageSchema,
  SubmitJobSchema,
  classifyMaterial,
  deriveCoverageMatrix,
  findAttackPaths,
  freshnessOf,
  noProgressAlarm,
  rollbackScript,
  visibilityDenial,
  type EvidenceImport,
  type GraphView,
  type TaskRecord,
} from "@gongyuai/contracts";
import {
  listExecutionSteps,
  openHistory,
  readEvidenceBytes,
  writeEvidenceFile,
  type HistoryStore,
} from "@gongyuai/history";
import type { ControlStore } from "./store.js";
import type { JobRunner } from "./jobs.js";
import type { WorkerRunner } from "./runner.js";
import type { PlatformStore } from "./platform.js";
import { assembleHandoff, sweepTaskConsults, todayWork } from "./handoff.js";
import { assetHistory } from "./asset-history.js";
import { TunnelManager, deleteHttpSession, listHttpSessionSummaries, upsertHttpSession } from "@gongyuai/exec";
import {
  buildAssetGraph,
  buildExecutionGraph,
  buildSurfaceGraph,
  causalityTrace,
} from "./graphs.js";
import { taskPaths } from "./paths.js";
import { areFrozenRoutesEnabled, handleFrozenRoute, handleFrozenTaskRoute } from "./routes-frozen.js";

export type OpsRouteDeps = {
  store: ControlStore;
  jobs: JobRunner;
  platform: PlatformStore;
  runner: WorkerRunner;
};

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function nowIso(url: URL, fallback = Date.now()): string {
  const raw = url.searchParams.get("now");
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallback).toISOString();
}

/**
 * 单兵工作台委托边界检查：
 * - 默认无显式 `tenantId` / `engagementId` 时直接放行（任务 ID 即唯一寻址）；
 * - 仅在调用方显式传入租户或委托标识时校验一致性，保持既有隔离契约兼容。
 */
export function checkSingleUserBoundary(task: TaskRecord, url: URL, req: IncomingMessage) {
  const headerEngagement = req.headers["x-engagement-id"];
  const headerTenant = req.headers["x-tenant-id"];
  const tenant = url.searchParams.get("tenantId") ?? (typeof headerTenant === "string" ? headerTenant : undefined);
  const engagement =
    url.searchParams.get("engagementId") ?? (typeof headerEngagement === "string" ? headerEngagement : undefined);
  if (tenant === undefined && engagement === undefined) return null;
  return visibilityDenial(
    {
      tenantId: tenant ?? task.tenantId,
      ...(engagement ? { engagementId: engagement } : {}),
      role: "operator",
    },
    task,
  );
}

export function openTaskHistory(task: TaskRecord, readOnly = false): HistoryStore {
  const paths = taskPaths(task.dataDir);
  return openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly });
}

export async function handleOpsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: OpsRouteDeps,
): Promise<boolean> {
  const { store, jobs } = deps;
  const path = url.pathname;

  /* ------------------------------- 今日工作 ------------------------------- */
  if (method === "GET" && path === "/today") {
    const tenantId = url.searchParams.get("tenantId") ?? "default";
    const engagementId = url.searchParams.get("engagementId") ?? undefined;
    const visible = store.list().filter(
      (task) => (task.tenantId ?? "default") === tenantId && (!engagementId || task.engagementId === engagementId),
    );
    const work = todayWork({
      tasks: visible,
      generatedAt: new Date().toISOString(),
      nowMs: Date.parse(nowIso(url)),
      open: (task) => openTaskHistory(task, true),
    });
    return sendJson(res, 200, work), true;
  }

  /* ---------------------------- 活跃任务级路由 ---------------------------- */
  const taskMatch = path.match(
    /^\/tasks\/([^/]+)\/(handoff|consults|jobs|materials|coverage-matrix|coverage-cells|freshness|changes|rollback|graphs|causality|alerts|p14|asset-history|audit|validations|command-reset|chain|http-sessions)(\/.*)?$/,
  );
  if (!taskMatch) return handleFrozenRoute(req, res, method, url, deps);

  const taskId = decodeURIComponent(taskMatch[1]!);
  const group = taskMatch[2]!;
  const rest = taskMatch[3] ?? "";
  const task = store.get(taskId);
  if (!task) {
    sendJson(res, 404, { error: "task-not-found" });
    return true;
  }
  const denial = checkSingleUserBoundary(task, url, req);
  if (denial) {
    sendJson(res, 403, { error: denial.code, message: denial.message });
    return true;
  }
  const now = nowIso(url);

  try {
    if (group === "http-sessions") {
      if (method === "GET" && rest === "") {
        return sendJson(res, 200, { sessions: listHttpSessionSummaries(task.dataDir) }), true;
      }
      if (method === "POST" && rest === "") {
        const body = (await readJson(req)) as {
          name?: unknown;
          host?: unknown;
          cookies?: unknown;
          headers?: unknown;
          cookie?: unknown;
        };
        const record = (value: unknown): Record<string, unknown> | undefined =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
        const saved = upsertHttpSession(task.dataDir, {
          name: typeof body.name === "string" ? body.name : "",
          host: typeof body.host === "string" ? body.host : "",
          ...(record(body.cookies) ? { cookies: record(body.cookies) } : {}),
          ...(record(body.headers) ? { headers: record(body.headers) } : {}),
          ...(typeof body.cookie === "string" ? { cookie: body.cookie } : {}),
        });
        return sendJson(res, 200, {
          ok: true,
          session: {
            name: saved.name,
            host: saved.host,
            cookieKeys: Object.keys(saved.cookies).sort(),
            headerKeys: Object.keys(saved.headers).sort(),
          },
        }), true;
      }
      const removed = method === "DELETE" ? /^\/([^/]+)$/.exec(rest) : null;
      if (removed) {
        const name = decodeURIComponent(removed[1]!);
        if (!deleteHttpSession(task.dataDir, name)) {
          return sendJson(res, 404, { error: "session not found" }), true;
        }
        return sendJson(res, 200, { ok: true, name }), true;
      }
      return sendJson(res, 404, { error: "not found" }), true;
    }

    if (group === "handoff" && method === "GET") {
      const history = openTaskHistory(task);
      try {
        const swept = sweepTaskConsults(history, taskId, Date.parse(now));
        const packet = assembleHandoff({
          task,
          history,
          generatedAt: now,
          nextOwner: url.searchParams.get("nextOwner") ?? null,
        });
        return sendJson(res, 200, { handoff: packet, releasedConsults: swept.length }), true;
      } finally {
        history.close();
      }
    }

    if (group === "consults") {
      if (method === "GET" && rest === "") {
        const history = openTaskHistory(task, true);
        try {
          return sendJson(res, 200, { consults: history.ops.listConsults(taskId) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const input = CreateConsultSchema.parse(await readJson(req));
        const history = openTaskHistory(task);
        try {
          const consult = history.ops.createConsult(
            { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
            input,
            Date.parse(now),
          );
          return sendJson(res, 201, { consult }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "/sweep") {
        const body = (await readJson(req)) as { now?: string };
        const at = body.now && Number.isFinite(Date.parse(body.now)) ? Date.parse(body.now) : Date.parse(now);
        const history = openTaskHistory(task);
        try {
          const changed = history.ops.sweepConsults(taskId, at);
          return sendJson(res, 200, { released: changed, now: new Date(at).toISOString() }), true;
        } finally {
          history.close();
        }
      }
      const answerMatch = rest.match(/^\/([^/]+)\/answer$/);
      if (method === "POST" && answerMatch) {
        const input = AnswerConsultSchema.parse(await readJson(req));
        const history = openTaskHistory(task);
        try {
          const consult = history.ops.answerConsult(taskId, decodeURIComponent(answerMatch[1]!), input, Date.parse(now));
          let hintId: string | null = null;
          if (input.injectHint) {
            const hint = history.appendHint({
              taskId,
              text: `[人工答复 consult:${consult.id}] ${input.answer}`,
              source: "human",
              tags: ["consult", `consult:${consult.id}`, `answeredBy:${input.answeredBy}`],
            });
            hintId = hint.id;
          }
          return sendJson(res, 200, { consult, hintId }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "jobs") {
      if (method === "GET" && rest === "") {
        const history = openTaskHistory(task, true);
        try {
          const list = history.ops.listJobs(taskId);
          const withReceipts = url.searchParams.get("receipts") === "1";
          return sendJson(res, 200, {
            jobs: withReceipts
              ? list.map((job) => ({ ...job, receipts: history.ops.listReceipts(taskId, job.id) }))
              : list,
          }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const input = SubmitJobSchema.parse(await readJson(req));
        const evidenceDir = taskPaths(task.dataDir).evidenceDir;
        for (const ref of input.inputs) {
          if (!ref.sha256) continue;
          const actual = sha256(readEvidenceBytes(evidenceDir, ref.path));
          if (actual !== ref.sha256) {
            sendJson(res, 409, { error: "input-sha256-mismatch", path: ref.path, expected: ref.sha256, actual });
            return true;
          }
        }
        const job = jobs.submit(taskId, input);
        return sendJson(res, 202, { job }), true;
      }
      const jobMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]!);
        const action = jobMatch[2] ?? "";
        if (method === "GET" && action === "") {
          const history = openTaskHistory(task, true);
          try {
            const job = history.ops.getJob(taskId, jobId);
            if (!job) return sendJson(res, 404, { error: "job-not-found" }), true;
            return sendJson(res, 200, { job, receipts: history.ops.listReceipts(taskId, jobId) }), true;
          } finally {
            history.close();
          }
        }
        if (method === "POST" && action === "/retry") {
          const job = jobs.retry(taskId, jobId);
          return sendJson(res, 202, { job }), true;
        }
        if (method === "POST" && action === "/receipt") {
          const input = AckJobSchema.parse(await readJson(req));
          const history = openTaskHistory(task);
          try {
            const result = history.ops.ackJob(taskId, jobId, input, now);
            return sendJson(res, 200, result), true;
          } finally {
            history.close();
          }
        }
        if (method === "POST" && action === "/cancel") {
          const history = openTaskHistory(task);
          try {
            const job = history.ops.updateJob(taskId, jobId, { status: "canceled", pauseState: "none" }, now);
            if (!job) return sendJson(res, 404, { error: "job-not-found" }), true;
            return sendJson(res, 200, { job }), true;
          } finally {
            history.close();
          }
        }
      }
    }

    if (group === "materials") {
      if (method === "GET" && rest === "") {
        const history = openTaskHistory(task, true);
        try {
          return sendJson(res, 200, { materials: history.ops.listMaterials(taskId) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const input = ImportMaterialSchema.parse(await readJson(req));
        const paths = taskPaths(task.dataDir);
        const observedAt = input.observedAt ?? now;
        const classification = classifyMaterial({
          path: input.path,
          content: input.content,
          declaredKind: input.kind,
          asset: input.asset ?? null,
          targets: task.auth.targets,
          outOfScope: task.auth.outOfScope,
          observedAt,
          nowMs: Date.parse(now),
          ttlDays: input.ttlDays,
        });
        const secretLike = /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i.test(input.content);
        if (secretLike && !input.secretRef) {
          sendJson(res, 422, {
            error: "secret-material-requires-controlled-ref",
            message: "材料疑似包含明文凭据；请改为 secretRef 受控引用后重试（不写入明文）",
          });
          return true;
        }
        const digest = sha256(input.content);
        const storedPath = input.secretRef ? `${input.path}.ref` : input.path;
        const storedBody = input.secretRef
          ? JSON.stringify({ secretRef: input.secretRef, locator: input.locator, sha256OfOriginal: digest }, null, 2)
          : input.content;
        writeEvidenceFile(paths.evidenceDir, storedPath, storedBody);
        const material: EvidenceImport = {
          id: randomUUID(),
          taskId,
          engagementId: task.engagementId,
          kind: classification.kind,
          status: classification.status,
          source: input.source,
          parser: classification.kind ? { name: `${classification.kind}-parser`, version: "builtin-v1" } : null,
          importedAt: now,
          observedAt,
          asset: classification.asset,
          materialPath: storedPath,
          sha256: digest,
          locator: input.locator,
          sensitivity: input.secretRef ? "controlled-ref" : input.sensitivity,
          secretRef: input.secretRef ?? null,
          reason: classification.reason,
          scopeVersion: task.scopeVersion,
        };
        const history = openTaskHistory(task);
        try {
          history.ops.recordMaterial(material);
          return sendJson(res, 201, { material, classification }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "coverage-cells") {
      if (method === "POST" && rest === "") {
        const input = ManualCoverageSchema.parse(await readJson(req));
        const history = openTaskHistory(task);
        try {
          const row = history.ops.recordManualCoverage(
            { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
            input,
            now,
          );
          return sendJson(res, 201, { coverage: row }), true;
        } finally {
          history.close();
        }
      }
      if (method === "GET" && rest === "") {
        const history = openTaskHistory(task, true);
        try {
          return sendJson(res, 200, { coverage: history.ops.listManualCoverage(taskId) }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "coverage-matrix" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        const events = history.listEvents(taskId, 2000);
        const retractedEvidence = events
          .filter((event) => event.kind === "evidence_removed")
          .flatMap((event) => {
            const payload = event.payload as { path?: unknown; sha256?: unknown };
            return [String(payload.path ?? ""), String(payload.sha256 ?? "")].filter(Boolean);
          });
        const input = {
          taskId,
          engagementId: task.engagementId,
          generatedAt: now,
          assets: history.listAssets(taskId),
          facts: history.listFacts(taskId),
          findings: history.listFindings(taskId),
          intents: history.listIntents(taskId),
          materials: history.ops.listMaterials(taskId),
          manual: history.ops.listManualCoverage(taskId).map((entry) => ({
            asset: entry.asset,
            technique: entry.technique,
            state: entry.state as "manual" | "verified",
            evidenceRefs: entry.evidenceRefs,
          })),
          retractedEvidence,
        };
        const endpointAssets = input.assets
          .filter((asset) => asset.assetType === "endpoint")
          .map((asset) => asset.address);
        const hostAssets = input.assets
          .filter((asset) => asset.assetType !== "endpoint")
          .map((asset) => asset.address);
        const cells = deriveCoverageMatrix({
          assets: hostAssets,
          endpoints: endpointAssets,
          techniques: [
            ...new Set([
              ...input.findings.map((finding) => finding.vulnClass),
              ...input.intents.map((intent) => intent.technique).filter((value): value is string => Boolean(value)),
              ...input.manual.map((entry) => entry.technique),
            ]),
          ],
          materials: input.materials.map((material) => ({
            asset: material.asset,
            kind: material.kind,
            status: material.status,
            materialPath: material.materialPath,
            sha256: material.sha256,
          })),
          findings: input.findings.map((finding) => ({
            id: finding.id,
            asset: finding.asset,
            vulnClass: finding.vulnClass,
            status: finding.status,
            evidence: finding.evidence,
            endpoint: finding.endpoint,
          })),
          intents: input.intents.map((intent) => ({
            technique: intent.technique,
            asset: intent.assetRoot,
            status: intent.status,
          })),
          manual: input.manual,
          retractedEvidence,
        });
        const graph = buildSurfaceGraph(input);
        return sendJson(res, 200, {
          cells,
          summary: {
            total: cells.length,
            byState: cells.reduce<Record<string, number>>((acc, cell) => {
              acc[cell.state] = (acc[cell.state] ?? 0) + 1;
              return acc;
            }, {}),
          },
          graph,
          retractedEvidence,
        }), true;
      } finally {
        history.close();
      }
    }

    if (group === "freshness" && method === "GET") {
      const at = Date.parse(now);
      const history = openTaskHistory(task, true);
      try {
        const facts = history.listFacts(taskId).map((fact) => ({
          factId: fact.id,
          title: fact.title,
          layer: fact.layer,
          tags: fact.tags,
          createdAt: fact.createdAt,
          freshness: freshnessOf(fact, at),
        }));
        return sendJson(res, 200, {
          now: new Date(at).toISOString(),
          fresh: facts.filter((entry) => entry.freshness.state === "fresh").length,
          needsReview: facts.filter((entry) => entry.freshness.state === "needs-review"),
        }), true;
      } finally {
        history.close();
      }
    }

    if (group === "changes") {
      if (method === "GET" && rest === "") {
        const history = openTaskHistory(task, true);
        try {
          const changes = history.ops.listChanges(taskId);
          const open = changes.filter((change) => !change.closedAt);
          return sendJson(res, 200, { changes, open, script: rollbackScript(changes) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const body = (await readJson(req)) as Record<string, unknown> & {
          beforeMaterial?: { path: string; content: string };
        };
        const before = body.beforeMaterial;
        let beforeSha: string | null = null;
        const materials: Array<{ path: string; sha256: string }> = [];
        const paths = taskPaths(task.dataDir);
        if (before) {
          const bytes = Buffer.from(before.content, "utf8");
          beforeSha = sha256(bytes);
          writeEvidenceFile(paths.evidenceDir, before.path, before.content);
          materials.push({ path: before.path, sha256: beforeSha });
        }
        const history = openTaskHistory(task);
        try {
          const change = history.ops.recordChange(
            { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
            {
              kind: String(body.kind) as never,
              asset: String(body.asset),
              location: String(body.location),
              rollbackCmd: String(body.rollbackCmd),
              registeredBy: String(body.registeredBy ?? "operator"),
              note: String(body.note ?? ""),
              ...(typeof body.appliedAt === "string" ? { appliedAt: body.appliedAt } : {}),
              ...(typeof body.credentialId === "string" ? { credentialId: body.credentialId } : {}),
              ...(typeof body.intentId === "string" ? { intentId: body.intentId } : {}),
            },
            beforeSha,
            now,
            materials,
          );
          return sendJson(res, 201, { change }), true;
        } finally {
          history.close();
        }
      }
      const confirmMatch = rest.match(/^\/([^/]+)\/confirm$/);
      if (method === "POST" && confirmMatch) {
        const body = (await readJson(req)) as { confirmedBy?: string };
        const history = openTaskHistory(task);
        try {
          const change = history.ops.confirmChange(
            taskId,
            decodeURIComponent(confirmMatch[1]!),
            body.confirmedBy ?? "operator",
            now,
          );
          if (!change) return sendJson(res, 404, { error: "change-not-found" }), true;
          return sendJson(res, 200, { change }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "rollback" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        return sendText(res, 200, rollbackScript(history.ops.listChanges(taskId)), "text/x-shellscript; charset=utf-8"), true;
      } finally {
        history.close();
      }
    }

    // P14-B3 — cross-task read-only "历史接触"（线索，不是授权/事实）。
    if (group === "asset-history" && method === "GET") {
      const address = url.searchParams.get("address") ?? "";
      return sendJson(res, 200, assetHistory(store, task, address)), true;
    }

    // P17 — event hash-chain head + verification.
    if (group === "chain" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        return sendJson(res, 200, history.verifyEventChain(taskId)), true;
      } finally {
        history.close();
      }
    }

    // P15-C2 — operator reset for the repeated-command breaker.
    if (group === "command-reset" && method === "POST") {
      const body = (await readJson(req).catch(() => ({}))) as { reason?: unknown };
      const history = openTaskHistory(task);
      try {
        history.resetCommandAttempts(taskId, typeof body.reason === "string" ? body.reason : "");
        return sendJson(res, 200, { ok: true }), true;
      } finally {
        history.close();
      }
    }

    // P15 — read-only engagement audit (observations + confirmation scorecard).
    if (group === "audit" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        return sendJson(res, 200, history.engagementAudit(taskId)), true;
      } finally {
        history.close();
      }
    }

    // P15-C1 — append-only independent validations for this task.
    if (group === "validations" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        const findingId = url.searchParams.get("findingId") ?? undefined;
        return sendJson(res, 200, {
          validations: history.listFindingValidations(taskId, findingId),
        }), true;
      } finally {
        history.close();
      }
    }

    // P14 — read-only projection of transactions / plan / credentials / retests / OAST.
    if (group === "p14" && method === "GET") {
      const history = openTaskHistory(task, true);
      try {
        return sendJson(res, 200, {
          transactions: history.listHttpTransactions(taskId, 50),
          plan: history.listPlan(taskId),
          credentials: history.listCredentials(taskId),
          retests: history.listFindingRetests(taskId),
          validations: history.listFindingValidations(taskId),
          oastTokens: history.listOastTokens(taskId),
          oastHits: history.listOastHits(taskId),
          tunnels: (() => {
            try {
              return new TunnelManager({
                baseDir: join(task.dataDir, "exec"),
                authorizeHost: () => true,
              }).list();
            } catch {
              return [];
            }
          })(),
        }), true;
      } finally {
        history.close();
      }
    }

    if (group === "graphs" && method === "GET") {
      const view = rest.replace(/^\//, "");
      if (view === "memory") {
        return await handleFrozenTaskRoute(req, res, method, url, deps, task, "graphs", rest, now);
      }
      const history = openTaskHistory(task, true);
      try {
        const assets = history.listAssets(taskId);
        const facts = history.listFacts(taskId);
        const findings = history.listFindings(taskId);
        const intents = history.listIntents(taskId);
        const events = history.listEvents(taskId, 1000);
        let graph: GraphView;
        if (view === "ad" || view === "cloud") {
          const all = history.attackGraph(taskId);
          const prefix = view === "ad" ? "ad-" : "cloud-";
          const nodes = all.nodes.filter((node) => node.kind.startsWith(prefix));
          const ids = new Set(nodes.map((node) => node.id));
          const edges = all.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
          return sendJson(res, 200, {
            view,
            nodes,
            edges,
            paths: findAttackPaths(
              { nodes, edges },
              {
                maxDepth: 8,
                maxPaths: 20,
                ...(view === "cloud"
                  ? {
                      targets: nodes
                        .filter((node) => node.kind === "cloud-role" || /admin|owner|root/i.test(node.name))
                        .map((node) => node.id),
                    }
                  : {}),
              },
            ),
          }), true;
        }
        if (view === "assets") {
          graph = buildAssetGraph({
            taskId,
            engagementId: task.engagementId,
            generatedAt: now,
            targets: task.auth.targets,
            outOfScope: task.auth.outOfScope,
            assets,
            facts,
            intents,
          });
        } else if (view === "surface") {
          const retractedEvidence = events
            .filter((event) => event.kind === "evidence_removed")
            .map((event) => String((event.payload as { path?: unknown }).path ?? ""))
            .filter(Boolean);
          graph = buildSurfaceGraph({
            taskId,
            engagementId: task.engagementId,
            generatedAt: now,
            assets,
            facts,
            findings,
            intents,
            materials: history.ops.listMaterials(taskId),
            manual: history.ops.listManualCoverage(taskId).map((entry) => ({
              asset: entry.asset,
              technique: entry.technique,
              state: entry.state,
              evidenceRefs: entry.evidenceRefs,
            })),
            retractedEvidence,
          });
        } else if (view === "execution") {
          graph = buildExecutionGraph({
            taskId,
            engagementId: task.engagementId,
            generatedAt: now,
            steps: listExecutionSteps(task.dataDir).steps,
            events,
            intents,
            jobs: history.ops.listJobs(taskId),
          });
        } else {
          return sendJson(res, 404, { error: `unknown-graph-view:${view}` }), true;
        }
        return sendJson(res, 200, { graph }), true;
      } finally {
        history.close();
      }
    }

    if (group === "causality" && method === "GET") {
      const findingId = rest.replace(/^\//, "");
      if (!findingId) return sendJson(res, 400, { error: "findingId-required" }), true;
      const history = openTaskHistory(task, true);
      try {
        const finding = history.getFinding(taskId, findingId);
        if (!finding) return sendJson(res, 404, { error: "finding-not-found" }), true;
        const trace = causalityTrace({
          taskId,
          engagementId: task.engagementId,
          generatedAt: now,
          finding,
          findings: history.listFindings(taskId),
          facts: history.listFacts(taskId),
          intents: history.listIntents(taskId),
        });
        return sendJson(res, 200, { trace }), true;
      } finally {
        history.close();
      }
    }

    if (group === "alerts" && method === "GET") {
      const threshold = Number(url.searchParams.get("threshold") ?? 20);
      const history = openTaskHistory(task, true);
      try {
        const events = history.listEvents(taskId, 2000);
        const lastFactAt =
          events
            .filter((event) => event.kind === "fact_appended")
            .map((event) => event.createdAt)
            .sort()
            .at(-1) ?? "";
        const toolCalls = events.filter((event) => event.kind === "tool_gate" && event.createdAt > lastFactAt).length;
        const waiting = history.ops.listConsults(taskId).some((consult) => consult.status === "open" && consult.blocking);
        const alarm = noProgressAlarm({ toolCallsSinceFact: toolCalls, threshold, waitingOnConsult: waiting });
        return sendJson(res, 200, { ...alarm, toolCallsSinceFact: toolCalls, threshold, waitingOnConsult: waiting }), true;
      } finally {
        history.close();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, error instanceof BoundaryError ? 403 : 400, { error: message });
    return true;
  }

  return false;
}

export { CONSULT_BLOCKING_TTL_MS, areFrozenRoutesEnabled, handleFrozenRoute };
