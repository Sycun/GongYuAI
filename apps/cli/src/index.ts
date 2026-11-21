#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { CreateTaskRequestSchema } from "@gongyuai/contracts";
import { bootControlPlane } from "@gongyuai/control-plane";

type GlobalOpts = {
  dataDir: string;
  host: string;
  port: number;
  baseUrl?: string;
};

function printHelp(): void {
  console.log(`GongYuAI CLI (single-user MVP)

Usage:
  gy serve [--data-dir DIR] [--port N]
  gy run --goals FILE --target URL [--target URL ...] --auth NOTE [--name NAME]
       [--mock] [--wait] [--concurrency N]
       [--capability observe|scan|active-lab|full]
  gy status [taskId]
  gy logs <taskId>
  gy report <taskId>
  gy stop <taskId>

Environment:
  GY_DATA_DIR  GY_HOST  GY_PORT  GY_RUNTIME  OPENAI_API_KEY
  GY_RELAY_TOKEN_THRESHOLD  GY_RELAY_MIN_TOOL_CALLS
`);
}

/** Collect repeated --flag value pairs (e.g. multiple --target). */
function flags(rest: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === name && rest[i + 1]) {
      out.push(rest[++i]!);
    }
  }
  return out;
}

function parseGlobal(argv: string[]): { cmd: string; rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = {
    dataDir: process.env.GY_DATA_DIR ?? ".gongyuai",
    host: process.env.GY_HOST ?? "127.0.0.1",
    port: Number(process.env.GY_PORT ?? 8787),
  };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--data-dir") opts.dataDir = argv[++i]!;
    else if (a === "--host") opts.host = argv[++i]!;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--base-url") opts.baseUrl = argv[++i]!;
    else out.push(a);
  }
  const cmd = out[0] ?? "help";
  return { cmd, rest: out.slice(1), opts };
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  return rest[i + 1];
}

function has(rest: string[], name: string): boolean {
  return rest.includes(name);
}

async function api(
  opts: GlobalOpts,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json?: unknown }> {
  const base = opts.baseUrl ?? `http://${opts.host}:${opts.port}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

async function ensureServer(opts: GlobalOpts): Promise<{ close?: () => Promise<void> }> {
  try {
    const health = await api(opts, "GET", "/health");
    if (health.status === 200) return {};
  } catch {
    /* start local */
  }
  const plane = await bootControlPlane({
    dataRoot: resolve(opts.dataDir),
    host: opts.host,
    port: opts.port,
  });
  console.error(`[gy] control plane ${plane.url}`);
  return { close: () => plane.close() };
}

async function main(): Promise<void> {
  const { cmd, rest, opts } = parseGlobal(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "serve") {
    const plane = await bootControlPlane({
      dataRoot: resolve(opts.dataDir),
      host: opts.host,
      port: opts.port,
    });
    console.log(`GongYuAI control plane listening on ${plane.url}`);
    await new Promise(() => undefined);
  }

  if (cmd === "run") {
    const goalsPath = flag(rest, "--goals");
    const targets = flags(rest, "--target");
    const auth = flag(rest, "--auth");
    const name = flag(rest, "--name") ?? "mvp-run";
    const mock = has(rest, "--mock");
    const wait = has(rest, "--wait");
    const concurrency = Number(flag(rest, "--concurrency") ?? 1);
    const capability = (flag(rest, "--capability") ?? "active-lab") as
      | "observe"
      | "scan"
      | "active-lab"
      | "full";
    if (!goalsPath || !targets.length || !auth) {
      throw new Error("gy run requires --goals --target --auth");
    }
    const goals = JSON.parse(readFileSync(resolve(goalsPath), "utf8"));
    const body = CreateTaskRequestSchema.parse({
      tenantId: "default",
      name,
      mock,
      auth: {
        authorizationNote: auth,
        targets,
        outOfScope: [],
        capability,
      },
      goals,
      execution: {
        maxConcurrentExplores: concurrency,
      },
      budget: {
        maxTokens: 2_000_000,
        maxWallMs: Number(flag(rest, "--max-wall-ms") ?? 600_000),
        maxToolCalls: Number(flag(rest, "--max-tool-calls") ?? 200),
        maxInstalls: Number(flag(rest, "--max-installs") ?? 20),
        relayTokenThreshold: Number(
          flag(rest, "--relay-token-threshold") ??
            process.env.GY_RELAY_TOKEN_THRESHOLD ??
            30_000,
        ),
        relayMinToolCalls: Number(
          flag(rest, "--relay-min-tool-calls") ??
            process.env.GY_RELAY_MIN_TOOL_CALLS ??
            2,
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
          const t = (st.json as { task: { id: string; status: string } }).task;
          process.stderr.write(`\r[gy] status=${t.status}   `);
          if (
            ["completed", "failed", "budget_exhausted", "stopped"].includes(t.status)
          ) {
            console.log();
            console.log(JSON.stringify(t, null, 2));
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
    return;
  }

  if (cmd === "status") {
    const owned = await ensureServer(opts);
    try {
      const id = rest[0];
      if (!id) {
        const all = await api(opts, "GET", "/tasks");
        console.log(all.text);
        return;
      }
      const one = await api(opts, "GET", `/tasks/${id}`);
      console.log(one.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "logs") {
    const id = rest[0];
    if (!id) throw new Error("gy logs <taskId>");
    const owned = await ensureServer(opts);
    try {
      const logs = await api(opts, "GET", `/tasks/${id}/logs`);
      process.stdout.write(logs.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "report") {
    const id = rest[0];
    if (!id) throw new Error("gy report <taskId>");
    const owned = await ensureServer(opts);
    try {
      const report = await api(opts, "GET", `/tasks/${id}/report`);
      process.stdout.write(report.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  if (cmd === "stop") {
    const id = rest[0];
    if (!id) throw new Error("gy stop <taskId>");
    const owned = await ensureServer(opts);
    try {
      const stopped = await api(opts, "POST", `/tasks/${id}/stop`);
      console.log(stopped.text);
    } finally {
      if (owned.close) await owned.close();
    }
    return;
  }

  // Direct local status from data dir without server
  if (cmd === "inspect") {
    const id = rest[0];
    const p = resolve(opts.dataDir, "tasks", id ?? "", "worker-status.json");
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    console.log(readFileSync(p, "utf8"));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
