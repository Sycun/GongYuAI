/**
 * 第九轮新增路由：委托边界、持久作业、人工求助/交接、材料与覆盖、
 * 四图与因果、记忆/档案、飞轮与提案、角色与供应商韧性。
 *
 * 约定：新入口统一返回 JSON；委托不匹配 403；缺输入 400；业务冲突 409。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import {
  AnswerConsultSchema,
  BoundaryError,
  CONSULT_BLOCKING_TTL_MS,
  CreateConsultSchema,
  CreateMemoryDraftSchema,
  CreateProposalSchema,
  ImportMaterialSchema,
  MEMORY_INJECTION_TITLE_LIMIT,
  ManualCoverageSchema,
  ProposalSchema,
  ProviderPolicySchema,
  ReviewMemorySchema,
  RunEvaluationSchema,
  RunRoleWorkSchema,
  SubmitJobSchema,
  AckJobSchema,
  assetIdentity,
  classifyMaterial,
  deriveCoverageMatrix,
  detectMaterialKind,
  freshnessOf,
  matchMemory,
  noProgressAlarm,
  normalizeHost,
  planProviderAttempt,
  rollbackScript,
  targetAllows,
  visibilityDenial,
  type EvidenceImport,
  type GraphView,
  type MemoryNode,
  type ProviderFault,
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
import {
  buildAssetGraph,
  buildExecutionGraph,
  buildMemoryGraph,
  buildSurfaceGraph,
  causalityTrace,
} from "./graphs.js";
import { simulateRoleWork } from "./roles.js";
import { MEMORY_READ_UNAVAILABLE, beginMemoryReview, memoryReadAllowed, memoryReviewEngagementMatches, verifiedIdentityFromRequest } from "./memory-access.js";
import { taskPaths } from "./paths.js";

export type OpsRouteDeps = {
  store: ControlStore;
  jobs: JobRunner;
  platform: PlatformStore;
  runner: WorkerRunner;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nowIso(url: URL, fallback = Date.now()): string {
  const raw = url.searchParams.get("now");
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallback).toISOString();
}

function boundaryOf(task: TaskRecord, url: URL, req: IncomingMessage) {
  const headerEngagement = req.headers["x-engagement-id"];
  const headerTenant = req.headers["x-tenant-id"];
  const tenant = url.searchParams.get("tenantId") ?? (typeof headerTenant === "string" ? headerTenant : undefined);
  const engagement = url.searchParams.get("engagementId") ?? (typeof headerEngagement === "string" ? headerEngagement : undefined);
  // 未显式声明上下文时，任务 ID 本身已决定委托；显式声明就必须匹配。
  return visibilityDenial(
    {
      // visibilityDenial 会与任务的 tenantId 比较；未声明时直接传任务自身的租户，
      // 等价于“不额外限制”，但一旦调用方声明了别的租户就会 403。
      tenantId: tenant ?? task.tenantId,
      ...(engagement ? { engagementId: engagement } : {}),
      role: "operator",
    },
    task,
  );
}

function open(task: TaskRecord, readOnly = false): HistoryStore {
  const paths = taskPaths(task.dataDir);
  return openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir, readOnly });
}

function memoryVisible(node: MemoryNode, scope: { tenantId: string; engagementId?: string; mode: "tenant" | "engagement" }, store: ControlStore): boolean {
  return node.provenance.some((pointer) => {
    if (scope.mode === "engagement") return scope.engagementId !== undefined && pointer.engagementId === scope.engagementId;
    const task = store.get(pointer.taskId);
    return (task?.tenantId ?? "default") === scope.tenantId;
  });
}

export async function handleOpsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: OpsRouteDeps,
): Promise<boolean> {
  const { store, jobs, platform } = deps;
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
      open: (task) => open(task, true),
    });
    return send(res, 200, work), true;
  }

  /* ------------------------------ 任务级路由 ------------------------------ */
  const taskMatch = path.match(
    /^\/tasks\/([^/]+)\/(handoff|consults|jobs|materials|coverage-matrix|coverage-cells|freshness|changes|rollback|graphs|causality|roles|provider|model-request|memory|alerts)(\/.*)?$/,
  );
  if (!taskMatch) return handlePlatformRoute(req, res, method, url, deps);

  const taskId = decodeURIComponent(taskMatch[1]!);
  const group = taskMatch[2]!;
  const rest = taskMatch[3] ?? "";
  const task = store.get(taskId);
  if (!task) {
    send(res, 404, { error: "task-not-found" });
    return true;
  }
  const denial = boundaryOf(task, url, req);
  if (denial) {
    send(res, 403, { error: denial.code, message: denial.message });
    return true;
  }
  const now = nowIso(url);

  try {
    if (group === "handoff" && method === "GET") {
      const history = open(task);
      try {
        const swept = sweepTaskConsults(history, taskId, Date.parse(now));
        const packet = assembleHandoff({
          task,
          history,
          generatedAt: now,
          nextOwner: url.searchParams.get("nextOwner") ?? null,
        });
        return send(res, 200, { handoff: packet, releasedConsults: swept.length }), true;
      } finally {
        history.close();
      }
    }

    if (group === "consults") {
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          return send(res, 200, { consults: history.ops.listConsults(taskId) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const input = CreateConsultSchema.parse(await readJson(req));
        const history = open(task);
        try {
          const consult = history.ops.createConsult(
            { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
            input,
            Date.parse(now),
          );
          return send(res, 201, { consult }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "/sweep") {
        const body = (await readJson(req)) as { now?: string };
        const at = body.now && Number.isFinite(Date.parse(body.now)) ? Date.parse(body.now) : Date.parse(now);
        const history = open(task);
        try {
          const changed = history.ops.sweepConsults(taskId, at);
          return send(res, 200, { released: changed, now: new Date(at).toISOString() }), true;
        } finally {
          history.close();
        }
      }
      const answerMatch = rest.match(/^\/([^/]+)\/answer$/);
      if (method === "POST" && answerMatch) {
        const input = AnswerConsultSchema.parse(await readJson(req));
        const history = open(task);
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
          return send(res, 200, { consult, hintId }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "jobs") {
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          const list = history.ops.listJobs(taskId);
          const withReceipts = url.searchParams.get("receipts") === "1";
          return send(
            res,
            200,
            {
              jobs: withReceipts
                ? list.map((job) => ({ ...job, receipts: history.ops.listReceipts(taskId, job.id) }))
                : list,
            },
          ), true;
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
            send(res, 409, { error: "input-sha256-mismatch", path: ref.path, expected: ref.sha256, actual });
            return true;
          }
        }
        const job = jobs.submit(taskId, input);
        return send(res, 202, { job }), true;
      }
      const jobMatch = rest.match(/^\/([^/]+)(\/.*)?$/);
      if (jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]!);
        const action = jobMatch[2] ?? "";
        if (method === "GET" && action === "") {
          const history = open(task, true);
          try {
            const job = history.ops.getJob(taskId, jobId);
            if (!job) return send(res, 404, { error: "job-not-found" }), true;
            return send(res, 200, { job, receipts: history.ops.listReceipts(taskId, jobId) }), true;
          } finally {
            history.close();
          }
        }
        if (method === "POST" && action === "/retry") {
          const job = jobs.retry(taskId, jobId);
          return send(res, 202, { job }), true;
        }
        if (method === "POST" && action === "/receipt") {
          const input = AckJobSchema.parse(await readJson(req));
          const history = open(task);
          try {
            const result = history.ops.ackJob(taskId, jobId, input, now);
            return send(res, 200, result), true;
          } finally {
            history.close();
          }
        }
        if (method === "POST" && action === "/cancel") {
          const history = open(task);
          try {
            const job = history.ops.updateJob(taskId, jobId, { status: "canceled", pauseState: "none" }, now);
            if (!job) return send(res, 404, { error: "job-not-found" }), true;
            return send(res, 200, { job }), true;
          } finally {
            history.close();
          }
        }
      }
    }

    if (group === "materials") {
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          return send(res, 200, { materials: history.ops.listMaterials(taskId) }), true;
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
          send(res, 422, {
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
        const history = open(task);
        try {
          history.ops.recordMaterial(material);
          return send(res, 201, { material, classification }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "coverage-cells") {
      if (method === "POST" && rest === "") {
        const input = ManualCoverageSchema.parse(await readJson(req));
        const history = open(task);
        try {
          const row = history.ops.recordManualCoverage(
            { taskId, engagementId: task.engagementId, scopeVersion: task.scopeVersion },
            input,
            now,
          );
          return send(res, 201, { coverage: row }), true;
        } finally {
          history.close();
        }
      }
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          return send(res, 200, { coverage: history.ops.listManualCoverage(taskId) }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "coverage-matrix" && method === "GET") {
      const history = open(task, true);
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
        const cells = deriveCoverageMatrix({
          assets: input.assets.map((asset) => asset.address),
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
          })),
          intents: input.intents.map((intent) => ({ technique: intent.technique, asset: intent.assetRoot, status: intent.status })),
          manual: input.manual,
          retractedEvidence,
        });
        const graph = buildSurfaceGraph(input);
        return send(res, 200, {
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
      const history = open(task, true);
      try {
        const facts = history.listFacts(taskId).map((fact) => ({
          factId: fact.id,
          title: fact.title,
          layer: fact.layer,
          tags: fact.tags,
          createdAt: fact.createdAt,
          freshness: freshnessOf(fact, at),
        }));
        return send(res, 200, {
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
        const history = open(task, true);
        try {
          const changes = history.ops.listChanges(taskId);
          const open = changes.filter((change) => !change.closedAt);
          return send(res, 200, { changes, open, script: rollbackScript(changes) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const body = (await readJson(req)) as Record<string, unknown> & { beforeMaterial?: { path: string; content: string } };
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
        const history = open(task);
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
          return send(res, 201, { change }), true;
        } finally {
          history.close();
        }
      }
      const confirmMatch = rest.match(/^\/([^/]+)\/confirm$/);
      if (method === "POST" && confirmMatch) {
        const body = (await readJson(req)) as { confirmedBy?: string };
        const history = open(task);
        try {
          const change = history.ops.confirmChange(taskId, decodeURIComponent(confirmMatch[1]!), body.confirmedBy ?? "operator", now);
          if (!change) return send(res, 404, { error: "change-not-found" }), true;
          return send(res, 200, { change }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "rollback" && method === "GET") {
      const history = open(task, true);
      try {
        return sendText(res, 200, rollbackScript(history.ops.listChanges(taskId)), "text/x-shellscript; charset=utf-8"), true;
      } finally {
        history.close();
      }
    }

    if (group === "graphs" && method === "GET") {
      const view = rest.replace(/^\//, "");
      const history = open(task, true);
      try {
        const assets = history.listAssets(taskId);
        const facts = history.listFacts(taskId);
        const findings = history.listFindings(taskId);
        const intents = history.listIntents(taskId);
        const events = history.listEvents(taskId, 1000);
        let graph: GraphView;
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
        } else if (view === "memory") {
          // 没有可核验身份时不组装图，避免把节点标题放进响应。
          memoryReadAllowed(verifiedIdentityFromRequest());
          return send(res, 403, MEMORY_READ_UNAVAILABLE), true;
        } else {
          return send(res, 404, { error: `unknown-graph-view:${view}` }), true;
        }
        return send(res, 200, { graph }), true;
      } finally {
        history.close();
      }
    }

    if (group === "causality" && method === "GET") {
      const findingId = rest.replace(/^\//, "");
      if (!findingId) return send(res, 400, { error: "findingId-required" }), true;
      const history = open(task, true);
      try {
        const finding = history.getFinding(taskId, findingId);
        if (!finding) return send(res, 404, { error: "finding-not-found" }), true;
        const trace = causalityTrace({
          taskId,
          engagementId: task.engagementId,
          generatedAt: now,
          finding,
          findings: history.listFindings(taskId),
          facts: history.listFacts(taskId),
          intents: history.listIntents(taskId),
        });
        return send(res, 200, { trace }), true;
      } finally {
        history.close();
      }
    }

    if (group === "roles") {
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          const list = history.ops
            .listJobs(taskId)
            .filter((job) => job.kind === "role-plan" || job.kind === "role-review");
          return send(res, 200, { work: list.map((job) => ({ jobId: job.id, kind: job.kind, status: job.status, result: job.result })) }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const input = RunRoleWorkSchema.parse(await readJson(req));
        if (input.kind === "incident") {
          const output = simulateRoleWork(input.role, "incident", input.input);
          let paused: TaskRecord | null = null;
          if (output.pauseRequested) paused = await deps.runner.pause(taskId);
          const history = open(task);
          try {
            history.recordEvent(taskId, "role_work_finished", {
              role: input.role,
              kind: input.kind,
              output: output as unknown as Record<string, unknown>,
              pauseRequested: output.pauseRequested,
              authenticity: "simulated",
            });
          } finally {
            history.close();
          }
          return send(res, 200, { role: input.role, kind: input.kind, output, paused: Boolean(paused), authenticity: "simulated", billing: "none" }), true;
        }
        const job = jobs.submit(taskId, {
          kind: input.kind === "plan" ? "role-plan" : "role-review",
          label: `${input.role}:${input.kind}`,
          submittedBy: "operator",
          inputs: [{ path: `ops/roles/${taskId}.json`, sha256: null }],
          options: { role: input.role, kind: input.kind, input: input.input, simulated: true },
        });
        return send(res, 202, { job }), true;
      }
    }

    if (group === "provider") {
      if (method === "GET" && rest === "") {
        const history = open(task, true);
        try {
          const attempts = history
            .listEvents(taskId, 1000)
            .filter((event) => event.kind === "provider_fault_handled")
            .map((event) => ({ id: event.id, at: event.createdAt, ...(event.payload as Record<string, unknown>) }));
          return send(res, 200, { attempts }), true;
        } finally {
          history.close();
        }
      }
      if (method === "POST" && rest === "") {
        const body = (await readJson(req)) as {
          provider?: string;
          fault?: ProviderFault;
          attempt?: number;
          fallbackAllowed?: boolean;
          billing?: "none" | "usage-only" | "billed";
          tokens?: number;
        };
        if (!body.fault || !body.provider) return send(res, 400, { error: "provider-and-fault-required" }), true;
        const policy = ProviderPolicySchema.parse({
          engagementId: task.engagementId,
          materialDataClass: "customer-material",
          providers: [
            { name: body.provider, priority: 0, allowedDataClasses: ["customer-material"] },
            { name: `${body.provider}-fallback`, priority: 1, allowedDataClasses: body.fallbackAllowed ? ["customer-material"] : [] },
          ],
        });
        const plan = planProviderAttempt({
          policy,
          provider: body.provider,
          fault: body.fault,
          attempt: Math.max(0, Number(body.attempt ?? 0)),
          billing: body.billing ?? "none",
        });
        const history = open(task);
        try {
          const key = `${body.provider}:${body.fault}:${body.attempt ?? 0}`;
          const duplicate = history
            .listEvents(taskId, 2000)
            .some(
              (event) =>
                event.kind === "provider_fault_handled" &&
                String((event.payload as { key?: unknown }).key ?? "") === key &&
                (event.payload as { tokens?: unknown }).tokens !== undefined,
            );
          history.recordEvent(taskId, "provider_fault_handled", {
            key,
            provider: body.provider,
            fault: body.fault,
            attempt: body.attempt ?? 0,
            ...plan,
            tokens: duplicate ? null : (body.tokens ?? null),
            duplicateAccounting: duplicate,
          });
          return send(res, 200, { plan, duplicateAccounting: duplicate, egressEngagement: task.engagementId }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "alerts" && method === "GET") {
      const threshold = Number(url.searchParams.get("threshold") ?? 20);
      const history = open(task, true);
      try {
        const events = history.listEvents(taskId, 2000);
        // 与事件顺序无关：取最新一条 fact_appended 的时间，再数它之后的工具闸记录。
        const lastFactAt =
          events
            .filter((event) => event.kind === "fact_appended")
            .map((event) => event.createdAt)
            .sort()
            .at(-1) ?? "";
        const toolCalls = events.filter((event) => event.kind === "tool_gate" && event.createdAt > lastFactAt).length;
        const waiting = history.ops.listConsults(taskId).some((consult) => consult.status === "open" && consult.blocking);
        const alarm = noProgressAlarm({ toolCallsSinceFact: toolCalls, threshold, waitingOnConsult: waiting });
        return send(res, 200, { ...alarm, toolCallsSinceFact: toolCalls, threshold, waitingOnConsult: waiting }), true;
      } finally {
        history.close();
      }
    }

    if (group === "memory") {
      if (!memoryReadAllowed(verifiedIdentityFromRequest())) {
        return send(res, 403, MEMORY_READ_UNAVAILABLE), true;
      }
      if (method === "POST" && rest === "/inject") {
        const body = (await readJson(req)) as { asset?: string; familyKey?: string; cwes?: string[]; techniques?: string[] };
        const history = open(task);
        try {
          const assets = history.listAssets(taskId);
          const findings = history.listFindings(taskId);
          const intents = history.listIntents(taskId);
          const already = platform.listInjections({ taskId }).map((injection) => injection.memoryId);
          const candidates = platform
            .listNodes({ status: "confirmed" })
            .filter((node) => memoryVisible(node, { tenantId: task.tenantId, engagementId: task.engagementId, mode: "engagement" }, store));
          const matches = matchMemory(
            candidates,
            {
              familyKey: body.familyKey ?? null,
              cwes: body.cwes ?? findings.map((finding) => finding.vulnClass),
              techniques: body.techniques ?? intents.map((intent) => intent.technique).filter((value): value is string => Boolean(value)),
              assetKey: body.asset ?? assets[0]?.address ?? null,
              assetClass: body.asset ?? null,
            },
            { limit: MEMORY_INJECTION_TITLE_LIMIT, alreadyInjected: already },
          );
          const injected = matches.map((match) => {
            const hint = history.appendHint({
              taskId,
              text: `[全局记忆/${match.node.kind}] ${match.node.title}${match.node.body ? `｜${match.node.body.slice(0, 300)}` : ""}`,
              source: "system",
              tags: ["memory", `memory:${match.node.id}`, `layer:${match.layer}`, ...match.matched],
            });
            const injection = platform.recordInjection({
              memoryId: match.node.id,
              taskId,
              engagementId: task.engagementId,
              hintId: hint.id,
              layer: match.layer,
              matchedKeys: match.matched,
              reason: match.hard ? "hard-key" : "soft-key>=2",
              at: now,
            });
            history.recordEvent(taskId, "memory_injected", { memoryId: match.node.id, hintId: hint.id, layer: match.layer });
            return { memoryId: match.node.id, title: match.node.title, layer: match.layer, matched: match.matched, hintId: hint.id, injection };
          });
          return send(res, 200, { injected, considered: candidates.length }), true;
        } finally {
          history.close();
        }
      }
    }

    if (group === "model-request" && method === "POST") {
      // 模拟模型请求：只允许本任务 + 本委托记忆；不调用真实供应商。
      const history = open(task, true);
      try {
        const hints = history.listHints(taskId, 20);
        return send(res, 200, {
          authenticity: "simulated",
          billing: "none",
          egress: { tenantId: task.tenantId, engagementId: task.engagementId, allowed: true },
          payload: {
            task: { id: task.id, name: task.name, scopeVersion: task.scopeVersion, targets: task.auth.targets },
            hints: hints.map((hint) => ({ id: hint.id, source: hint.source, tags: hint.tags, text: hint.text })),
            memory: [],
            memoryAccess: MEMORY_READ_UNAVAILABLE,
            facts: history.listFacts(taskId).slice(0, 20).map((fact) => ({ id: fact.id, title: fact.title })),
          },
        }), true;
      } finally {
        history.close();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, error instanceof BoundaryError ? 403 : 400, { error: message });
    return true;
  }

  return false;
}

async function handlePlatformRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: OpsRouteDeps,
): Promise<boolean> {
  const { store, platform } = deps;
  const path = url.pathname;
  const tenantParam = url.searchParams.get("tenantId") ?? undefined;
  const engagementParam = url.searchParams.get("engagementId") ?? undefined;
  const tenantId = tenantParam ?? "default";
  const engagementId = engagementParam;
  // 未声明上下文 = 单用户本地平台，不做额外限制；一旦声明就必须匹配（客户隔离靠这条）。
  const visible = (node: MemoryNode): boolean =>
    tenantParam === undefined && engagementParam === undefined
      ? true
      : memoryVisible(node, { tenantId, engagementId, mode: engagementParam ? "engagement" : "tenant" }, store);
  try {
    if (path.startsWith("/memory/nodes") && method === "GET") {
      if (!memoryReadAllowed(verifiedIdentityFromRequest())) {
        return send(res, 403, MEMORY_READ_UNAVAILABLE), true;
      }
    }
    if (path === "/memory/nodes" && method === "GET") {
      const status = url.searchParams.get("status") ?? undefined;
      const kind = url.searchParams.get("kind") ?? undefined;
      const nodes = platform
        .listNodes({
          ...(status ? { status: status as never } : {}),
          ...(kind ? { kind: kind as never } : {}),
        })
        .filter(visible);
      return send(res, 200, { nodes }), true;
    }
    if (path === "/memory/nodes" && method === "POST") {
      const input = CreateMemoryDraftSchema.parse(await readJson(req));
      const node = platform.createDraft(input, new Date().toISOString());
      return send(res, 201, { node }), true;
    }
    const nodeMatch = path.match(/^\/memory\/nodes\/([^/]+)(\/.*)?$/);
    if (nodeMatch) {
      const id = decodeURIComponent(nodeMatch[1]!);
      const action = nodeMatch[2] ?? "";
      if (method === "POST" && action === "/review") {
        // 身份、复核权限和委托都要先成立。未获准时不读取节点、不写复核、不返回正文。
        const gate = beginMemoryReview(verifiedIdentityFromRequest(req));
        if (!gate.proceed) return send(res, gate.status, gate.body), true;
        const ownership = platform.memoryOwnership(id);
        if (!ownership) return send(res, 404, { error: "memory-not-found" }), true;
        if (!memoryReviewEngagementMatches(ownership, gate.identity)) {
          return send(res, 403, { error: "engagement-mismatch" }), true;
        }
        const input = ReviewMemorySchema.parse(await readJson(req));
        const updated = platform.reviewNode(id, input, new Date().toISOString());
        return send(res, 200, { node: updated }), true;
      }
      const node = platform.getNode(id);
      if (!node) return send(res, 404, { error: "memory-not-found" }), true;
      if (!visible(node)) {
        return send(res, 403, { error: "engagement-mismatch" }), true;
      }
      if (method === "GET" && action === "") return send(res, 200, { node }), true;
      if (method === "GET" && action === "/references") {
        return send(res, 200, { references: platform.referencesFor(id) }), true;
      }
      if (method === "GET" && action === "/events") {
        return send(res, 200, { events: platform.listMemoryEvents(id) }), true;
      }
    }

    if (path === "/archive/contact" && method === "GET") {
      const targets = (url.searchParams.get("targets") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (targets.length === 0) return send(res, 400, { error: "targets-required" }), true;
      const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20));
      const hits: unknown[] = [];
      for (const task of store.list()) {
        if ((task.tenantId ?? "default") !== tenantId) continue;
        if (hits.length >= limit) break;
        let history: HistoryStore;
        try {
          history = open(task, true);
        } catch {
          continue;
        }
        try {
          const assets = history.listAssets(task.id);
          const matched = assets.filter((asset) => targets.some((pattern) => targetAllows([pattern], asset.address)));
          if (matched.length === 0) continue;
          const findings = history.listFindings(task.id);
          hits.push({
            taskId: task.id,
            engagementId: task.engagementId,
            name: task.name,
            status: task.status,
            finishedAt: task.finishedAt,
            findings: findings.length,
            verifiedFindings: findings.filter((finding) => ["verified", "retested", "accepted"].includes(finding.status)).length,
            retractedFindings: findings.filter((finding) => finding.status === "retracted").length,
            pointer: { kind: "task", id: task.id, sha256: null },
            mayHaveDrifted: task.finishedAt ? Date.now() - Date.parse(task.finishedAt) > 14 * 86_400_000 : false,
            sameAsset: matched.some((asset) => findings.some((finding) => normalizeHost(finding.asset) === normalizeHost(asset.address))),
          });
        } finally {
          history.close();
        }
      }
      return send(res, 200, {
        query: { targets, tenantId, engagementId, limit },
        hits,
        nonBlocking: true,
        note: "历史接触 ≠ 本次授权；只读指针，下钻走源任务。",
      }), true;
    }

    if (path === "/proposals" && method === "GET") {
      const proposals = platform.listProposals({
        ...(url.searchParams.get("status") ? { status: url.searchParams.get("status") as never } : {}),
        ...(url.searchParams.get("kind") ? { kind: url.searchParams.get("kind") as never } : {}),
      });
      return send(res, 200, { proposals }), true;
    }
    if (path === "/proposals" && method === "POST") {
      const input = CreateProposalSchema.parse(await readJson(req));
      const proposal = platform.createProposal(input, new Date().toISOString());
      return send(res, 201, { proposal }), true;
    }
    const proposalMatch = path.match(/^\/proposals\/([^/]+)(\/.*)?$/);
    if (proposalMatch) {
      const id = decodeURIComponent(proposalMatch[1]!);
      const action = proposalMatch[2] ?? "";
      const proposal = platform.getProposal(id);
      if (!proposal) return send(res, 404, { error: "proposal-not-found" }), true;
      if (method === "GET" && action === "") return send(res, 200, { proposal }), true;
      if (method === "POST" && action === "/decide") {
        const body = (await readJson(req)) as { decision?: "approve" | "reject"; decidedBy?: string; reason?: string };
        if (!body.decision || !body.decidedBy) return send(res, 400, { error: "decision-and-decidedBy-required" }), true;
        const updated = platform.decideProposal(id, { decision: body.decision, decidedBy: body.decidedBy, reason: body.reason ?? "" }, new Date().toISOString());
        return send(res, 200, { proposal: updated }), true;
      }
      if (method === "POST" && action === "/promote") {
        const body = (await readJson(req)) as { promotedBy?: string; evaluationRunId?: string };
        if (!body.promotedBy || !body.evaluationRunId) return send(res, 400, { error: "promotedBy-and-evaluationRunId-required" }), true;
        const updated = platform.promoteProposal(id, { promotedBy: body.promotedBy, evaluationRunId: body.evaluationRunId }, new Date().toISOString());
        return send(res, 200, { proposal: updated }), true;
      }
      if (method === "POST" && action === "/rollback") {
        const body = (await readJson(req)) as { rolledBackBy?: string; reason?: string };
        if (!body.rolledBackBy) return send(res, 400, { error: "rolledBackBy-required" }), true;
        const updated = platform.rollbackProposal(id, { rolledBackBy: body.rolledBackBy, reason: body.reason ?? "" }, new Date().toISOString());
        return send(res, 200, { proposal: updated }), true;
      }
      if (method === "GET" && action === "/events") {
        return send(res, 200, { events: platform.listProposalEvents(id) }), true;
      }
    }

    if (path === "/evaluations" && method === "GET") {
      return send(res, 200, {
        evaluations: platform.listEvaluations({
          ...(url.searchParams.get("suite") ? { suite: url.searchParams.get("suite")! } : {}),
          ...(url.searchParams.get("group") ? { group: url.searchParams.get("group")! } : {}),
        }),
      }), true;
    }
    if (path === "/evaluations" && method === "POST") {
      const input = RunEvaluationSchema.parse(await readJson(req));
      const run = platform.recordEvaluation(input, new Date().toISOString());
      return send(res, 201, { evaluation: run }), true;
    }
    const evalMatch = path.match(/^\/evaluations\/([^/]+)$/);
    if (evalMatch && method === "GET") {
      const run = platform.getEvaluation(decodeURIComponent(evalMatch[1]!));
      if (!run) return send(res, 404, { error: "evaluation-not-found" }), true;
      return send(res, 200, { evaluation: run }), true;
    }

    if (path === "/trends" && method === "GET") {
      const points: Array<Record<string, unknown>> = [];
      for (const task of store.list()) {
        if ((task.tenantId ?? "default") !== tenantId) continue;
        if (engagementId && task.engagementId !== engagementId) continue;
        let history: HistoryStore;
        try {
          history = open(task, true);
        } catch {
          continue;
        }
        try {
          const goals = history.listGoals(task.id);
          const findings = history.listFindings(task.id);
          const injections = platform.listInjections({ taskId: task.id });
          points.push({
            batch: (task.finishedAt ?? task.createdAt).slice(0, 10),
            taskId: task.id,
            engagementId: task.engagementId,
            at: task.finishedAt ?? task.createdAt,
            goalsPassed: goals.filter((goal) => goal.passes).length,
            goalsTotal: goals.length,
            verifiedFindings: findings.filter((finding) => ["verified", "retested", "accepted"].includes(finding.status)).length,
            retractedFindings: findings.filter((finding) => finding.status === "retracted").length,
            tokens: task.usage.tokens,
            wallMs: task.startedAt && task.finishedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : 0,
            reuseCount: injections.length,
          });
        } finally {
          history.close();
        }
      }
      points.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return send(res, 200, {
        points,
        note: "只报可复核计数；样本不足时不宣称趋势显著。",
      }), true;
    }
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}

export { sha256, CONSULT_BLOCKING_TTL_MS };
