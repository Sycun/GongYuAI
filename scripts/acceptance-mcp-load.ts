/**
 * 验收：设置与功能 → MCP「加载方式」两种设置的真实行为。
 *
 * 用本地 HTTP 测试连接器（echo-fixture）核对：
 * - 按需加载：新任务目录里有该连接器（任务能看到目录摘要），启动阶段没有任何连接记录。
 * - 启动时加载：新任务启动阶段出现连接尝试（连接器收到 initialize/tools/list，
 *   history 记录 enable_mcp 闸门事件，tools-runtime.json 收录启用集）。
 * - 刷新（GET /settings）与重扫目录（POST /settings/tools/rescan）后，已保存的选择不变。
 * - 常开核（CORE_MCP_IDS）在关闭偏好时仍随任务启动加载，公开视图标记 startupForced。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { CORE_MCP_IDS } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";

const CONNECTOR_ID = "echo-fixture";

type RequestRecord = { method: string; at: number };

type SettingsView = {
  mcpServers: Array<{ id: string; enabled: boolean; startupForced: boolean }>;
};

type ManifestView = {
  mcpServers: Array<{ id: string }>;
  mcpPool: Array<{ id: string }>;
  mcpCatalog: Array<{ id: string; name: string; description: string }>;
};

type HistoryEvent = {
  kind: string;
  payload: Record<string, unknown>;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`断言失败：${message}`);
}

function toolGateEventsFor(events: HistoryEvent[], serverId: string): HistoryEvent[] {
  return events.filter(
    (e) =>
      e.kind === "tool_gate" &&
      e.payload.tool === "enable_mcp" &&
      e.payload.serverId === serverId,
  );
}

async function createTaskAndWaitForWorker(
  planeUrl: string,
  name: string,
): Promise<{ id: string; dataDir: string; manifest: ManifestView }> {
  const created = await json<{ task: { id: string; dataDir: string } }>(
    `${planeUrl}/tasks`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        mock: false,
        auth: {
          authorizationNote: "Local acceptance: MCP load-method fixture owned by operator",
          targets: ["example.invalid"],
          capability: "full",
        },
        goals: [
          { id: "g1", title: "noop", description: "MCP load-method acceptance", evidencePatterns: ["recon/*.txt"] },
        ],
        budget: { maxTokens: 1000, maxWallMs: 30_000, maxToolCalls: 10, maxInstalls: 1 },
      }),
    },
  );
  const manifestPath = join(created.task.dataDir, "manifest.json");
  for (let i = 0; i < 100 && !existsSync(manifestPath); i++) {
    await sleep(100);
  }
  assert(existsSync(manifestPath), `${name}: manifest 未生成`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestView;
  return { ...created.task, manifest };
}

async function stopTask(planeUrl: string, taskId: string): Promise<void> {
  await fetch(`${planeUrl}/tasks/${taskId}/stop`, { method: "POST" }).catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    const st = await json<{ task: { status: string } }>(`${planeUrl}/tasks/${taskId}`);
    if (["stopped", "failed", "completed", "budget_exhausted", "incomplete"].includes(st.task.status)) return;
    await sleep(200);
  }
}

async function main(): Promise<void> {
  // 模型指向死端口且无密钥：worker 在完成启动阶段 MCP 连接后立即失败，
  // 验收只关心启动阶段，不让真实模型调用参与。
  delete process.env.OPENAI_API_KEY;
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-mcp-load-"));

  // 1) 本地测试连接器：记录收到的每个 JSON-RPC 请求。
  const requests: RequestRecord[] = [];
  const echoServer: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let msg: { jsonrpc?: string; id?: number; method?: string } = {};
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        /* fallthrough */
      }
      if (msg.method) requests.push({ method: msg.method, at: Date.now() });
      const id = msg.id ?? 0;
      const send = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (msg.method === "initialize") {
        send({
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: CONNECTOR_ID, version: "0.0.1" },
        });
      } else if (msg.method === "tools/list") {
        send({
          tools: [
            {
              name: "echo",
              description: "回显输入",
              inputSchema: { type: "object", properties: { message: { type: "string" } } },
            },
          ],
        });
      } else {
        send({ content: [{ type: "text", text: "ok" }] });
      }
    });
  });
  await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve));
  const echoPort = (echoServer.address() as { port: number }).port;
  const connectorUrl = `http://127.0.0.1:${echoPort}/mcp`;

  const plane = await bootControlPlane({
    dataRoot,
    host: "127.0.0.1",
    port: 0,
    runtime: "local",
    leaseMs: 5_000,
    watchdogMs: 1_000,
  });
  try {
    await json(`${plane.url}/settings/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:9", apiKey: "", modelId: "acceptance-fixture" }),
    });

    // 2) 登记测试连接器。
    await json(`${plane.url}/settings/tools/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: CONNECTOR_ID,
        name: "本地回声连接器",
        enabled: true,
        transport: "http",
        url: connectorUrl,
      }),
    });

    // 常开核标记：nmap 等关闭偏好后公开视图仍应显示为系统固定启动加载。
    const coreView = await json<SettingsView>(`${plane.url}/settings`);
    for (const id of CORE_MCP_IDS) {
      const entry = coreView.mcpServers.find((s) => s.id === id);
      assert(entry, `常开核 ${id} 缺失`);
      assert(entry!.startupForced === true, `常开核 ${id} 未标记 startupForced`);
    }
    const connector = (await json<SettingsView>(`${plane.url}/settings`)).mcpServers.find(
      (s) => s.id === CONNECTOR_ID,
    );
    assert(connector, "测试连接器未登记");
    assert(connector!.startupForced === false, "测试连接器不应被标记 startupForced");

    // ── Arm A：按需加载 ────────────────────────────────────────────
    await json(`${plane.url}/settings/tools/toggle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mcp", id: CONNECTOR_ID, enabled: false }),
    });
    let view = await json<SettingsView>(`${plane.url}/settings`);
    let entry = view.mcpServers.find((s) => s.id === CONNECTOR_ID);
    assert(entry?.enabled === false, "Arm A：切换按需加载未保存");

    const markerA = requests.length;
    const taskA = await createTaskAndWaitForWorker(plane.url, "mcp-load-ondemand");
    // 目录摘要可见：catalog/pool 收录、启动启用集不含。
    assert(
      taskA.manifest.mcpCatalog.some((s) => s.id === CONNECTOR_ID),
      "Arm A：目录摘要未收录测试连接器",
    );
    assert(
      taskA.manifest.mcpPool.some((s) => s.id === CONNECTOR_ID),
      "Arm A：mcpPool 未收录测试连接器",
    );
    assert(
      !taskA.manifest.mcpServers.some((s) => s.id === CONNECTOR_ID),
      "Arm A：按需加载不应进入启动启用集",
    );
    // 等 worker 走完启动阶段（含 watchdog 至少一次重启，证明循环在跑）。
    const workerLogA = join(taskA.dataDir, "worker.log");
    for (let i = 0; i < 80; i++) {
      if (existsSync(workerLogA) && readFileSync(workerLogA, "utf8").includes("[gy-worker]")) break;
      await sleep(250);
    }
    assert(existsSync(workerLogA), "Arm A：worker 日志缺失，无法证明启动阶段已执行");
    await sleep(4_000);

    // 启动阶段没有连接记录：连接器零请求、无闸门事件、无进度记录。
    const receivedA = requests.slice(markerA);
    assert(receivedA.length === 0, `Arm A：启动阶段出现连接（${receivedA.map((r) => r.method).join(",")}）`);

    await stopTask(plane.url, taskA.id);
    const historyA = openHistory({
      dbPath: join(taskA.dataDir, "history.sqlite"),
      evidenceDir: join(taskA.dataDir, "evidence"),
    });
    let eventsA: HistoryEvent[] = [];
    try {
      eventsA = historyA.listEvents(taskA.id) as HistoryEvent[];
    } finally {
      historyA.close();
    }
    assert(
      toolGateEventsFor(eventsA, CONNECTOR_ID).length === 0,
      "Arm A：启动阶段存在 enable_mcp 闸门记录",
    );
    const progressA = existsSync(join(taskA.dataDir, "workspace", "PROGRESS.md"))
      ? readFileSync(join(taskA.dataDir, "workspace", "PROGRESS.md"), "utf8")
      : "";
    assert(!progressA.includes(CONNECTOR_ID), "Arm A：PROGRESS.md 提及测试连接器");
    // 反证：同批默认启动加载的内置项在启动阶段确实留下了连接记录。
    assert(
      toolGateEventsFor(eventsA, "nmap").length > 0,
      "Arm A：内置启动加载项无连接记录，反证失效",
    );

    // 刷新 + 重扫后仍为按需加载。
    view = await json<SettingsView>(`${plane.url}/settings`);
    assert(
      view.mcpServers.find((s) => s.id === CONNECTOR_ID)?.enabled === false,
      "Arm A：刷新后选择丢失",
    );
    view = await json<SettingsView>(`${plane.url}/settings/tools/rescan`, { method: "POST" });
    assert(
      view.mcpServers.find((s) => s.id === CONNECTOR_ID)?.enabled === false,
      "Arm A：重扫目录后选择丢失",
    );
    console.log("[mcp-load] 按需加载 PASS：目录摘要可见，启动阶段零连接，刷新/重扫保持");

    // ── Arm B：启动时加载 ──────────────────────────────────────────
    await json(`${plane.url}/settings/tools/toggle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mcp", id: CONNECTOR_ID, enabled: true }),
    });
    view = await json<SettingsView>(`${plane.url}/settings`);
    assert(
      view.mcpServers.find((s) => s.id === CONNECTOR_ID)?.enabled === true,
      "Arm B：切换启动时加载未保存",
    );

    const markerB = requests.length;
    const taskB = await createTaskAndWaitForWorker(plane.url, "mcp-load-startup");
    assert(
      taskB.manifest.mcpServers.some((s) => s.id === CONNECTOR_ID),
      "Arm B：启动时加载未进入启动启用集",
    );
    // 启动阶段出现连接尝试：连接器收到 initialize + tools/list。
    let attempts = 0;
    for (let i = 0; i < 80; i++) {
      attempts = requests.slice(markerB).filter((r) => r.method === "initialize").length;
      if (attempts > 0) break;
      await sleep(250);
    }
    assert(attempts > 0, "Arm B：启动阶段没有连接尝试");

    await stopTask(plane.url, taskB.id);
    const historyB = openHistory({
      dbPath: join(taskB.dataDir, "history.sqlite"),
      evidenceDir: join(taskB.dataDir, "evidence"),
    });
    let eventsB: HistoryEvent[] = [];
    try {
      eventsB = historyB.listEvents(taskB.id) as HistoryEvent[];
    } finally {
      historyB.close();
    }
    const gateB = toolGateEventsFor(eventsB, CONNECTOR_ID);
    assert(gateB.length > 0 && gateB.every((e) => e.payload.ok === true), "Arm B：启动阶段无成功闸门记录");
    assert(
      requests.slice(markerB).some((r) => r.method === "tools/list"),
      "Arm B：启动阶段未完成工具枚举",
    );
    const runtimeB = JSON.parse(
      readFileSync(join(taskB.dataDir, "tools-runtime.json"), "utf8"),
    ) as { mcpEnabledIds: string[] };
    assert(runtimeB.mcpEnabledIds.includes(CONNECTOR_ID), "Arm B：启动加载未写入运行时启用集");

    // 刷新 + 重扫后仍为启动时加载。
    view = await json<SettingsView>(`${plane.url}/settings`);
    assert(
      view.mcpServers.find((s) => s.id === CONNECTOR_ID)?.enabled === true,
      "Arm B：刷新后选择丢失",
    );
    view = await json<SettingsView>(`${plane.url}/settings/tools/rescan`, { method: "POST" });
    assert(
      view.mcpServers.find((s) => s.id === CONNECTOR_ID)?.enabled === true,
      "Arm B：重扫目录后选择丢失",
    );
    console.log("[mcp-load] 启动时加载 PASS：启动阶段有连接尝试，刷新/重扫保持");
    console.log("[mcp-load] PASS");
  } finally {
    await plane.close().catch(() => undefined);
    await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[mcp-load] FAIL", err);
  process.exit(1);
});
