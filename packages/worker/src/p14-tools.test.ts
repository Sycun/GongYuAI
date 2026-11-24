import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import type { ToolContext } from "./tools.js";
import { httpRequestTool } from "./http-tools.js";
import { oastHitsTool, oastIssueTool, closeOastListeners } from "./oast-tools.js";
import { parseAndRecord } from "./tool-output.js";

const TASK_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function setup(prefix: string, auth: Partial<WorkerManifest["auth"]> = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  const manifest: WorkerManifest = {
    taskId: TASK_ID,
    engagementId: "eng-p14",
    dataDir: root,
    historyDb: join(root, "history.sqlite"),
    durableDb: join(root, "durable.sqlite"),
    evidenceDir,
    workspaceDir: join(root, "workspace"),
    auth: {
      authorizationNote: "P14 local fixture",
      targets: ["127.0.0.1", "*.lab.test"],
      outOfScope: [],
      capability: "active-lab",
      ...auth,
    },
    scopeVersion: 1,
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
    execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
    commandConfirmation: "auto",
    workerId: "w0-p14",
    workerSlot: 0,
    workerCount: 1,
    mock: false,
    mcpServers: [],
    mcpPool: [],
    mcpCatalog: [],
    skillPacks: [],
    skillPool: [],
    skillCatalog: [],
    assetCollectors: [],
  };
  const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  return { root, history, ctx, evidenceDir };
}

