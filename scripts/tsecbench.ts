#!/usr/bin/env node
/**
 * Thin TSecBench Challenges API client for GongYuAI workers / operators.
 * Credentials: BENCHMARK_BASE_URL + BENCHMARK_TOKEN (env or .gongyuai/tsecbench/env).
 *
 * Ticket lifecycle: one BENCHMARK_TOKEN ↔ one platform task. When the task is
 * finished (409 invalid_state), the ticket is dead — reset on the platform.
 * Hint is scarce (≈5/task historically); default-denied unless GY_TSEC_ALLOW_HINT=1.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_CANDIDATES = [
  resolve(ROOT, ".gongyuai/tsecbench/env"),
  resolve(process.env.HOME ?? "", ".config/tsecbench/env"),
  resolve(ROOT, ".env"),
];
const TICKET_PATH = resolve(ROOT, ".gongyuai/tsecbench/ticket.json");

type Challenge = {
  unique_code: string;
  description: string | null;
  difficulty: string;
  level: number;
  total_score: number;
  flag_count: number;
  correct_flag_count: number;
  is_completed: boolean;
  container_status: string;
  container_addr: string[];
};

type TicketState = {
  tokenFingerprint: string;
  taskIdHint?: string;
  hintCount: number;
  finished: boolean;
  finishedAt?: string;
  lastError?: string;
  updatedAt: string;
};

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env) || !process.env[k]) process.env[k] = v;
  }
}

for (const p of ENV_CANDIDATES) loadEnvFile(p);

function requireCreds(): { base: string; token: string } {
  const base = (process.env.BENCHMARK_BASE_URL ?? "").replace(/\/$/, "");
  const token = process.env.BENCHMARK_TOKEN ?? "";
  if (!base || !token) {
    throw new Error(
      "Missing BENCHMARK_BASE_URL / BENCHMARK_TOKEN (set env or .gongyuai/tsecbench/env)",
    );
  }
  return { base, token };
}

function tokenFingerprint(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function loadTicket(token: string): TicketState {
  const fp = tokenFingerprint(token);
  if (existsSync(TICKET_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(TICKET_PATH, "utf8")) as TicketState;
      if (raw.tokenFingerprint === fp) return raw;
    } catch {
      /* reset */
    }
  }
  return {
    tokenFingerprint: fp,
    hintCount: 0,
    finished: false,
    updatedAt: new Date().toISOString(),
  };
}

function saveTicket(t: TicketState): void {
  mkdirSync(dirname(TICKET_PATH), { recursive: true });
  t.updatedAt = new Date().toISOString();
  writeFileSync(TICKET_PATH, JSON.stringify(t, null, 2));
}

class PlatformTaskFinishedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformTaskFinishedError";
  }
}

function isPlatformFinished(status: number, body: unknown, text: string): boolean {
  if (status !== 409) return false;
  const msg =
    typeof body === "object" && body && "message" in body
      ? String((body as { message: unknown }).message)
      : text;
  return /already finished|invalid_state/i.test(msg);
}

async function api(
  method: string,
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: unknown; text: string }> {
  const { base, token } = requireCreds();
  const ticket = loadTicket(token);
  if (ticket.finished) {
    throw new PlatformTaskFinishedError(
      `ticket finished (${ticket.finishedAt ?? "?"}): ${ticket.lastError ?? "platform task dead"}; reset BENCHMARK_TOKEN on TSecBench`,
    );
  }

  const url = new URL(`${base}${path}`);
  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      BENCHMARK_TOKEN: token,
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (isPlatformFinished(res.status, json, text)) {
    ticket.finished = true;
    ticket.finishedAt = new Date().toISOString();
    ticket.lastError = text.slice(0, 500);
    saveTicket(ticket);
    const outDir = resolve(ROOT, ".gongyuai/tsecbench");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "BLOCKER_409.json"),
      JSON.stringify(
        {
          at: ticket.finishedAt,
          path,
          status: res.status,
          body: json ?? text,
          hintCount: ticket.hintCount,
        },
        null,
        2,
      ),
    );
    throw new PlatformTaskFinishedError(
      `platform task finished (409): stop all calls; rotate BENCHMARK_TOKEN. raw=${text.slice(0, 300)}`,
    );
  }

  return { status: res.status, json, text };
}

