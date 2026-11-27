/**
 * Attack Surface & Tactical Intelligence sub-store:
 * Assets (Fact projection), HTTP transactions, Foothold host profiles,
 * OAST tokens/hits, Credentials (pointer-only), and Plan steps.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AssetKind,
  AssetRecord,
  AssetSource,
  AuthScope,
  Credential,
  CredentialKind,
  CredentialTier,
  Fact,
  HostProfile,
  HostProfileDraftInput,
  HttpTransaction,
  OastHit,
  OastToken,
  PlanStep,
  PlanStepDraftInput,
} from "@gongyuai/contracts";
import {
  ASSET_KIND_RANK,
  ASSET_TAG,
  admitAddress,
  assetAddrTag,
  assetTags,
  credentialTierUpgrades,
  defaultCredentialTier,
  normalizeEndpointAddress,
  normalizeHost,
  normalizeServiceAddress,
  normalizeTargetPattern,
  parseAssetAddrFromTags,
  parseAssetKindFromTags,
  parseAssetParentFromTags,
  parseAssetSourceFromTags,
  parseAssetTypeFromTags,
  parseAssetWeightFromTags,
  type AssetType,
} from "@gongyuai/contracts";
import type { HistoryDomainDeps, HistoryRow } from "./context.js";
import { readEvidenceBytes } from "./evidence.js";

export class SurfaceIntelStore {
  constructor(private readonly deps: HistoryDomainDeps) {}

  seedAssetsFromAuth(taskId: string, auth: Pick<AuthScope, "targets">): Fact[] {
    const written: Fact[] = [];
    for (const raw of auth.targets) {
      const address = normalizeTargetPattern(raw);
      if (!address) continue;
      const existing = this.findAssetFact(taskId, address);
      if (existing) continue;
      written.push(
        this.deps.appendFact({
          taskId,
          layer: "title",
          title: `资产 · seed · ${address}`,
          summary: `授权靶标（auth.targets）：${raw.trim()}`,
          tags: assetTags({ kind: "seed", address, source: "auth" }),
        }),
      );
    }
    return written;
  }

  recordAsset(input: {
    taskId: string;
    address: string;
    auth: Pick<AuthScope, "targets" | "outOfScope" | "pivotPolicy">;
    kind?: AssetKind;
    source?: AssetSource;
    summary?: string;
    intentId?: string | null;
    live?: boolean;
    assetType?: AssetType | null;
    parentAddress?: string | null;
    weight?: number;
  }): { fact: Fact; asset: AssetRecord; created: boolean } {
    const rawAddress = input.address.trim();
    const address =
      input.assetType === "endpoint"
        ? normalizeEndpointAddress(rawAddress)
        : input.assetType === "service"
          ? normalizeServiceAddress(rawAddress)
          : normalizeTargetPattern(rawAddress) || rawAddress.toLowerCase();
    if (!address) throw new Error("asset address required");
    const scopeHost = normalizeHost(rawAddress) || rawAddress;

    let kind: AssetKind =
      input.kind ??
      admitAddress(
        { targets: input.auth.targets, outOfScope: input.auth.outOfScope, pivotPolicy: input.auth.pivotPolicy },
        scopeHost,
      ).kind;
    if (input.live) {
      const gate = admitAddress(
        { targets: input.auth.targets, outOfScope: input.auth.outOfScope, pivotPolicy: input.auth.pivotPolicy },
        scopeHost,
      );
      if (gate.kind === "oos") kind = "oos";
      else kind = "live";
    }

    const source: AssetSource = input.source ?? "discover";
    const current = this.listAssets(input.taskId).find((a) => a.address === address);
    if (current && ASSET_KIND_RANK[current.kind] >= ASSET_KIND_RANK[kind]) {
      return {
        fact: this.deps.getFact(input.taskId, current.factId)!,
        asset: current,
        created: false,
      };
    }

    const admission = admitAddress(
      { targets: input.auth.targets, outOfScope: input.auth.outOfScope, pivotPolicy: input.auth.pivotPolicy },
      scopeHost,
    );
    const summary =
      input.summary ??
      (kind === "oos"
        ? `范围外（未匹配 auth.targets）`
        : kind === "live"
          ? `已核实存活 · 匹配 ${admission.matchedBy ?? "auth.targets"}`
          : `自动准入 · 匹配 ${admission.matchedBy ?? "auth.targets"}`);

    const fact = this.deps.appendFact({
      taskId: input.taskId,
      layer: "title",
      title: `资产 · ${kind}${input.assetType ? ` · ${input.assetType}` : ""} · ${address}`,
      summary,
      tags: assetTags({
        kind,
        address,
        source,
        ...(input.assetType ? { assetType: input.assetType } : {}),
        ...(input.parentAddress ? { parentAddress: input.parentAddress } : {}),
        ...(typeof input.weight === "number" ? { weight: input.weight } : {}),
      }),
      intentId: this.deps.resolveIntentIdForWrite(input.taskId, input.intentId),
    });
    return {
      fact,
      asset: this.factToAsset(fact)!,
      created: true,
    };
  }

  listAssets(taskId: string): AssetRecord[] {
    const byAddr = new Map<string, AssetRecord>();
    for (const fact of this.deps.listFacts(taskId)) {
      if (!fact.tags.includes(ASSET_TAG)) continue;
      const asset = this.factToAsset(fact);
      if (!asset) continue;
      const prev = byAddr.get(asset.address);
      if (!prev || ASSET_KIND_RANK[asset.kind] > ASSET_KIND_RANK[prev.kind]) {
        byAddr.set(asset.address, asset);
      } else if (
        prev &&
        ASSET_KIND_RANK[asset.kind] === ASSET_KIND_RANK[prev.kind] &&
        asset.createdAt > prev.createdAt
      ) {
        byAddr.set(asset.address, asset);
      }
    }
    return [...byAddr.values()].sort((a, b) => a.address.localeCompare(b.address));
  }

  private findAssetFact(taskId: string, address: string): Fact | null {
    const needle = `asset.addr:${address}`;
    for (const fact of this.deps.listFacts(taskId)) {
      if (fact.tags.includes(ASSET_TAG) && fact.tags.includes(needle)) return fact;
    }
    return null;
  }

  factToAsset(fact: Fact): AssetRecord | null {
    const kind = parseAssetKindFromTags(fact.tags);
    const address = parseAssetAddrFromTags(fact.tags);
    if (!kind || !address) return null;
    return {
      address,
      kind,
      assetType: parseAssetTypeFromTags(fact.tags),
      parentAddress: parseAssetParentFromTags(fact.tags),
      weight: parseAssetWeightFromTags(fact.tags),
      factId: fact.id,
      title: fact.title,
      summary: fact.summary,
      source: parseAssetSourceFromTags(fact.tags),
      createdAt: fact.createdAt,
      intentId: fact.intentId,
    };
  }

  /* --------------------------- HTTP Transactions --------------------------- */

  recordHttpTransaction(
    input: Omit<HttpTransaction, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): { transaction: HttpTransaction; created: boolean } {
    if (input.intentId && !this.deps.getIntent(input.taskId, input.intentId)) {
      throw new Error(`unknown http transaction intent: ${input.intentId}`);
    }
    const existing = this.listHttpTransactions(input.taskId, 500).find(
      (tx) =>
        tx.method === input.method &&
        tx.url === input.url &&
        tx.requestSha256 === input.requestSha256 &&
        tx.responseSha256 === input.responseSha256,
    );
    if (existing) return { transaction: existing, created: false };
    const transaction: HttpTransaction = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      intentId: input.intentId ?? null,
      method: input.method,
      url: input.url,
      host: input.host,
      path: input.path,
      status: input.status,
      requestSha256: input.requestSha256,
      responseSha256: input.responseSha256,
      requestPath: input.requestPath,
      responsePath: input.responsePath,
      requestBytes: input.requestBytes,
      responseBytes: input.responseBytes,
      responseHead: input.responseHead ?? "",
      truncated: Boolean(input.truncated),
      redirects: input.redirects ?? [],
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      note: input.note ?? "",
    };
    this.deps.db
      .prepare(
        `INSERT INTO http_transactions
          (id, task_id, intent_id, method, url, host, path, status, request_sha256, response_sha256,
           request_path, response_path, request_bytes, response_bytes, response_head, truncated,
           redirects_json, started_at, duration_ms, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transaction.id,
        transaction.taskId,
        transaction.intentId,
        transaction.method,
        transaction.url,
        transaction.host,
        transaction.path,
        transaction.status,
        transaction.requestSha256,
        transaction.responseSha256,
        transaction.requestPath,
        transaction.responsePath,
        transaction.requestBytes,
        transaction.responseBytes,
        transaction.responseHead,
        transaction.truncated ? 1 : 0,
        JSON.stringify(transaction.redirects),
        transaction.startedAt,
        transaction.durationMs,
        transaction.note,
        input.createdAt ?? this.deps.now(),
      );
    this.deps.emit(input.taskId, "http_transaction_recorded", {
      transactionId: transaction.id,
      method: transaction.method,
      host: transaction.host,
      status: transaction.status,
    });
    return { transaction, created: true };
  }

  listHttpTransactions(taskId: string, limit = 50): HttpTransaction[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM http_transactions WHERE task_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(taskId, limit) as HistoryRow[];
    return rows.map((row) => this.rowToHttpTransaction(row));
  }

  getHttpTransaction(taskId: string, id: string): HttpTransaction | null {
    const row = this.deps.db
      .prepare("SELECT * FROM http_transactions WHERE task_id = ? AND id = ?")
      .get(taskId, id) as HistoryRow | undefined;
    return row ? this.rowToHttpTransaction(row) : null;
  }

  resolveEvidenceRef(
    taskId: string,
    ref: string,
  ): { path: string; sha256: string; content: Buffer } | null {
    if (ref.startsWith("http:")) {
      const id = ref.slice("http:".length);
      const tx = this.getHttpTransaction(taskId, id);
      if (!tx) throw new Error(`unknown http transaction ref: ${ref}`);
      const content = readEvidenceBytes(this.deps.evidenceDir, tx.responsePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      if (sha256 !== tx.responseSha256) {
        throw new Error(`http transaction ${id} response hash mismatch (evidence changed)`);
      }
      return { path: ref, sha256, content };
    }
    if (ref.startsWith("oast:")) {
      const token = ref.slice("oast:".length);
      if (!this.getOastToken(taskId, token)) throw new Error(`unknown oast token ref: ${ref}`);
      const hits = this.listOastHits(taskId, token);
      if (!hits.length) {
        throw new Error(`oast ref has no hit yet: ${ref}（命中才能作证据）`);
      }
      const content = Buffer.from(JSON.stringify({ token, hits }, null, 2), "utf8");
      return { path: ref, sha256: createHash("sha256").update(content).digest("hex"), content };
    }
    return null;
  }

  private rowToHttpTransaction(row: HistoryRow): HttpTransaction {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      intentId: row.intent_id === null || row.intent_id === undefined ? null : String(row.intent_id),
      method: String(row.method),
      url: String(row.url),
      host: String(row.host),
      path: String(row.path),
      status: Number(row.status),
      requestSha256: String(row.request_sha256),
      responseSha256: String(row.response_sha256),
      requestPath: String(row.request_path),
      responsePath: String(row.response_path),
      requestBytes: Number(row.request_bytes),
      responseBytes: Number(row.response_bytes),
      responseHead: String(row.response_head ?? ""),
      truncated: Number(row.truncated ?? 0) === 1,
      redirects: JSON.parse(String(row.redirects_json ?? "[]")) as string[],
      startedAt: String(row.started_at),
      durationMs: Number(row.duration_ms),
      note: String(row.note ?? ""),
    };
  }

  /* --------------------------- Host Profiles --------------------------- */

  recordHostProfile(taskId: string, draft: HostProfileDraftInput): HostProfile {
    const asset = normalizeTargetPattern(draft.asset) || draft.asset.trim().toLowerCase();
    if (!asset) throw new Error("host profile asset required");
    const now = this.deps.now();
    const existing = this.getHostProfile(taskId, asset);
    const profile: HostProfile = {
      id: existing?.id ?? randomUUID(),
      taskId,
      asset,
      hostname: draft.hostname?.trim() || null,
      os: draft.os?.trim() || null,
      domain: draft.domain?.trim() || null,
      users: [...new Set((draft.users ?? []).map((v) => v.trim()).filter(Boolean))],
      privileges: [...new Set((draft.privileges ?? []).map((v) => v.trim()).filter(Boolean))],
      services: [...new Set((draft.services ?? []).map((v) => v.trim()).filter(Boolean))],
      shares: [...new Set((draft.shares ?? []).map((v) => v.trim()).filter(Boolean))],
      av: [...new Set((draft.av ?? []).map((v) => v.trim()).filter(Boolean))],
      evidencePath: draft.evidencePath?.trim() || null,
      source: draft.source?.trim() || "worker",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.deps.db
      .prepare(
        `INSERT INTO host_profiles
          (id, task_id, asset, hostname, os, domain, users_json, privileges_json, services_json,
           shares_json, av_json, evidence_path, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, asset) DO UPDATE SET
           hostname = excluded.hostname, os = excluded.os, domain = excluded.domain,
           users_json = excluded.users_json, privileges_json = excluded.privileges_json,
           services_json = excluded.services_json, shares_json = excluded.shares_json,
           av_json = excluded.av_json, evidence_path = excluded.evidence_path,
           source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        profile.id,
        taskId,
        asset,
        profile.hostname,
        profile.os,
        profile.domain,
        JSON.stringify(profile.users),
        JSON.stringify(profile.privileges),
        JSON.stringify(profile.services),
        JSON.stringify(profile.shares),
        JSON.stringify(profile.av),
        profile.evidencePath,
        profile.source,
        profile.createdAt,
        profile.updatedAt,
      );
    this.deps.emit(taskId, "host_profile_recorded", {
      profileId: profile.id,
      asset,
      users: profile.users.length,
      privileges: profile.privileges.length,
    });
    return profile;
  }

  getHostProfile(taskId: string, asset: string): HostProfile | null {
    const row = this.deps.db
      .prepare("SELECT * FROM host_profiles WHERE task_id = ? AND asset = ?")
      .get(taskId, normalizeTargetPattern(asset) || asset.trim().toLowerCase()) as HistoryRow | undefined;
    return row ? this.rowToHostProfile(row) : null;
  }

  listHostProfiles(taskId: string): HostProfile[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM host_profiles WHERE task_id = ? ORDER BY updated_at DESC")
      .all(taskId) as HistoryRow[];
    return rows.map((row) => this.rowToHostProfile(row));
  }

  private rowToHostProfile(row: HistoryRow): HostProfile {
    const parseList = (raw: unknown): string[] => {
      try {
        const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    };
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      asset: String(row.asset),
      hostname: row.hostname === null || row.hostname === undefined ? null : String(row.hostname),
      os: row.os === null || row.os === undefined ? null : String(row.os),
      domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
      users: parseList(row.users_json),
      privileges: parseList(row.privileges_json),
      services: parseList(row.services_json),
      shares: parseList(row.shares_json),
      av: parseList(row.av_json),
      evidencePath:
        row.evidence_path === null || row.evidence_path === undefined ? null : String(row.evidence_path),
      source: String(row.source ?? "worker"),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /* --------------------------- Plan Steps --------------------------- */

  setPlan(taskId: string, drafts: PlanStepDraftInput[]): PlanStep[] {
    if (!drafts.length) throw new Error("plan_set requires at least one step");
    if (drafts.length > 20) throw new Error("plan_set accepts at most 20 steps");
    for (const draft of drafts) {
      for (const id of draft.needsFactIds ?? []) {
        if (!this.deps.getFact(taskId, id)) throw new Error(`plan needs unknown fact: ${id}`);
      }
      for (const id of draft.needsIntentIds ?? []) {
        if (!this.deps.getIntent(taskId, id)) throw new Error(`plan needs unknown intent: ${id}`);
      }
      for (const id of draft.needsFindingIds ?? []) {
        if (!this.deps.getFinding(taskId, id)) throw new Error(`plan needs unknown finding: ${id}`);
      }
    }
    const now = this.deps.now();
    this.deps.db.exec("BEGIN IMMEDIATE");
    try {
      this.deps.db.prepare("DELETE FROM plan_steps WHERE task_id = ?").run(taskId);
      drafts.forEach((draft, ord) => {
        this.deps.db
          .prepare(
            `INSERT INTO plan_steps
              (id, task_id, ord, title, summary, needs_fact_ids_json, needs_intent_ids_json,
               needs_finding_ids_json, status, intent_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
          )
          .run(
            randomUUID(),
            taskId,
            ord,
            draft.title,
            draft.summary ?? "",
            JSON.stringify(draft.needsFactIds ?? []),
            JSON.stringify(draft.needsIntentIds ?? []),
            JSON.stringify(draft.needsFindingIds ?? []),
            now,
          );
      });
      this.deps.emit(taskId, "plan_updated", { steps: drafts.length, action: "set" });
      this.deps.db.exec("COMMIT");
    } catch (err) {
      this.deps.db.exec("ROLLBACK");
      throw err;
    }
    return this.listPlan(taskId);
  }

  listPlan(taskId: string): PlanStep[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM plan_steps WHERE task_id = ? ORDER BY ord")
      .all(taskId) as HistoryRow[];
    return rows.map((row) => {
      const needsFactIds = JSON.parse(String(row.needs_fact_ids_json ?? "[]")) as string[];
      const needsIntentIds = JSON.parse(String(row.needs_intent_ids_json ?? "[]")) as string[];
      const needsFindingIds = JSON.parse(String(row.needs_finding_ids_json ?? "[]")) as string[];
      const stored = String(row.status ?? "pending");
      const intentId = row.intent_id === null || row.intent_id === undefined ? null : String(row.intent_id);
      let status = stored as PlanStep["status"];
      if (intentId) {
        const intent = this.deps.getIntent(taskId, intentId);
        if (intent?.status === "succeeded") status = "done";
        else if (intent && ["failed", "expired"].includes(intent.status)) status = "ready";
        else status = "dispatched";
      } else if (status === "pending" || status === "ready") {
        status = this.planDepsSatisfied(taskId, needsFactIds, needsIntentIds, needsFindingIds)
          ? "ready"
          : "pending";
      }
      return {
        id: String(row.id),
        taskId,
        ord: Number(row.ord),
        title: String(row.title),
        summary: String(row.summary ?? ""),
        needsFactIds,
        needsIntentIds,
        needsFindingIds,
        status,
        intentId,
        updatedAt: String(row.updated_at),
      };
    });
  }

  updatePlanStep(taskId: string, stepId: string, patch: { title?: string; summary?: string }): PlanStep {
    const existing = this.listPlan(taskId).find((step) => step.id === stepId);
    if (!existing) throw new Error(`unknown plan step: ${stepId}`);
    const title = patch.title?.trim() || existing.title;
    const summary = patch.summary !== undefined ? patch.summary.trim() : existing.summary;
    this.deps.db
      .prepare("UPDATE plan_steps SET title = ?, summary = ?, updated_at = ? WHERE task_id = ? AND id = ?")
      .run(title, summary, this.deps.now(), taskId, stepId);
    this.deps.emit(taskId, "plan_updated", { stepId, action: "update" });
    return this.listPlan(taskId).find((step) => step.id === stepId)!;
  }

  nextPlanStep(taskId: string): PlanStep | null {
    return this.listPlan(taskId).find((step) => step.status === "ready") ?? null;
  }

  assertPlanAllows(
    taskId: string,
    planStepId?: string | null,
    opts?: { sourceFactIds?: readonly string[]; untouchedAssetRoot?: boolean },
  ): void {
    const steps = this.listPlan(taskId);
    if (!steps.length) {
      if (planStepId) throw new Error(`unknown plan step: ${planStepId}`);
      return;
    }
    if (!planStepId && steps.every((step) => step.status === "done")) return;
    if (planStepId) {
      const step = steps.find((entry) => entry.id === planStepId);
      if (!step) throw new Error(`unknown plan step: ${planStepId}`);
      if (step.status !== "ready") {
        throw new Error(`plan step ${planStepId} is ${step.status}, not ready (deps unmet)`);
      }
      return;
    }
    // Sliding-window dispatch on a newly admitted, untouched host (0 prior Intents)
    // must not be blocked by leftover plan steps belonging to an earlier host/surface,
    // provided none of the ready steps explicitly depend on this proposal's source facts.
    if (opts?.untouchedAssetRoot) {
      const srcSet = new Set(opts.sourceFactIds ?? []);
      const overlapsReadyStep = steps.some(
        (step) => step.status === "ready" && step.needsFactIds.some((fid) => srcSet.has(fid)),
      );
      if (!overlapsReadyStep) return;
    }
    const ready = steps.find((step) => step.status === "ready");
    if (ready) {
      throw new Error(
        `task has a ready plan step ${ready.id} ("${ready.title}"); pass planStepId or clear the plan with plan_set`,
      );
    }
    throw new Error("task has a plan but no ready step; wait for deps or update the plan");
  }

  markPlanStepDispatched(taskId: string, stepId: string, intentId: string): void {
    const row = this.deps.db
      .prepare("SELECT id FROM plan_steps WHERE task_id = ? AND id = ?")
      .get(taskId, stepId) as HistoryRow | undefined;
    if (!row) return;
    this.deps.db
      .prepare(
        "UPDATE plan_steps SET status = 'dispatched', intent_id = ?, updated_at = ? WHERE task_id = ? AND id = ?",
      )
      .run(intentId, this.deps.now(), taskId, stepId);
  }

  private planDepsSatisfied(
    taskId: string,
    factIds: string[],
    intentIds: string[],
    findingIds: string[],
  ): boolean {
    for (const id of factIds) if (!this.deps.getFact(taskId, id)) return false;
    for (const id of intentIds) {
      const intent = this.deps.getIntent(taskId, id);
      if (!intent || !["succeeded", "failed", "expired"].includes(intent.status)) return false;
    }
    for (const id of findingIds) {
      const finding = this.deps.getFinding(taskId, id);
      if (!finding || !["verified", "retested", "accepted"].includes(finding.status)) return false;
    }
    return true;
  }

  /* --------------------------- OAST --------------------------- */

  recordOastToken(input: {
    token: string;
    taskId: string;
    kind: "http" | "dns";
    callback: string;
    note?: string;
    issuedAt?: string;
    expiresAt: string;
  }): OastToken {
    const token = input.token.trim();
    if (!/^[a-z0-9]{8,64}$/i.test(token)) throw new Error("oast token must be 8-64 alphanumerics");
    const issuedAt = input.issuedAt ?? this.deps.now();
    this.deps.db
      .prepare(
        `INSERT INTO oast_tokens (token, task_id, kind, callback, note, issued_at, expires_at, hits)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(token) DO NOTHING`,
      )
      .run(token, input.taskId, input.kind, input.callback, input.note ?? "", issuedAt, input.expiresAt);
    this.deps.emit(input.taskId, "oast_token_issued", { token, kind: input.kind });
    return this.getOastToken(input.taskId, token)!;
  }

  getOastToken(taskId: string, token: string): OastToken | null {
    const row = this.deps.db
      .prepare("SELECT * FROM oast_tokens WHERE task_id = ? AND token = ?")
      .get(taskId, token) as HistoryRow | undefined;
    return row ? this.rowToOastToken(row) : null;
  }

  listOastTokens(taskId: string): OastToken[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM oast_tokens WHERE task_id = ? ORDER BY issued_at")
      .all(taskId) as HistoryRow[];
    return rows.map((row) => this.rowToOastToken(row));
  }

  recordOastHit(
    taskId: string,
    input: {
      token: string;
      at?: string;
      sourceIp?: string;
      method?: string;
      path?: string;
      userAgent?: string;
      protocol?: "http" | "dns";
    },
  ): OastHit {
    const token = this.getOastToken(taskId, input.token);
    if (!token) throw new Error(`unknown oast token: ${input.token}`);
    const hit: OastHit = {
      token: input.token,
      taskId,
      at: input.at ?? this.deps.now(),
      sourceIp: input.sourceIp ?? "",
      method: input.method ?? "",
      path: input.path ?? "",
      userAgent: input.userAgent ?? "",
      protocol: input.protocol ?? "http",
    };
    this.deps.db
      .prepare(
        `INSERT INTO oast_hits (id, token, task_id, at, source_ip, method, path, user_agent, protocol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        hit.token,
        taskId,
        hit.at,
        hit.sourceIp,
        hit.method,
        hit.path,
        hit.userAgent,
        hit.protocol,
      );
    this.deps.db
      .prepare("UPDATE oast_tokens SET hits = hits + 1 WHERE task_id = ? AND token = ?")
      .run(taskId, hit.token);
    this.deps.emit(taskId, "oast_hit", {
      token: hit.token,
      sourceIp: hit.sourceIp,
      path: hit.path,
      protocol: hit.protocol,
    });
    return hit;
  }

  listOastHits(taskId: string, token?: string): OastHit[] {
    const rows = token
      ? this.deps.db.prepare("SELECT * FROM oast_hits WHERE task_id = ? AND token = ? ORDER BY at").all(taskId, token)
      : this.deps.db.prepare("SELECT * FROM oast_hits WHERE task_id = ? ORDER BY at").all(taskId);
    return (rows as HistoryRow[]).map((row) => ({
      token: String(row.token),
      taskId: String(row.task_id),
      at: String(row.at),
      sourceIp: String(row.source_ip ?? ""),
      method: String(row.method ?? ""),
      path: String(row.path ?? ""),
      userAgent: String(row.user_agent ?? ""),
      protocol: String(row.protocol ?? "http") as "http" | "dns",
    }));
  }

  private rowToOastToken(row: HistoryRow): OastToken {
    return {
      token: String(row.token),
      taskId: String(row.task_id),
      kind: String(row.kind) as "http" | "dns",
      callback: String(row.callback),
      note: String(row.note ?? ""),
      issuedAt: String(row.issued_at),
      expiresAt: String(row.expires_at),
      hits: Number(row.hits ?? 0),
    };
  }

  /* --------------------------- Credentials --------------------------- */

  recordCredential(input: {
    taskId: string;
    kind: CredentialKind;
    asset: string;
    username?: string | null;
    secretRef: string;
    secretHmac?: string | null;
    sourceFindingId?: string | null;
    verified?: boolean;
    expiresAt?: string | null;
    tier?: CredentialTier;
    impactSummary?: string | null;
    intentId?: string | null;
  }): { credential: Credential; created: boolean } {
    const asset = normalizeTargetPattern(input.asset) || input.asset.trim().toLowerCase();
    if (!asset) throw new Error("credential asset required");
    const secretRef = input.secretRef.trim();
    if (!secretRef) throw new Error("credential secretRef required (pointer, not plaintext)");
    if (input.sourceFindingId && !this.deps.getFinding(input.taskId, input.sourceFindingId)) {
      throw new Error(`unknown credential source finding: ${input.sourceFindingId}`);
    }
    const username = input.username?.trim() || null;
    const existing = this.listCredentials(input.taskId).find(
      (row) =>
        row.kind === input.kind &&
        row.asset === asset &&
        (row.username ?? null) === username &&
        row.secretRef === secretRef,
    );
    if (existing) {
      const patch: { tier?: CredentialTier; impactSummary?: string | null } = {};
      if (input.tier && credentialTierUpgrades(existing.tier, input.tier)) patch.tier = input.tier;
      if (input.impactSummary !== undefined) {
        const next = input.impactSummary?.trim() || null;
        if (next !== existing.impactSummary) patch.impactSummary = next;
      }
      if (patch.tier || patch.impactSummary !== undefined) {
        return { credential: this.updateCredential(input.taskId, existing.id, patch), created: false };
      }
      return { credential: existing, created: false };
    }

    const now = this.deps.now();
    const credentialId = randomUUID();
    const fact = this.deps.appendFact({
      taskId: input.taskId,
      layer: "title",
      title: `凭据 · ${input.kind} · ${asset}`,
      summary: `${username ? `user=${username} · ` : ""}secret 不入图（按 credential_list 的 secretRef 读取）`,
      tags: ["credential", `credential.id:${credentialId}`, assetAddrTag(asset)],
      intentId: this.deps.resolveIntentIdForWrite(input.taskId, input.intentId),
    });
    const credential: Credential = {
      id: credentialId,
      taskId: input.taskId,
      kind: input.kind,
      asset,
      username,
      secretRef,
      secretHmac: input.secretHmac?.trim().toLowerCase() || null,
      sourceFindingId: input.sourceFindingId ?? null,
      factId: fact.id,
      verifiedAt: input.verified ? now : null,
      lastUsedAt: null,
      reuseCount: 0,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      tier: defaultCredentialTier({ tier: input.tier, verified: input.verified === true }),
      impactSummary: input.impactSummary?.trim() || null,
    };
    this.deps.db
      .prepare(
        `INSERT INTO credentials
          (id, task_id, kind, asset, username, secret_ref, secret_hmac, source_finding_id,
           fact_id, verified_at, last_used_at, reuse_count, expires_at, created_at,
           tier, impact_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        credential.id,
        credential.taskId,
        credential.kind,
        credential.asset,
        credential.username,
        credential.secretRef,
        credential.secretHmac,
        credential.sourceFindingId,
        credential.factId,
        credential.verifiedAt,
        null,
        0,
        credential.expiresAt,
        credential.createdAt,
        credential.tier,
        credential.impactSummary,
      );
    this.deps.emit(input.taskId, "credential_recorded", {
      credentialId: credential.id,
      factId: credential.factId,
      kind: credential.kind,
      asset: credential.asset,
      verified: Boolean(credential.verifiedAt),
    });
    return { credential, created: true };
  }

  listCredentials(taskId: string): Credential[] {
    const rows = this.deps.db
      .prepare("SELECT * FROM credentials WHERE task_id = ? ORDER BY created_at")
      .all(taskId) as HistoryRow[];
    return rows.map((row) => this.rowToCredential(row));
  }

  getCredential(taskId: string, credentialId: string): Credential | null {
    const row = this.deps.db
      .prepare("SELECT * FROM credentials WHERE task_id = ? AND id = ?")
      .get(taskId, credentialId) as HistoryRow | undefined;
    return row ? this.rowToCredential(row) : null;
  }

  touchCredential(taskId: string, credentialId: string): Credential {
    const current = this.getCredential(taskId, credentialId);
    if (!current) throw new Error(`unknown credential: ${credentialId}`);
    const now = this.deps.now();
    this.deps.db
      .prepare(
        "UPDATE credentials SET reuse_count = reuse_count + 1, last_used_at = ? WHERE task_id = ? AND id = ?",
      )
      .run(now, taskId, credentialId);
    this.deps.emit(taskId, "credential_reused", { credentialId, asset: current.asset });
    return this.getCredential(taskId, credentialId)!;
  }

  updateCredential(
    taskId: string,
    credentialId: string,
    patch: { tier?: CredentialTier; impactSummary?: string | null },
  ): Credential {
    const current = this.getCredential(taskId, credentialId);
    if (!current) throw new Error(`unknown credential: ${credentialId}`);
    if (patch.tier && patch.tier !== "L1" && patch.tier !== "L2" && patch.tier !== "L3") {
      throw new Error(`invalid credential tier: ${patch.tier}`);
    }
    const tier = patch.tier ?? current.tier;
    const impactSummary =
      patch.impactSummary === undefined
        ? current.impactSummary
        : patch.impactSummary?.trim() || null;
    this.deps.db
      .prepare("UPDATE credentials SET tier = ?, impact_summary = ? WHERE task_id = ? AND id = ?")
      .run(tier, impactSummary, taskId, credentialId);
    return this.getCredential(taskId, credentialId)!;
  }

  private rowToCredential(row: HistoryRow): Credential {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: String(row.kind) as CredentialKind,
      asset: String(row.asset),
      username: row.username === null || row.username === undefined ? null : String(row.username),
      secretRef: String(row.secret_ref),
      secretHmac:
        row.secret_hmac === null || row.secret_hmac === undefined ? null : String(row.secret_hmac),
      sourceFindingId:
        row.source_finding_id === null || row.source_finding_id === undefined
          ? null
          : String(row.source_finding_id),
      factId: row.fact_id === null || row.fact_id === undefined ? null : String(row.fact_id),
      verifiedAt:
        row.verified_at === null || row.verified_at === undefined ? null : String(row.verified_at),
      lastUsedAt:
        row.last_used_at === null || row.last_used_at === undefined
          ? null
          : String(row.last_used_at),
      reuseCount: Number(row.reuse_count ?? 0),
      expiresAt:
        row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
      createdAt: String(row.created_at),
      tier: defaultCredentialTier({
        tier: row.tier === "L1" || row.tier === "L2" || row.tier === "L3" ? row.tier : undefined,
        verifiedAt:
          row.verified_at === null || row.verified_at === undefined
            ? null
            : String(row.verified_at),
      }),
      impactSummary:
        row.impact_summary === null ||
        row.impact_summary === undefined ||
        row.impact_summary === ""
          ? null
          : String(row.impact_summary),
    };
  }
}
