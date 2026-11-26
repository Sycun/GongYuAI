/**
 * 冻结的 P8/P9 与模拟命令。
 * 默认帮助不展开；`gy --help-experimental` 查看。直接调用与拆分前一致。
 *
 * memory / contact / proposal* / eval* / trend / role / provider-fault
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flag, type GlobalOpts } from "./args.js";
import { api, withServer } from "./client.js";

type Handler = (rest: string[], opts: GlobalOpts) => Promise<void>;

async function memory(rest: string[], opts: GlobalOpts): Promise<void> {
  const sub = rest[0];
  await withServer(opts, async () => {
    if (sub === "list") {
      const response = await api(opts, "GET", "/memory/nodes");
      console.log(response.text);
    } else if (sub === "draft") {
      const file = flag(rest, "--file");
      if (!file) throw new Error("gy memory draft --file F");
      const response = await api(opts, "POST", "/memory/nodes", JSON.parse(readFileSync(resolve(file), "utf8")));
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
    } else if (sub === "review") {
      const id = rest[1];
      const decision = flag(rest, "--decision");
      if (!id || !decision) {
        throw new Error("gy memory review <id> --decision confirm|retract --reviewer N --reason TEXT");
      }
      const response = await api(opts, "POST", `/memory/nodes/${id}/review`, {
        decision,
        reviewer: flag(rest, "--reviewer") ?? "operator",
        reason: flag(rest, "--reason") ?? "",
      });
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
    } else if (sub === "refs") {
      const id = rest[1];
      if (!id) throw new Error("gy memory refs <id>");
      const response = await api(opts, "GET", `/memory/nodes/${id}/references`);
      console.log(response.text);
    } else if (sub === "inject") {
      const id = rest[1];
      if (!id) throw new Error("gy memory inject <taskId> [--asset A]");
      const asset = flag(rest, "--asset");
      const response = await api(opts, "POST", `/tasks/${id}/memory/inject`, {
        ...(asset ? { asset } : {}),
      });
      if (response.status >= 400) throw new Error(response.text);
      console.log(response.text);
    } else {
      throw new Error("gy memory list|draft|review|refs|inject");
    }
  });
}

async function contact(rest: string[], opts: GlobalOpts): Promise<void> {
  const targets = flag(rest, "--targets");
  if (!targets) throw new Error("gy contact --targets A,B");
  await withServer(opts, async () => {
    const response = await api(opts, "GET", `/archive/contact?targets=${encodeURIComponent(targets)}`);
    console.log(response.text);
  });
}

async function proposalsOrProposal(cmd: "proposals" | "proposal", rest: string[], opts: GlobalOpts): Promise<void> {
  await withServer(opts, async () => {
    const id = rest[0];
    const response = cmd === "proposals"
      ? await api(opts, "GET", "/proposals")
      : await api(opts, "GET", `/proposals/${id ?? ""}`);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function proposalCreateOrEvalRun(cmd: "proposal-create" | "eval-run", rest: string[], opts: GlobalOpts): Promise<void> {
  const file = flag(rest, "--file");
  if (!file) throw new Error(`gy ${cmd} --file F`);
  await withServer(opts, async () => {
    const body = JSON.parse(readFileSync(resolve(file), "utf8"));
    const response = await api(opts, "POST", cmd === "proposal-create" ? "/proposals" : "/evaluations", body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function proposalMutation(
  cmd: "proposal-decide" | "proposal-promote" | "proposal-rollback",
  rest: string[],
  opts: GlobalOpts,
): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error(`gy ${cmd} <id>`);
  await withServer(opts, async () => {
    const path = cmd === "proposal-decide" ? "decide" : cmd === "proposal-promote" ? "promote" : "rollback";
    const body = cmd === "proposal-decide"
      ? { decision: flag(rest, "--decision") ?? "approve", decidedBy: flag(rest, "--by") ?? "operator", reason: flag(rest, "--reason") ?? "" }
      : cmd === "proposal-promote"
        ? { promotedBy: flag(rest, "--by") ?? "operator", evaluationRunId: flag(rest, "--eval") ?? "" }
        : { rolledBackBy: flag(rest, "--by") ?? "operator", reason: flag(rest, "--reason") ?? "" };
    const response = await api(opts, "POST", `/proposals/${id}/${path}`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function evalsOrTrend(cmd: "evals" | "trend", rest: string[], opts: GlobalOpts): Promise<void> {
  await withServer(opts, async () => {
    const qs = new URLSearchParams();
    const suite = flag(rest, "--suite");
    const tenant = flag(rest, "--tenant");
    if (suite) qs.set("suite", suite);
    if (tenant) qs.set("tenantId", tenant);
    const response = await api(opts, "GET", `/${cmd === "evals" ? "evaluations" : "trends"}?${qs.toString()}`);
    console.log(response.text);
  });
}

async function role(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const roleName = flag(rest, "--role");
  const kind = flag(rest, "--kind");
  if (!id || !roleName || !kind) {
    throw new Error("gy role <taskId> --role planner|reviewer|assistant --kind plan|review|incident");
  }
  const file = flag(rest, "--file");
  const body = {
    role: roleName,
    kind,
    input: file ? JSON.parse(readFileSync(resolve(file), "utf8")) : {},
    simulated: true,
  };
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/roles`, body);
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

async function providerFault(rest: string[], opts: GlobalOpts): Promise<void> {
  const id = rest[0];
  const provider = flag(rest, "--provider");
  const fault = flag(rest, "--fault");
  if (!id || !provider || !fault) throw new Error("gy provider-fault <taskId> --provider NAME --fault rate-limit");
  const tokens = flag(rest, "--tokens");
  await withServer(opts, async () => {
    const response = await api(opts, "POST", `/tasks/${id}/provider`, {
      provider,
      fault,
      attempt: Number(flag(rest, "--attempt") ?? 0),
      fallbackAllowed: (flag(rest, "--fallback") ?? "false") === "true",
      billing: flag(rest, "--billing") ?? "none",
      tokens: tokens ? Number(tokens) : null,
    });
    if (response.status >= 400) throw new Error(response.text);
    console.log(response.text);
  });
}

const handlers: Record<string, Handler> = {
  memory,
  contact,
  proposals: (rest, opts) => proposalsOrProposal("proposals", rest, opts),
  proposal: (rest, opts) => proposalsOrProposal("proposal", rest, opts),
  "proposal-create": (rest, opts) => proposalCreateOrEvalRun("proposal-create", rest, opts),
  "eval-run": (rest, opts) => proposalCreateOrEvalRun("eval-run", rest, opts),
  "proposal-decide": (rest, opts) => proposalMutation("proposal-decide", rest, opts),
  "proposal-promote": (rest, opts) => proposalMutation("proposal-promote", rest, opts),
  "proposal-rollback": (rest, opts) => proposalMutation("proposal-rollback", rest, opts),
  evals: (rest, opts) => evalsOrTrend("evals", rest, opts),
  trend: (rest, opts) => evalsOrTrend("trend", rest, opts),
  role,
  "provider-fault": providerFault,
};

export function frozenCommandNames(): string[] {
  return Object.keys(handlers);
}

export async function handleFrozenCommand(cmd: string, rest: string[], opts: GlobalOpts): Promise<boolean> {
  const handler = handlers[cmd];
  if (!handler) return false;
  await handler(rest, opts);
  return true;
}
