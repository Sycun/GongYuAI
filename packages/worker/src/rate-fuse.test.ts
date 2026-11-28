import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { detectProxyConcurrencyAntipattern } from "./exec-tools.js";
import { httpRequestTool } from "./http-tools.js";
import {
  ADAPTIVE_RATE_FUSE_THRESHOLD,
  TargetOverloadTracker,
  formatAdaptiveRateFuse,
  recordShellConnectionSignals,
} from "./loop-shared.js";

test("detectProxyConcurrencyAntipattern：精准拦截代理链高并发，单连接零误伤", () => {
  // Single-connection proxychains usage must always pass.
  for (const command of [
    "proxychains4 curl -sS http://10.0.0.5/",
    "proxychains4 python3 exploit.py",
    "proxychains4 -q ssh user@10.0.0.5",
    "ssh -D 1080 user@10.0.0.5",
    "nmap -sT 10.0.0.0/24",
    "ffuf -w /tmp/wl -u http://10.0.0.5/FUZZ",
  ]) {
    assert.equal(detectProxyConcurrencyAntipattern(command), null, command);
  }

  // Explicit serial / rate-limited fuzzing through the chain is allowed.
  for (const command of [
    "proxychains4 ffuf -t 1 -w /tmp/wl -u http://10.0.0.5/FUZZ",
    "proxychains4 ffuf -w /tmp/wl -u http://10.0.0.5/FUZZ -rate 10",
    "proxychains4 gobuster dir -u http://10.0.0.5 -w /tmp/wl -t 1",
    "proxychains4 gobuster dir -u http://10.0.0.5 -w /tmp/wl --delay 500ms",
    "proxychains4 dirb http://10.0.0.5 -z 500",
    "proxychains4 wfuzz -t 1 -w /tmp/wl http://10.0.0.5/FUZZ",
  ]) {
    assert.equal(detectProxyConcurrencyAntipattern(command), null, command);
  }

  // High-connection brute force is always rejected through the chain.
  for (const command of [
    "proxychains4 hydra -l admin -P /tmp/pass.txt 10.0.0.5 ssh",
    "proxychains4 -f /etc/proxychains.conf -q medusa -h 10.0.0.5 -u admin -P /tmp/pass.txt ssh",
    "proxychains4 ncrack -p 22 --user admin -P /tmp/pass.txt 10.0.0.5",
  ]) {
    const denial = detectProxyConcurrencyAntipattern(command);
    assert.ok(denial, command);
    assert.match(denial!, /proxychains/);
    assert.match(denial!, /tunnel_open/);
  }

  // Fuzz tools without serial/rate flags are rejected only when proxychained.
  for (const command of [
    "proxychains4 ffuf -w /tmp/wl -u http://10.0.0.5/FUZZ",
    "proxychains4 gobuster dir -u http://10.0.0.5 -w /tmp/wl",
    "proxychains4 dirb http://10.0.0.5",
    "proxychains4 wfuzz -w /tmp/wl http://10.0.0.5/FUZZ",
  ]) {
    const denial = detectProxyConcurrencyAntipattern(command);
    assert.ok(denial, command);
    assert.match(denial!, /单线程|限速|tunnel_open/);
  }
});

test("TargetOverloadTracker：连续异常触发熔断提示，正常响应自动清零", () => {
  const tracker = new TargetOverloadTracker();
  assert.equal(tracker.record("10.0.0.5", { status: 0 }), 1);
  assert.equal(tracker.record("10.0.0.5", { status: 502 }), 2);
  assert.ok(tracker.count("10.0.0.5") >= ADAPTIVE_RATE_FUSE_THRESHOLD);
  const fuse = formatAdaptiveRateFuse("10.0.0.5", tracker.count("10.0.0.5"));
  assert.match(fuse, /\[ADAPTIVE_RATE_FUSE · 目标连接异常降速保护\]/);
  assert.match(fuse, /--rate 10/);

  // A normal response resets this host immediately.
  assert.equal(tracker.record("10.0.0.5", { status: 200 }), 0);
  assert.equal(tracker.count("10.0.0.5"), 0);
  assert.equal(tracker.record("10.0.0.5", { status: 504 }), 1);

  // 404 / 401 are normal responses too (target alive, no anomaly accumulation).
  tracker.record("10.0.0.6", { status: 0 });
  assert.equal(tracker.record("10.0.0.6", { status: 404 }), 0);
  assert.equal(tracker.count("10.0.0.6"), 0);

  // Connection errors with a null status count as anomalies.
  assert.equal(
    tracker.record("10.0.0.7", { error: "connect ECONNREFUSED 10.0.0.7:443" }),
    1,
  );
  assert.equal(
    tracker.record("10.0.0.7", { error: "ETIMEDOUT" }),
    2,
  );
  tracker.reset();
  assert.equal(tracker.count("10.0.0.7"), 0);
});

test("recordShellConnectionSignals：shell 中的 curl 000/连接拒绝连续两次触发熔断", () => {
  const tracker = new TargetOverloadTracker();
  const command = "curl -sS -o /dev/null -w '%{http_code}' http://10.0.0.5/health";
  assert.equal(recordShellConnectionSignals(command, "000\n", tracker), null);
  const fuse = recordShellConnectionSignals(command, "000\n", tracker);
  assert.ok(fuse);
  assert.match(fuse!, /ADAPTIVE_RATE_FUSE/);

  const reset = new TargetOverloadTracker();
  const refused = "curl: (7) Failed to connect to 10.0.0.6 port 80: Connection refused";
  assert.equal(recordShellConnectionSignals("curl http://10.0.0.6/", refused, reset), null);
  const fuse2 = recordShellConnectionSignals("curl http://10.0.0.6/", refused, reset);
  assert.match(fuse2 ?? "", /10\.0\.0\.6/);
  assert.equal(
    recordShellConnectionSignals("curl -i http://10.0.0.6/", "HTTP/1.1 200 OK\r\n\r\nok", reset),
    null,
  );
  assert.equal(reset.count("10.0.0.6"), 0);
});

test("http_request 集成：连续连接失败在第二次响应附带 rateFuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "gy-fuse-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const manifest: WorkerManifest = {
    taskId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    dataDir: root,
    historyDb: join(root, "h.sqlite"),
    durableDb: join(root, "d.sqlite"),
    evidenceDir,
    workspaceDir: join(root, "workspace"),
    auth: { authorizationNote: "rate fuse fixture", targets: ["127.0.0.1"], outOfScope: [], capability: "full" },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    workerId: "w0",
    workerSlot: 0,
    workerCount: 1,
    commandConfirmation: "auto",
    mock: false,
    mcpServers: [], mcpPool: [], mcpCatalog: [], skillPacks: [], skillPool: [], skillCatalog: [], assetCollectors: [],
  };
  mkdirSync(manifest.workspaceDir, { recursive: true });
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir });
  const ctx = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  try {
    const url = "http://127.0.0.1:1/never";
    const first = JSON.parse(await httpRequestTool(ctx, { url, timeoutMs: "2000" })) as {
      ok: boolean;
      rateFuse?: string;
    };
    assert.equal(first.ok, false);
    assert.equal(first.rateFuse, undefined);
    const second = JSON.parse(await httpRequestTool(ctx, { url, timeoutMs: "2000" })) as {
      ok: boolean;
      rateFuse?: string;
    };
    assert.equal(second.ok, false);
    assert.match(second.rateFuse ?? "", /ADAPTIVE_RATE_FUSE/);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});