function print(x: unknown): void {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

function usage(): void {
  console.log(`tsecbench — TSecBench Challenges API helper

Usage:
  pnpm tsecbench list [--json]
  pnpm tsecbench start <unique_code>
  pnpm tsecbench hint <unique_code>   # requires GY_TSEC_ALLOW_HINT=1
  pnpm tsecbench submit <unique_code> <flag>
  pnpm tsecbench close <unique_code>
  pnpm tsecbench status [unique_code]
  pnpm tsecbench snapshot   # write challenges JSON under .gongyuai/tsecbench/
  pnpm tsecbench probe      # ticket health (list once; detect 409)

Env: BENCHMARK_BASE_URL, BENCHMARK_TOKEN
     GY_TSEC_ALLOW_HINT=1 to enable hint (default off; ≤5/task historically)
`);
}

async function cmdList(asJson: boolean): Promise<void> {
  const r = await api("GET", "/openapi/v1/challenges");
  if (r.status >= 400) throw new Error(r.text);
  const list = r.json as Challenge[];
  if (asJson) {
    print(list);
    return;
  }
  const rows = list.map((c) => ({
    code: c.unique_code,
    diff: c.difficulty,
    score: c.total_score,
    flags: `${c.correct_flag_count}/${c.flag_count}`,
    done: c.is_completed,
    status: c.container_status,
    addr: c.container_addr.join(",") || "-",
  }));
  console.table(rows);
  console.error(
    `[tsecbench] ${list.length} challenges, completed=${list.filter((c) => c.is_completed).length}`,
  );
}

async function cmdStart(code: string): Promise<void> {
  const r = await api("POST", "/openapi/v1/challenges/start", {
    query: { unique_code: code },
  });
  if (r.status >= 400) throw new Error(r.text);
  print(r.json);
  const addr = (r.json as { container_addr?: string[] }).container_addr ?? [];
  if (!addr.length) {
    console.error(
      "[tsecbench] WARN: container_addr empty — treat as platform issue; do not burn token on unreachable targets",
    );
  }
  const outDir = resolve(ROOT, ".gongyuai/tsecbench");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    resolve(outDir, "active.json"),
    JSON.stringify(
      { unique_code: code, container_addr: addr, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

async function cmdHint(code: string): Promise<void> {
  if (process.env.GY_TSEC_ALLOW_HINT !== "1") {
    throw new Error(
      "hint denied: set GY_TSEC_ALLOW_HINT=1 for a single explicit call (batch hint can finish the platform task)",
    );
  }
  const { token } = requireCreds();
  const ticket = loadTicket(token);
  if (ticket.hintCount >= 5) {
    throw new Error(
      `hint denied: local counter=${ticket.hintCount} (historical platform cap ≈5); refusing further hints`,
    );
  }
  const r = await api("GET", "/openapi/v1/challenges/hint", {
    query: { unique_code: code },
  });
  if (r.status >= 400) throw new Error(r.text);
  ticket.hintCount += 1;
  saveTicket(ticket);
  console.error(`[tsecbench] hint used ${ticket.hintCount}/5 (local counter)`);
  print(r.json);
}

async function cmdSubmit(code: string, flag: string): Promise<void> {
  const r = await api("POST", "/openapi/v1/challenges/submit", {
    body: { unique_code: code, flag },
  });
  if (r.status >= 400) throw new Error(r.text);
  print(r.json);
}

async function cmdClose(code: string): Promise<void> {
  const r = await api("POST", "/openapi/v1/challenges/close", {
    query: { unique_code: code },
  });
  if (r.status >= 400) throw new Error(r.text);
  print(r.json);
}

async function cmdStatus(code?: string): Promise<void> {
  const r = await api("GET", "/openapi/v1/challenges");
  if (r.status >= 400) throw new Error(r.text);
  const list = r.json as Challenge[];
  if (code) {
    const one = list.find((c) => c.unique_code === code);
    if (!one) throw new Error(`challenge_not_found: ${code}`);
    print(one);
    return;
  }
  const active = list.filter((c) => c.container_status !== "stopped");
  print({
    total: list.length,
    completed: list.filter((c) => c.is_completed).length,
    active,
  });
}

async function cmdSnapshot(): Promise<void> {
  const r = await api("GET", "/openapi/v1/challenges");
  if (r.status >= 400) throw new Error(r.text);
  const outDir = resolve(ROOT, ".gongyuai/tsecbench");
  mkdirSync(outDir, { recursive: true });
  const path = resolve(outDir, "challenges.json");
  writeFileSync(path, JSON.stringify(r.json, null, 2));
  console.log(path);
}

async function cmdProbe(): Promise<void> {
  const { token } = requireCreds();
  const ticket = loadTicket(token);
  print({
    tokenFingerprint: ticket.tokenFingerprint,
    finished: ticket.finished,
    hintCount: ticket.hintCount,
    finishedAt: ticket.finishedAt ?? null,
  });
  if (ticket.finished) {
    console.error("[tsecbench] ticket already marked finished — rotate token");
    process.exitCode = 2;
    return;
  }
  try {
    const r = await api("GET", "/openapi/v1/challenges");
    if (r.status >= 400) throw new Error(r.text);
    const list = r.json as Challenge[];
    print({
      ok: true,
      total: list.length,
      completed: list.filter((c) => c.is_completed).length,
    });
  } catch (err) {
    if (err instanceof PlatformTaskFinishedError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  if (cmd === "list") await cmdList(process.argv.includes("--json"));
  else if (cmd === "start") {
    if (!a) throw new Error("start <unique_code>");
    await cmdStart(a);
  } else if (cmd === "hint") {
    if (!a) throw new Error("hint <unique_code>");
    await cmdHint(a);
  } else if (cmd === "submit") {
    if (!a || !b) throw new Error("submit <unique_code> <flag>");
    await cmdSubmit(a, b);
  } else if (cmd === "close") {
    if (!a) throw new Error("close <unique_code>");
    await cmdClose(a);
  } else if (cmd === "status") await cmdStatus(a);
  else if (cmd === "snapshot") await cmdSnapshot();
  else if (cmd === "probe") await cmdProbe();
  else throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(err instanceof PlatformTaskFinishedError ? 2 : 1);
});
