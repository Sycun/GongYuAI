/**
 * 复核与交付命令：findings / finding-* / reconcile / scorecard / coverage* / review /
 * retest* / peer-review* / correct* / evidence / session，以及校验、验收、审计链与命令重置。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scorecardFromSnapshot } from "@gongyuai/history";
import { resolveCanonicalDataRoot, resolveInstallRoot } from "@gongyuai/control-plane";
import { flag, flags, parseHeaderFlag, positional, type GlobalOpts } from "./args.js";
import { compareCommand, snapshotCommand } from "./coverage-audit.js";
import { api, splitCsv, withServer } from "./client.js";

type Handler = (rest: string[], opts: GlobalOpts) => Promise<void>;

function assertLocalCoverage(opts: GlobalOpts): void {
  if (opts.baseUrl) throw new Error("覆盖复核命令使用本地文件；请省略 --base-url");
}

async function coverageSnapshot(rest: string[], opts: GlobalOpts): Promise<void> {
  assertLocalCoverage(opts);
  snapshotCommand(rest, resolveCanonicalDataRoot({ installRoot: resolveInstallRoot(), explicit: opts.dataDir }));
}

async function coverageCompare(rest: string[], opts: GlobalOpts): Promise<void> {
  assertLocalCoverage(opts);
  compareCommand(rest);
}

async function review(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const path = flag(rest, "--file");
  if (!id || !path) throw new Error("gy review <taskId> --file REVIEW.json");
  const input: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${encodeURIComponent(id)}/reviews`, input);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function evidence(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const path = flag(rest, "--path");
  const file = flag(rest, "--file");
  if (!id || !path || !file) throw new Error("gy evidence <taskId> --path P --file LOCAL");
  const content = readFileSync(resolve(file), "utf8");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/evidence`, { path, content });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function findingVerifyOrRetract(
  cmd: "finding-verify" | "finding-retract",
  rest: string[],
  opts: GlobalOpts,
): Promise<void> {
  const id = rest[0];
  const finding = flag(rest, "--finding");
  if (!id || !finding) throw new Error(`gy ${cmd} <taskId> --finding ID`);
  await withServer(opts, async () => {
    const body = cmd === "finding-retract"
      ? { reason: flag(rest, "--reason") ?? "" }
      : { evidencePaths: splitCsv(flag(rest, "--evidence")), repro: flag(rest, "--repro") ?? "" };
    const response = await api(
      opts,
      "POST",
      `/tasks/${id}/findings/${finding}/${cmd === "finding-retract" ? "retract" : "verify"}`,
      body,
    );
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function findingValidate(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const finding = flag(rest, "--finding");
  const verdict = flag(rest, "--verdict");
  const method = flag(rest, "--method");
  if (!id || !finding || !verdict || !method) {
    throw new Error("gy finding-validate <taskId> --finding ID --verdict ... --method ...");
  }
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/findings/${finding}/validate`, {
      verdict,
      method,
      evidencePaths: splitCsv(flag(rest, "--evidence")),
      note: flag(rest, "--note") ?? "",
      validator: flag(rest, "--validator") ?? "operator:cli",
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function validations(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy validations <taskId> [--finding ID]");
  const findingId = flag(rest, "--finding");
  await withServer(opts, async () => {
    const suffix = findingId ? `?findingId=${encodeURIComponent(findingId)}` : "";
    const response = await api(opts, "GET", `/tasks/${id}/validations${suffix}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function chain(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy chain <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/chain`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function commandReset(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy command-reset <taskId> [--reason TEXT]");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/command-reset`, {
      reason: flag(rest, "--reason") ?? "operator reset",
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function audit(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy audit <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/audit`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function findings(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy findings <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/findings`);
    console.log(response.text);
  });
}

async function retest(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const finding = flag(rest, "--finding");
  const result = flag(rest, "--result");
  const evidencePaths = flag(rest, "--evidence");
  const repro = flag(rest, "--repro");
  if (!id || !finding || !result || !evidencePaths || !repro) {
    throw new Error(
      "gy retest <taskId> --finding ID --result fixed|still-present|partially-fixed --evidence FILE --repro TEXT",
    );
  }
  const note = flag(rest, "--note");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/findings/${finding}/retest`, {
      result,
      evidencePaths: splitCsv(evidencePaths),
      repro,
      ...(note ? { note } : {}),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function accept(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const finding = flag(rest, "--finding");
  const note = flag(rest, "--note");
  const evidencePath = flag(rest, "--evidence");
  if (!id || !finding || !note || !evidencePath) {
    throw new Error("gy accept <taskId> --finding ID --note TEXT --evidence FILE");
  }
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/findings/${finding}/accept`, {
      note,
      evidencePath,
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function scorecard(rest: string[], opts: GlobalOpts): Promise<void> {
  const recompute = flag(rest, "--recompute");
  if (recompute) {
    const parsed: unknown = JSON.parse(readFileSync(resolve(recompute), "utf8"));
    const result = scorecardFromSnapshot(parsed);
    if (!result.ok) throw new Error(result.reason);
    console.log(JSON.stringify({ sealValid: result.sealValid, scorecard: result.scorecard }, null, 2));
    if (!result.sealValid) process.exitCode = 2;
    return;
  }
  const id = rest[0];
  if (!id) throw new Error("gy scorecard <taskId> [--out FILE]");
  const out = flag(rest, "--out");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/snapshot`);
    if (response.status >= 400) throw new Error(response.text);
    const payload = response.json as { snapshot: unknown; scorecard: unknown };
    if (out) writeFileSync(resolve(out), JSON.stringify(payload.snapshot, null, 2) + "\n");
    console.log(JSON.stringify(payload.scorecard, null, 2));
  });
}

async function corrections(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy corrections <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/corrections`);
    console.log(response.text);
  });
}

async function correct(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const reason = flag(rest, "--reason");
  if (!id || !reason) throw new Error("gy correct <taskId> --reason TEXT");
  const findingsList = flag(rest, "--findings");
  const notice = flag(rest, "--notice");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/corrections`, {
      reason,
      ...(findingsList ? { findings: splitCsv(findingsList) } : {}),
      ...(notice ? { noticeStatus: notice } : {}),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function correctionNotice(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const correctionId = rest[1];
  const status = flag(rest, "--status");
  const evidencePath = flag(rest, "--evidence");
  if (!id || !correctionId || !status) {
    throw new Error("gy correction-notice <taskId> <correctionId> --status notified|confirmed [--evidence FILE]");
  }
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/corrections/${correctionId}/notice`, {
      status,
      ...(evidencePath ? { evidencePath } : {}),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function reconcile(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const baseline = flag(rest, "--baseline");
  const current = flag(rest, "--current");
  if (!id || !baseline || !current) {
    throw new Error(
      "gy reconcile <taskId> --baseline PATH --current PATH [--key host] [--required a,b] [--name NAME] [--out FILE]",
    );
  }
  const required = flag(rest, "--required");
  const body = {
    name: flag(rest, "--name") ?? "baseline-diff",
    baseline: { path: baseline },
    current: { path: current },
    keyField: flag(rest, "--key") ?? "host",
    ...(required ? { requiredKeys: splitCsv(required) } : {}),
  };
  const out = flag(rest, "--out");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/reconcile`, body);
    if (response.status >= 400) throw new Error(response.text);
    if (out) writeFileSync(resolve(out), JSON.stringify(response.json, null, 2) + "\n");
    console.log(JSON.stringify(response.json, null, 2));
  });
}

async function retestRequest(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const requester = flag(rest, "--requester");
  const finding = flag(rest, "--finding");
  const reason = flag(rest, "--reason");
  if (!id || !requester || !finding || !reason) {
    throw new Error(
      "gy retest-request <taskId> --requester NAME --finding ID[,ID] --reason TEXT [--role R] [--evidence PATH]",
    );
  }
  const role = flag(rest, "--role");
  const evidencePath = flag(rest, "--evidence");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/retest-requests`, {
      requester,
      findingIds: splitCsv(finding),
      reason,
      ...(role ? { role } : {}),
      ...(evidencePath ? { evidencePath } : {}),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function retestRequests(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy retest-requests <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/retest-requests`);
    console.log(response.text);
  });
}

async function peerReview(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const reviewer = flag(rest, "--reviewer");
  const role = flag(rest, "--role");
  const source = flag(rest, "--source");
  const basis = flag(rest, "--basis");
  if (!id || !reviewer || !role || !source || !basis) {
    throw new Error(
      "gy peer-review <taskId> --reviewer NAME --role ROLE --source TASKID --basis TEXT [--decision confirm|challenge|retest-requested] [--finding ID] [--fact ID] [--evidence PATH]",
    );
  }
  const finding = flag(rest, "--finding");
  const fact = flag(rest, "--fact");
  const evidencePath = flag(rest, "--evidence");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/peer-reviews`, {
      reviewer,
      role,
      sourceTaskId: source,
      decision: flag(rest, "--decision") ?? "confirm",
      basis,
      ...(finding ? { findingId: finding } : {}),
      ...(fact ? { factId: fact } : {}),
      ...(evidencePath ? { evidencePath } : {}),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function peerReviews(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("gy peer-reviews <taskId>");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/tasks/${id}/peer-reviews`);
    console.log(response.text);
  });
}

async function coverageCell(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const asset = flag(rest, "--asset");
  const technique = flag(rest, "--technique");
  if (!id || !asset || !technique) {
    throw new Error("gy coverage-cell <taskId> --asset A --technique CWE-89 --state manual");
  }
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/coverage-cells`, {
      asset,
      technique,
      state: flag(rest, "--state") ?? "manual",
      reviewer: flag(rest, "--reviewer") ?? "operator",
      reason: flag(rest, "--reason") ?? "人工覆盖登记",
      evidenceRefs: splitCsv(flag(rest, "--evidence")),
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function session(rest: string[], opts: GlobalOpts): Promise<void> {
  const pos = positional(rest);
  const sub = pos[0];
  const id = pos[1];
  if (!id || (sub !== "import" && sub !== "list" && sub !== "delete")) {
    throw new Error("usage: gy session import|list|delete <taskId> [--name NAME --host HOST]");
  }
  await withServer(opts, async () => {
    if (sub === "list") {
      const response = await api(opts, "GET", `/tasks/${id}/http-sessions`);
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
      return;
    }
    if (sub === "delete") {
      const name = flag(rest, "--name");
      if (!name) throw new Error("gy session delete <taskId> --name NAME");
      const response = await api(opts, "DELETE", `/tasks/${id}/http-sessions/${encodeURIComponent(name)}`);
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
      return;
    }
    const name = flag(rest, "--name");
    const host = flag(rest, "--host");
    if (!name || !host) throw new Error("gy session import <taskId> --name NAME --host HOST");
    const cookies = flags(rest, "--cookie");
    const headers: Record<string, string> = {};
    for (const raw of flags(rest, "--header")) {
      const [headerName, headerValue] = parseHeaderFlag(raw);
      headers[headerName] = headerValue;
    }
    const body: Record<string, unknown> = { name, host };
    if (cookies.length) body.cookie = cookies.join("; ");
    if (Object.keys(headers).length) body.headers = headers;
    const response = await api(opts, "POST", `/tasks/${id}/http-sessions`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

const handlers: Record<string, Handler> = {
  "coverage-snapshot": coverageSnapshot,
  "coverage-compare": coverageCompare,
  review,
  evidence,
  "finding-verify": (rest, opts) => findingVerifyOrRetract("finding-verify", rest, opts),
  "finding-retract": (rest, opts) => findingVerifyOrRetract("finding-retract", rest, opts),
  "finding-validate": findingValidate,
  validations,
  chain,
  "command-reset": commandReset,
  audit,
  findings,
  retest,
  accept,
  scorecard,
  corrections,
  correct,
  "correction-notice": correctionNotice,
  reconcile,
  "retest-request": retestRequest,
  "retest-requests": retestRequests,
  "peer-review": peerReview,
  "peer-reviews": peerReviews,
  "coverage-cell": coverageCell,
  session,
};

export function reviewCommandNames(): string[] {
  return Object.keys(handlers);
}

export async function handleReviewCommand(cmd: string, rest: string[], opts: GlobalOpts): Promise<boolean> {
  const handler = handlers[cmd];
  if (!handler) return false;
  await handler(rest, opts);
  return true;
}
