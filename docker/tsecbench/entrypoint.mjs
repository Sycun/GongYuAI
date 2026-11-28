#!/usr/bin/env node
/**
 * GongYuAI — TSecBench Hosted Official Sandbox Entrypoint.
 *
 * Boots the full GongYuAI Control Plane + Watchdog + 1 Leader + N Followers
 * multi-worker pipeline autonomously inside the isolated TSecBench sandbox.
 *
 * Platform-injected env vars:
 *   BENCHMARK_BASE_URL  — scoring API base URL
 *   BENCHMARK_TOKEN     — task token
 *
 * User-supplied env vars (via TSecBench submission form):
 *   OPENAI_API_KEY      (aliases: LLM_API_KEY, DEEPSEEK_API_KEY, MODEL_API_KEY, KIMI_API_KEY, MOONSHOT_API_KEY, GLM_API_KEY, ARK_API_KEY, MINIMAX_API_KEY, SILICONFLOW_API_KEY)
 *   OPENAI_BASE_URL     (aliases: MODEL_BASE_URL, LLM_BASE_URL, DEEPSEEK_BASE_URL; default: http://api.deepseek.com.tsecbench.gw/v1)
 *   GY_MODEL            (aliases: MODEL_ID, OPENAI_MODEL, LLM_MODEL, DEEPSEEK_MODEL; default: deepseek-flash)
 *   GY_PROVIDER         (optional; inferred from baseUrl when omitted)
 *   GY_CONCURRENCY      (optional; default: 3 → 1 Leader + 3 Explore Followers)
 *   GY_VISION           (optional; "1" to enable vision, default: "0")
 *   GY_VISION_MODEL     (optional)
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_UNLIMITED,
  CreateTaskRequestSchema,
  DEFAULT_MAX_CONCURRENT_EXPLORES,
  isTerminalTaskStatus,
} from "../../packages/contracts/dist/index.js";
import { bootControlPlane } from "../../packages/control-plane/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_ROOT = resolve(process.env.GY_INSTALL_ROOT || join(__dirname, "../.."));
const DATA_ROOT = resolve(process.env.GY_DATA_DIR || "/task/gongyuai-data");
const PORT = Number(process.env.GY_PORT || 8877);
const HOST = "127.0.0.1";

function log(msg) {
  process.stdout.write(`[gy-hosted ${new Date().toISOString()}] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[gy-hosted ERROR] ${msg}\n`);
  process.exit(1);
}

function firstNonEmptyEnv(names) {
  for (const name of names) {
    const val = (process.env[name] ?? "").trim();
    if (val) return { name, value: val };
  }
  return null;
}

function isIpOrLocalhost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

function normalizeHostedGatewayUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (process.env.GY_AUTO_TSB_GATEWAY === "0") return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol === "https:" &&
      !host.endsWith(".tsecbench.gw") &&
      !isIpOrLocalhost(host)
    ) {
      const converted = `http://${parsed.hostname}.tsecbench.gw${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}${parsed.search}`.replace(/\/+$/, "");
      log(`auto-rewrote HTTPS model baseUrl to TSecBench gateway: ${trimmed} -> ${converted}`);
      return converted;
    }
  } catch {
    /* keep raw string if unparseable */
  }
  return trimmed;
}

function inferProvider(baseUrl) {
  const lower = baseUrl.toLowerCase();
  if (lower.includes("deepseek.com")) return "deepseek";
  if (lower.includes("api.openai.com")) return "openai";
  return "openai-compatible";
}

