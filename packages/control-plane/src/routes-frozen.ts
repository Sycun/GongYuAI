/**
 * 冻结支线与模拟推演路由（Tier-3 Frozen & Simulated Routes）。
 *
 * 依据 `docs/MASTER-DESIGN.md` 与 `docs/README.md` 收敛策略，以下能力已脱离主干热路径，
 * 独立隔离在本模块中维护：
 * 1. P8 跨任务全局记忆与历史接触归档（`/memory/nodes*`、`/tasks/:id/memory/inject`、`/tasks/:id/graphs/memory`、`/archive/contact`）
 * 2. P9 自进化提案飞轮、基准评测与跨批次趋势（`/proposals*`、`/evaluations*`、`/trends`）
 * 3. 第九轮模拟推演接口（`/tasks/:id/roles`、`/tasks/:id/provider`、`/tasks/:id/model-request`，均带 `authenticity: "simulated"`）
 *
 * 默认保持挂载以兼容既有集成测试；生产或纯净单兵部署可通过 `GY_DISABLE_FROZEN_ROUTES=1` 一键关闭。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BoundaryError,
  CreateMemoryDraftSchema,
  CreateProposalSchema,
  MEMORY_INJECTION_TITLE_LIMIT,
  ProviderPolicySchema,
  ReviewMemorySchema,
  RunEvaluationSchema,
  RunRoleWorkSchema,
  matchMemory,
  normalizeHost,
  planProviderAttempt,
  targetAllows,
  type MemoryNode,
  type ProviderFault,
  type TaskRecord,
} from "@gongyuai/contracts";
import type { HistoryStore } from "@gongyuai/history";
import type { ControlStore } from "./store.js";
import { simulateRoleWork } from "./roles.js";
import {
  MEMORY_READ_UNAVAILABLE,
  beginMemoryReview,
  memoryReadAllowed,
  memoryReviewEngagementMatches,
  verifiedIdentityFromRequest,
} from "./memory-access.js";
import {
  checkSingleUserBoundary,
  nowIso,
  openTaskHistory,
  readJson,
  sendJson,
  type OpsRouteDeps,
} from "./routes-ops.js";

export function areFrozenRoutesEnabled(): boolean {
  return process.env.GY_DISABLE_FROZEN_ROUTES !== "1";
}

function memoryVisible(
  node: MemoryNode,
  scope: { tenantId: string; engagementId?: string; mode: "tenant" | "engagement" },
  store: ControlStore,
): boolean {
  return node.provenance.some((pointer) => {
    if (scope.mode === "engagement") {
      return scope.engagementId !== undefined && pointer.engagementId === scope.engagementId;
    }
    const task = store.get(pointer.taskId);
    return (task?.tenantId ?? "default") === scope.tenantId;
  });
}

export async function handleFrozenTaskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  _url: URL,
  deps: OpsRouteDeps,
  task: TaskRecord,
  group: string,
  rest: string,
  now: string,
): Promise<boolean> {
  if (!areFrozenRoutesEnabled()) return false;
  const { store, jobs, platform } = deps;
  const taskId = task.id;

  if (group === "graphs" && method === "GET" && rest === "/memory") {
    // 没有可核验身份时不组装图，避免把节点标题放进响应。
    memoryReadAllowed(verifiedIdentityFromRequest());
    return sendJson(res, 403, MEMORY_READ_UNAVAILABLE), true;
  }

  if (group === "roles") {
    if (method === "GET" && rest === "") {
      const history = openTaskHistory(task, true);
      try {
        const list = history.ops
          .listJobs(taskId)
          .filter((job) => job.kind === "role-plan" || job.kind === "role-review");
        return sendJson(res, 200, {
          work: list.map((job) => ({ jobId: job.id, kind: job.kind, status: job.status, result: job.result })),
        }), true;
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
        const history = openTaskHistory(task);
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
        return sendJson(res, 200, {
          role: input.role,
          kind: input.kind,
          output,
          paused: Boolean(paused),
          authenticity: "simulated",
          billing: "none",
        }), true;
      }
      const job = jobs.submit(taskId, {
        kind: input.kind === "plan" ? "role-plan" : "role-review",
        label: `${input.role}:${input.kind}`,
        submittedBy: "operator",
        inputs: [{ path: `ops/roles/${taskId}.json`, sha256: null }],
        options: { role: input.role, kind: input.kind, input: input.input, simulated: true },
      });
      return sendJson(res, 202, { job }), true;
    }
  }

  if (group === "provider") {
    if (method === "GET" && rest === "") {
      const history = openTaskHistory(task, true);
      try {
        const attempts = history
          .listEvents(taskId, 1000)
          .filter((event) => event.kind === "provider_fault_handled")
          .map((event) => ({ id: event.id, at: event.createdAt, ...(event.payload as Record<string, unknown>) }));
        return sendJson(res, 200, { attempts }), true;
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
      if (!body.fault || !body.provider) return sendJson(res, 400, { error: "provider-and-fault-required" }), true;
      const policy = ProviderPolicySchema.parse({
        engagementId: task.engagementId,
        materialDataClass: "customer-material",
        providers: [
          { name: body.provider, priority: 0, allowedDataClasses: ["customer-material"] },
          {
            name: `${body.provider}-fallback`,
            priority: 1,
            allowedDataClasses: body.fallbackAllowed ? ["customer-material"] : [],
          },
        ],
      });
      const plan = planProviderAttempt({
        policy,
        provider: body.provider,
        fault: body.fault,
        attempt: Math.max(0, Number(body.attempt ?? 0)),
        billing: body.billing ?? "none",
      });
      const history = openTaskHistory(task);
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
        return sendJson(res, 200, { plan, duplicateAccounting: duplicate, egressEngagement: task.engagementId }), true;
      } finally {
        history.close();
      }
    }
  }

  if (group === "memory") {
    if (!memoryReadAllowed(verifiedIdentityFromRequest())) {
      return sendJson(res, 403, MEMORY_READ_UNAVAILABLE), true;
    }
    if (method === "POST" && rest === "/inject") {
      const body = (await readJson(req)) as {
        asset?: string;
        familyKey?: string;
        cwes?: string[];
        techniques?: string[];
      };
      const history = openTaskHistory(task);
      try {
        const assets = history.listAssets(taskId);
        const findings = history.listFindings(taskId);
        const intents = history.listIntents(taskId);
        const already = platform.listInjections({ taskId }).map((injection) => injection.memoryId);
        const candidates = platform
          .listNodes({ status: "confirmed" })
          .filter((node) =>
            memoryVisible(node, { tenantId: task.tenantId, engagementId: task.engagementId, mode: "engagement" }, store),
          );
        const matches = matchMemory(
          candidates,
          {
            familyKey: body.familyKey ?? null,
            cwes: body.cwes ?? findings.map((finding) => finding.vulnClass),
            techniques:
              body.techniques ??
              intents.map((intent) => intent.technique).filter((value): value is string => Boolean(value)),
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
          history.recordEvent(taskId, "memory_injected", {
            memoryId: match.node.id,
            hintId: hint.id,
            layer: match.layer,
          });
          return {
            memoryId: match.node.id,
            title: match.node.title,
            layer: match.layer,
            matched: match.matched,
            hintId: hint.id,
            injection,
          };
        });
        return sendJson(res, 200, { injected, considered: candidates.length }), true;
      } finally {
        history.close();
      }
    }
  }

  if (group === "model-request" && method === "POST") {
    // 模拟模型请求：只允许本任务 + 本委托记忆；不调用真实供应商。
    const history = openTaskHistory(task, true);
    try {
      const hints = history.listHints(taskId, 20);
      return sendJson(res, 200, {
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

  return false;
}

export async function handleFrozenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  deps: OpsRouteDeps,
): Promise<boolean> {
  if (!areFrozenRoutesEnabled()) return false;
  const { store, platform } = deps;
  const path = url.pathname;

  const frozenTaskMatch = path.match(/^\/tasks\/([^/]+)\/(roles|provider|model-request|memory)(\/.*)?$/);
  if (frozenTaskMatch) {
    const taskId = decodeURIComponent(frozenTaskMatch[1]!);
    const group = frozenTaskMatch[2]!;
    const rest = frozenTaskMatch[3] ?? "";
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
    try {
      return await handleFrozenTaskRoute(req, res, method, url, deps, task, group, rest, nowIso(url));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, error instanceof BoundaryError ? 403 : 400, { error: message });
      return true;
    }
  }

  const tenantParam = url.searchParams.get("tenantId") ?? undefined;
  const engagementParam = url.searchParams.get("engagementId") ?? undefined;
  const tenantId = tenantParam ?? "default";
  const engagementId = engagementParam;
  // 未声明上下文 = 单用户本地工作台，不做额外限制；仅在显式声明时校验隔离。
  const visible = (node: MemoryNode): boolean =>
    tenantParam === undefined && engagementParam === undefined
      ? true
      : memoryVisible(node, { tenantId, engagementId, mode: engagementParam ? "engagement" : "tenant" }, store);

  try {
    if (path.startsWith("/memory/nodes") && method === "GET") {
      if (!memoryReadAllowed(verifiedIdentityFromRequest())) {
        return sendJson(res, 403, MEMORY_READ_UNAVAILABLE), true;
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
      return sendJson(res, 200, { nodes }), true;
    }
    if (path === "/memory/nodes" && method === "POST") {
      const input = CreateMemoryDraftSchema.parse(await readJson(req));
      const node = platform.createDraft(input, new Date().toISOString());
      return sendJson(res, 201, { node }), true;
    }
    const nodeMatch = path.match(/^\/memory\/nodes\/([^/]+)(\/.*)?$/);
    if (nodeMatch) {
      const id = decodeURIComponent(nodeMatch[1]!);
      const action = nodeMatch[2] ?? "";
      if (method === "POST" && action === "/review") {
        const gate = beginMemoryReview(verifiedIdentityFromRequest(req));
        if (!gate.proceed) return sendJson(res, gate.status, gate.body), true;
        const ownership = platform.memoryOwnership(id);
        if (!ownership) return sendJson(res, 404, { error: "memory-not-found" }), true;
        if (!memoryReviewEngagementMatches(ownership, gate.identity)) {
          return sendJson(res, 403, { error: "engagement-mismatch" }), true;
        }
        const input = ReviewMemorySchema.parse(await readJson(req));
        const updated = platform.reviewNode(id, input, new Date().toISOString());
        return sendJson(res, 200, { node: updated }), true;
      }
      const node = platform.getNode(id);
      if (!node) return sendJson(res, 404, { error: "memory-not-found" }), true;
      if (!visible(node)) {
        return sendJson(res, 403, { error: "engagement-mismatch" }), true;
      }
      if (method === "GET" && action === "") return sendJson(res, 200, { node }), true;
      if (method === "GET" && action === "/references") {
        return sendJson(res, 200, { references: platform.referencesFor(id) }), true;
      }
      if (method === "GET" && action === "/events") {
        return sendJson(res, 200, { events: platform.listMemoryEvents(id) }), true;
      }
    }

    if (path === "/archive/contact" && method === "GET") {
      const targets = (url.searchParams.get("targets") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (targets.length === 0) return sendJson(res, 400, { error: "targets-required" }), true;
      const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20));
      const hits: unknown[] = [];
      for (const task of store.list()) {
        if ((task.tenantId ?? "default") !== tenantId) continue;
        if (hits.length >= limit) break;
        let history: HistoryStore;
        try {
          history = openTaskHistory(task, true);
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
            sameAsset: matched.some((asset) =>
              findings.some((finding) => normalizeHost(finding.asset) === normalizeHost(asset.address)),
            ),
          });
        } finally {
          history.close();
        }
      }
      return sendJson(res, 200, {
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
      return sendJson(res, 200, { proposals }), true;
    }
    if (path === "/proposals" && method === "POST") {
      const input = CreateProposalSchema.parse(await readJson(req));
      const proposal = platform.createProposal(input, new Date().toISOString());
      return sendJson(res, 201, { proposal }), true;
    }
    const proposalMatch = path.match(/^\/proposals\/([^/]+)(\/.*)?$/);
    if (proposalMatch) {
      const id = decodeURIComponent(proposalMatch[1]!);
      const action = proposalMatch[2] ?? "";
      const proposal = platform.getProposal(id);
      if (!proposal) return sendJson(res, 404, { error: "proposal-not-found" }), true;
      if (method === "GET" && action === "") return sendJson(res, 200, { proposal }), true;
      if (method === "POST" && action === "/decide") {
        const body = (await readJson(req)) as { decision?: "approve" | "reject"; decidedBy?: string; reason?: string };
        if (!body.decision || !body.decidedBy) return sendJson(res, 400, { error: "decision-and-decidedBy-required" }), true;
        const updated = platform.decideProposal(
          id,
          { decision: body.decision, decidedBy: body.decidedBy, reason: body.reason ?? "" },
          new Date().toISOString(),
        );
        return sendJson(res, 200, { proposal: updated }), true;
      }
      if (method === "POST" && action === "/promote") {
        const body = (await readJson(req)) as { promotedBy?: string; evaluationRunId?: string };
        if (!body.promotedBy || !body.evaluationRunId) {
          return sendJson(res, 400, { error: "promotedBy-and-evaluationRunId-required" }), true;
        }
        const updated = platform.promoteProposal(
          id,
          { promotedBy: body.promotedBy, evaluationRunId: body.evaluationRunId },
          new Date().toISOString(),
        );
        return sendJson(res, 200, { proposal: updated }), true;
      }
      if (method === "POST" && action === "/rollback") {
        const body = (await readJson(req)) as { rolledBackBy?: string; reason?: string };
        if (!body.rolledBackBy) return sendJson(res, 400, { error: "rolledBackBy-required" }), true;
        const updated = platform.rollbackProposal(
          id,
          { rolledBackBy: body.rolledBackBy, reason: body.reason ?? "" },
          new Date().toISOString(),
        );
        return sendJson(res, 200, { proposal: updated }), true;
      }
      if (method === "GET" && action === "/events") {
        return sendJson(res, 200, { events: platform.listProposalEvents(id) }), true;
      }
    }

    if (path === "/evaluations" && method === "GET") {
      return sendJson(res, 200, {
        evaluations: platform.listEvaluations({
          ...(url.searchParams.get("suite") ? { suite: url.searchParams.get("suite")! } : {}),
          ...(url.searchParams.get("group") ? { group: url.searchParams.get("group")! } : {}),
        }),
      }), true;
    }
    if (path === "/evaluations" && method === "POST") {
      const input = RunEvaluationSchema.parse(await readJson(req));
      const run = platform.recordEvaluation(input, new Date().toISOString());
      return sendJson(res, 201, { evaluation: run }), true;
    }
    const evalMatch = path.match(/^\/evaluations\/([^/]+)$/);
    if (evalMatch && method === "GET") {
      const run = platform.getEvaluation(decodeURIComponent(evalMatch[1]!));
      if (!run) return sendJson(res, 404, { error: "evaluation-not-found" }), true;
      return sendJson(res, 200, { evaluation: run }), true;
    }

    if (path === "/trends" && method === "GET") {
      const points: Array<Record<string, unknown>> = [];
      for (const task of store.list()) {
        if ((task.tenantId ?? "default") !== tenantId) continue;
        if (engagementId && task.engagementId !== engagementId) continue;
        let history: HistoryStore;
        try {
          history = openTaskHistory(task, true);
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
      return sendJson(res, 200, {
        points,
        note: "只报可复核计数；样本不足时不宣称趋势显著。",
      }), true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }

  return false;
}