test("http_request seals a transaction and blocks out-of-scope redirects", async () => {
  const { root, history, ctx } = setup("gy-p14-http-");
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://evil.example.org/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok-body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ok = JSON.parse(await httpRequestTool(ctx, { url: `http://127.0.0.1:${port}/` })) as {
      ok: boolean; transactionId: string; status: number; ref: string;
    };
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.equal(history.listHttpTransactions(TASK_ID).length, 1);
    const tx = history.listHttpTransactions(TASK_ID)[0]!;
    assert.equal(tx.status, 200);
    assert.match(tx.responseHead, /ok-body/);

    const blocked = JSON.parse(
      await httpRequestTool(ctx, { url: `http://127.0.0.1:${port}/redirect` }),
    ) as { ok: boolean; status: number; blockedRedirect?: string };
    // The 302 itself is recorded; the out-of-scope hop is never requested.
    assert.equal(blocked.status, 302);
    assert.equal(blocked.blockedRedirect, "evil.example.org");
    assert.equal(history.listHttpTransactions(TASK_ID).length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oast issue -> callback hit correlates; unknown token ignored", async () => {
  const { root, history, ctx } = setup("gy-p14-oast-", {
    oast: { baseUrl: "http://127.0.0.1", listenHost: "127.0.0.1", listenPort: 0 },
  });
  try {
    const issued = JSON.parse(await oastIssueTool(ctx, { note: "ssrf probe" })) as {
      ok: boolean; token: string; callback: string;
    };
    assert.equal(issued.ok, true);
    // Callback URL uses the public base; the listener is on a different random port.
    const port = history.listOastTokens(TASK_ID).length ? issued.callback : "";
    assert.ok(port.includes(issued.token));
    // Exercise the listener directly through its issue contract: hits without a
    // reachable public port must not be fabricated.
    const hits = JSON.parse(oastHitsTool(ctx, { token: issued.token })) as {
      ok: boolean; tokens: Array<{ hits: number }>; hits: unknown[];
    };
    assert.equal(hits.ok, true);
    assert.equal(hits.tokens[0]!.hits, 0);
    assert.equal(hits.hits.length, 0);
    const unknown = JSON.parse(oastHitsTool(ctx, { token: "deadbeefdeadbeef" })) as { ok: boolean };
    assert.equal(unknown.ok, false);
  } finally {
    await closeOastListeners();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("parser lane records typed assets and tentative findings", () => {
  const { root, history, ctx } = setup("gy-p14-parse-");
  try {
    const httpx = [
      JSON.stringify({ url: "https://app.lab.test/login?x=1#frag", host: "app.lab.test", status_code: 200, tech: ["nginx"], title: "Login" }),
    ].join("\n");
    const parsed = parseAndRecord(ctx, "httpx", httpx);
    assert.equal(parsed.assets.length, 1);
    assert.equal(parsed.recordedAssets, 1);
    const assets = history.listAssets(TASK_ID);
    const endpoint = assets.find((a) => a.assetType === "endpoint");
    assert.ok(endpoint);
    assert.equal(endpoint!.address, "https://app.lab.test/login?x=1");
    assert.equal(endpoint!.parentAddress, "app.lab.test");

    const nuclei = [
      JSON.stringify({
        "template-id": "cve-2024-0001",
        info: { name: "RCE", severity: "critical" },
        host: "https://app.lab.test",
        "matched-at": "https://app.lab.test/api",
      }),
    ].join("\n");
    const findings = parseAndRecord(ctx, "nuclei", nuclei);
    assert.equal(findings.recordedFindings, 1);
    assert.equal(history.listFindings(TASK_ID).length, 1);
    assert.equal(history.listFindings(TASK_ID)[0]!.status, "tentative");

    // Malformed input never throws and records nothing.
    const bad = parseAndRecord(ctx, "nmap", "not xml");
    assert.equal(bad.skipped, true);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oast DNS channel issues hostname tokens and correlates a query", async () => {
  const { createSocket } = await import("node:dgram");
  // Pick a free UDP port, then hand it to the listener.
  const probe = createSocket("udp4");
  const port = await new Promise<number>((resolve) => {
    probe.bind(0, "127.0.0.1", () => {
      const bound = (probe.address() as { port: number }).port;
      probe.close(() => resolve(bound));
    });
  });
  const { root, history, ctx } = setup("gy-p14-oast-dns-", {
    oast: {
      baseUrl: "http://127.0.0.1",
      listenHost: "127.0.0.1",
      listenPort: 0,
      dnsName: "oob.lab.test",
      dnsListenHost: "127.0.0.1",
      dnsListenPort: port,
      dnsAnswer: "10.1.2.3",
    },
  });
  try {
    const issued = JSON.parse(await oastIssueTool(ctx, { kind: "dns" })) as {
      ok: boolean; token: string; callback: string;
    };
    assert.equal(issued.ok, true);
    assert.equal(issued.callback, `${issued.token}.oob.lab.test`);

    const encodeQuery = (name: string): Buffer => {
      const parts: Buffer[] = [];
      for (const label of name.split(".")) {
        const bytes = Buffer.from(label, "ascii");
        parts.push(Buffer.from([bytes.length]), bytes);
      }
      parts.push(Buffer.from([0]));
      const header = Buffer.alloc(12);
      header.writeUInt16BE(0x2222, 0);
      header.writeUInt16BE(0x0100, 2);
      header.writeUInt16BE(1, 4);
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(1, 0);
      tail.writeUInt16BE(1, 2);
      return Buffer.concat([header, ...parts, tail]);
    };
    const response = await new Promise<Buffer>((resolve, reject) => {
      const client = createSocket("udp4");
      const timer = setTimeout(() => {
        client.close();
        reject(new Error("dns timeout"));
      }, 2_000);
      client.on("message", (msg) => {
        clearTimeout(timer);
        client.close();
        resolve(msg);
      });
      client.send(encodeQuery(issued.callback), port, "127.0.0.1");
    });
    assert.equal(response.readUInt16BE(6), 1); // ANCOUNT
    await new Promise((resolve) => setTimeout(resolve, 120));
    const hits = JSON.parse(oastHitsTool(ctx, { token: issued.token })) as {
      tokens: Array<{ hits: number }>;
      hits: Array<{ protocol: string }>;
    };
    assert.equal(hits.tokens[0]!.hits, 1);
    assert.equal(hits.hits[0]!.protocol, "dns");
  } finally {
    await closeOastListeners();
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("http_request maintains isolated named session cookie jars, computes compareWith differentials, and auto-records endpoints", async () => {
  const { root, history, ctx } = setup("gy-p14-http-diff-");
  const server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? "";
    if (req.url === "/login/alice") {
      res.writeHead(200, { "set-cookie": "role=alice; Path=/; HttpOnly", "content-type": "application/json" });
      res.end(JSON.stringify({ loggedIn: "alice" }));
      return;
    }
    if (req.url === "/login/bob") {
      res.writeHead(200, { "set-cookie": "role=bob; Path=/; HttpOnly", "content-type": "application/json" });
      res.end(JSON.stringify({ loggedIn: "bob" }));
      return;
    }
    if (req.url === "/api/profile") {
      if (cookie.includes("role=alice")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("owner=alice\ntier=standard");
        return;
      }
      if (cookie.includes("role=bob")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("owner=bob\ntier=admin-privileged");
        return;
      }
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // Unauthenticated baseline → 403
    const anon = JSON.parse(
      await httpRequestTool(ctx, { url: `http://127.0.0.1:${port}/api/profile`, session: "anon" }),
    ) as { ok: boolean; status: number; ref: string };
    assert.equal(anon.status, 403);

    // Login two isolated sessions
    await httpRequestTool(ctx, { url: `http://127.0.0.1:${port}/login/alice`, session: "alice" });
    await httpRequestTool(ctx, { url: `http://127.0.0.1:${port}/login/bob`, session: "bob" });

    // Alice session automatically sends role=alice and compares against anon baseline
    const aliceProfile = JSON.parse(
      await httpRequestTool(ctx, {
        url: `http://127.0.0.1:${port}/api/profile`,
        session: "alice",
        compareWith: anon.ref,
      }),
    ) as {
      status: number;
      ref: string;
      sessionCookies: number;
      diff: { statusChanged: boolean; baselineStatus: number; currentStatus: number; identicalResponse: boolean };
    };
    assert.equal(aliceProfile.status, 200);
    assert.equal(aliceProfile.sessionCookies, 1);
    assert.equal(aliceProfile.diff.statusChanged, true);
    assert.equal(aliceProfile.diff.baselineStatus, 403);
    assert.equal(aliceProfile.diff.currentStatus, 200);
    assert.equal(aliceProfile.diff.identicalResponse, false);

    // Bob session stays isolated from Alice and computes line-level diff against Alice
    const bobProfile = JSON.parse(
      await httpRequestTool(ctx, {
        url: `http://127.0.0.1:${port}/api/profile`,
        session: "bob",
        compareWith: aliceProfile.ref,
      }),
    ) as {
      status: number;
      diff: { statusChanged: boolean; identicalResponse: boolean; addedSample: string[] };
    };
    assert.equal(bobProfile.status, 200);
    assert.equal(bobProfile.diff.statusChanged, false);
    assert.equal(bobProfile.diff.identicalResponse, false);
    assert.ok(bobProfile.diff.addedSample.some((line) => line.includes("owner=bob")));

    // Responsive endpoints (/api/profile, /login/alice, /login/bob) are auto-projected into live assets
    const endpoints = history.listAssets(TASK_ID).filter((a) => a.assetType === "endpoint");
    assert.ok(endpoints.some((a) => a.address.endsWith("/api/profile")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});