function resolveRuntimeConfig() {
  const benchmarkBase = (process.env.BENCHMARK_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const benchmarkToken = (process.env.BENCHMARK_TOKEN ?? "").trim();
  if (!benchmarkBase || !benchmarkToken) {
    fail("Missing BENCHMARK_BASE_URL or BENCHMARK_TOKEN (platform injects these in hosted mode).");
  }

  const keyHit = firstNonEmptyEnv([
    "OPENAI_API_KEY",
    "LLM_API_KEY",
    "DEEPSEEK_API_KEY",
    "MODEL_API_KEY",
    "API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
    "GLM_API_KEY",
    "ARK_API_KEY",
    "MINIMAX_API_KEY",
    "SILICONFLOW_API_KEY",
  ]);
  if (!keyHit) {
    fail("Missing LLM API key (set OPENAI_API_KEY or DEEPSEEK_API_KEY / LLM_API_KEY in environment variables).");
  }

  const baseHit = firstNonEmptyEnv([
    "OPENAI_BASE_URL",
    "MODEL_BASE_URL",
    "LLM_BASE_URL",
    "DEEPSEEK_BASE_URL",
    "BASE_URL",
  ]);
  const rawBaseUrl = baseHit?.value || "http://api.deepseek.com.tsecbench.gw/v1";
  const baseUrl = normalizeHostedGatewayUrl(rawBaseUrl);

  const modelHit = firstNonEmptyEnv([
    "GY_MODEL",
    "MODEL_ID",
    "OPENAI_MODEL",
    "LLM_MODEL",
    "DEEPSEEK_MODEL",
  ]);
  const modelId = modelHit?.value || "deepseek-flash";

  const providerHit = firstNonEmptyEnv(["GY_PROVIDER", "MODEL_PROVIDER", "LLM_PROVIDER"]);
  const provider = providerHit?.value || inferProvider(baseUrl);

  const rawConcurrency = Number(process.env.GY_CONCURRENCY || DEFAULT_MAX_CONCURRENT_EXPLORES || 3);
  const concurrency = Number.isFinite(rawConcurrency)
    ? Math.max(1, Math.min(6, Math.floor(rawConcurrency)))
    : 3;

  const visionModelId = (process.env.GY_VISION_MODEL ?? "").trim();
  const visionFlag = (process.env.GY_VISION ?? "").trim().toLowerCase();
  const visionEnabled =
    visionFlag === "1" || visionFlag === "true" || Boolean(visionModelId);

  // Export canonical env vars for control plane + worker child processes.
  process.env.OPENAI_API_KEY = keyHit.value;
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.GY_MODEL = modelId;
  process.env.GY_DATA_DIR = DATA_ROOT;
  process.env.GY_HOST = HOST;
  process.env.GY_PORT = String(PORT);
  process.env.GY_TSEC_HOSTED = "1";
  process.env.GY_TSEC_ALLOW_HINT = "0";

  return {
    benchmarkBase,
    benchmarkToken,
    apiKey: keyHit.value,
    apiKeySource: keyHit.name,
    baseUrl,
    modelId,
    provider,
    concurrency,
    visionEnabled,
    visionModelId,
  };
}

function writeBenchmarkEnvFiles(benchmarkBase, benchmarkToken) {
  const payload = `BENCHMARK_BASE_URL=${benchmarkBase}\nBENCHMARK_TOKEN=${benchmarkToken}\n`;
  for (const dir of [join(DATA_ROOT, "tsecbench"), join(INSTALL_ROOT, ".gongyuai", "tsecbench")]) {
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "env");
      writeFileSync(file, payload, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      /* best-effort mirror */
    }
  }
}

async function probeBenchmarkReady(benchmarkBase, benchmarkToken) {
  const url = `${benchmarkBase}/openapi/v1/challenges`;
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { BENCHMARK_TOKEN: benchmarkToken },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (res.status === 409 && /already\s+finished|invalid_state/i.test(text)) {
        log(`benchmark already finished (409): ${text.slice(0, 200)}`);
        return { ready: false, alreadyFinished: true };
      }
      if (res.status >= 200 && res.status < 300) {
        try {
          const list = JSON.parse(text);
          if (Array.isArray(list)) {
            const done = list.filter((c) => c && c.is_completed === true).length;
            log(`benchmark API ready: ${list.length} challenges (${done} already completed)`);
          } else {
            log(`benchmark API ready (HTTP ${res.status})`);
          }
        } catch {
          log(`benchmark API ready (HTTP ${res.status})`);
        }
        return { ready: true, alreadyFinished: false };
      }
      log(`benchmark probe attempt ${attempt}/${maxAttempts}: HTTP ${res.status} ${text.slice(0, 160)}`);
    } catch (err) {
      log(`benchmark probe attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  log("WARN: benchmark probe did not return 200 within 60s; proceeding to start agent anyway.");
  return { ready: true, alreadyFinished: false };
}

function loadGoals() {
  const candidates = [
    process.env.GY_GOALS_PATH,
    join(__dirname, "goals-hosted.json"),
    join(INSTALL_ROOT, "examples/tsecbench/goals-autonomous.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { path: p, goals: parsed };
    }
  }
  fail("No goals file found.");
}

function createLogTailer(taskDataDir, slotCount) {
  const offsets = new Map();
  const files = [];
  if (slotCount <= 1) {
    files.push({ label: "w0", path: join(taskDataDir, "worker.log") });
  } else {
    for (let s = 0; s < slotCount; s++) {
      files.push({ label: `w${s}`, path: join(taskDataDir, `worker-w${s}.log`) });
    }
  }
  return () => {
    for (const f of files) {
      if (!existsSync(f.path)) continue;
      try {
        const size = statSync(f.path).size;
        const prev = offsets.get(f.path) ?? 0;
        if (size <= prev) continue;
        const chunkLen = Math.min(size - prev, 16_384);
        const buf = Buffer.allocUnsafe(chunkLen);
        const fd = openSync(f.path, "r");
        try {
          readSync(fd, buf, 0, chunkLen, prev);
        } finally {
          closeSync(fd);
        }
        offsets.set(f.path, prev + chunkLen);
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) {
            process.stdout.write(`[${f.label}] ${trimmed.slice(0, 400)}\n`);
          }
        }
      } catch {
        /* ignore transient read */
      }
    }
  };
}

async function main() {
  const cfg = resolveRuntimeConfig();
  mkdirSync(DATA_ROOT, { recursive: true });
  writeBenchmarkEnvFiles(cfg.benchmarkBase, cfg.benchmarkToken);

  log(
    `starting GongYuAI hosted agent | provider=${cfg.provider} model=${cfg.modelId} ` +
      `baseUrl=${cfg.baseUrl} apiKeySource=${cfg.apiKeySource} concurrency=${cfg.concurrency} ` +
      `vision=${cfg.visionEnabled ? "on" : "off"} benchmark=${cfg.benchmarkBase}`,
  );

  const probe = await probeBenchmarkReady(cfg.benchmarkBase, cfg.benchmarkToken);
  if (probe.alreadyFinished) {
    process.exit(0);
  }

  const plane = await bootControlPlane({
    dataRoot: DATA_ROOT,
    host: HOST,
    port: PORT,
    runtime: "local",
  });

  let shuttingDown = false;
  let activeTaskId = null;

  const shutdown = async (signalName) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signalName}, stopping task and control plane...`);
    if (activeTaskId) {
      try {
        await fetch(`${plane.url}/tasks/${activeTaskId}/stop`, {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        /* ignore */
      }
    }
    try {
      await plane.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Apply hosted model, auto-approval, and offline settings before creating task.
  plane.settings.patchModel({
    provider: cfg.provider,
    modelId: cfg.modelId,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    visionEnabled: cfg.visionEnabled,
    visionModelId: cfg.visionModelId,
  });
  plane.settings.saveChatApproval({
    scope: "read-only",
    confirmation: "auto",
    reviewer: null,
  });
  plane.settings.patchKnowledgeEmbedding({ enabled: false });
  Object.assign(process.env, plane.settings.workerEnv());

  const { path: goalsPath, goals } = loadGoals();
  log(`control plane ready at ${plane.url} | goals=${goalsPath}`);

  const createPayload = CreateTaskRequestSchema.parse({
    tenantId: "default",
    name: process.env.GY_TASK_NAME || "tsecbench-v2-hosted",
    mock: false,
    auth: {
      authorizationNote:
        process.env.GY_AUTH_NOTE ||
        `TSecBench hosted official evaluation (token ${cfg.benchmarkToken.slice(0, 8)}…)`,
      targets: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "*"],
      outOfScope: [],
      capability: "full",
    },
    goals,
    execution: {
      maxConcurrentExplores: cfg.concurrency,
    },
    budget: {
      maxTokens: Number(process.env.GY_MAX_TOKENS || BUDGET_UNLIMITED),
      maxWallMs: Number(process.env.GY_MAX_WALL_MS || BUDGET_UNLIMITED),
      maxToolCalls: Number(process.env.GY_MAX_TOOL_CALLS || BUDGET_UNLIMITED),
      maxInstalls: Number(process.env.GY_MAX_INSTALLS || BUDGET_UNLIMITED),
      relayTokenThreshold: Number(process.env.GY_RELAY_TOKEN_THRESHOLD || 30_000),
      relayMinToolCalls: Number(process.env.GY_RELAY_MIN_TOOL_CALLS || 2),
    },
  });

  const createdRes = await fetch(`${plane.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createPayload),
  });
  const createdText = await createdRes.text();
  if (createdRes.status >= 400) {
    await plane.close();
    fail(`POST /tasks failed (${createdRes.status}): ${createdText}`);
  }
  const created = JSON.parse(createdText);
  const task = created.task;
  activeTaskId = task.id;
  const slotCount = cfg.concurrency <= 1 ? 1 : cfg.concurrency + 1;
  log(`launched task=${task.id} status=${task.status} slots=${slotCount} dataDir=${task.dataDir}`);

  const tailLogs = createLogTailer(task.dataDir, slotCount);
  let lastHeartbeatAt = 0;

  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, 5_000));
    tailLogs();
    try {
      const stRes = await fetch(`${plane.url}/tasks/${task.id}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (stRes.status >= 400) continue;
      const stJson = await stRes.json();
      const cur = stJson.task;
      if (!cur) continue;

      const now = Date.now();
      if (now - lastHeartbeatAt >= 60_000) {
        lastHeartbeatAt = now;
        const u = cur.usage || {};
        const pids = Array.isArray(cur.workerPids) ? cur.workerPids.length : 0;
        log(
          `heartbeat status=${cur.status} workers=${pids} ` +
            `tokens=${u.tokens ?? 0} tools=${u.toolCalls ?? 0}` +
            `${cur.error ? ` note=${String(cur.error).slice(0, 120)}` : ""}`,
        );
      }

      if (isTerminalTaskStatus(cur.status)) {
        tailLogs();
        const u = cur.usage || {};
        log(
          `task finished: status=${cur.status} tokens=${u.tokens ?? 0} ` +
            `tools=${u.toolCalls ?? 0} error=${cur.error ?? "none"}`,
        );
        await plane.close();
        process.exit(cur.status === "failed" && (u.toolCalls ?? 0) === 0 ? 1 : 0);
      }
    } catch (err) {
      log(`status poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack || err.message : String(err));
});
