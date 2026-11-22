/**
 * End-to-end smoke: mock worker closed loop + crash recovery.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function checkWallTimeout(url: string, goals: unknown) {
  const response = await fetch(`${url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "smoke-wall-timeout",
      mock: true,
      auth: {
        authorizationNote: "Local mock for deadline and evidence API",
        targets: ["example.invalid"],
        capability: "observe",
      },
      goals,
      // Watchdog expires while the mock worker is in its scripted pause.
      budget: { maxWallMs: 300 },
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const { task } = await response.json() as { task: { id: string; dataDir: string } };
  const taskUrl = `${url}/tasks/${task.id}`;
  const evidenceDir = join(task.dataDir, "evidence");
  const fixture = join(task.dataDir, "outside-fixture.txt");
  writeFileSync(fixture, "outside fixture");
  symlinkSync(fixture, join(evidenceDir, "outside-link.txt"));
  writeFileSync(join(evidenceDir, "inside.txt"), "inside fixture");
  const inside = await fetch(`${taskUrl}/evidence/file?path=inside.txt`);
  if (!inside.ok || await inside.text() !== "inside fixture") {
    throw new Error("valid evidence unavailable from API");
  }
  const denied = await fetch(`${taskUrl}/evidence/file?path=outside-link.txt`);
  if (denied.status !== 404) throw new Error("evidence API did not reject a symbolic link");
  const listed = await (await fetch(`${taskUrl}/evidence`)).json() as {
    files: Array<{ path: string }>;
  };
  if (listed.files.some((file) => file.path === "outside-link.txt")) {
    throw new Error("evidence API listed a symbolic link");
  }

  for (let i = 0; i < 50; i++) {
    const result = await (await fetch(taskUrl)).json() as { task: { status: string; error: string } };
    if (result.task.status === "budget_exhausted") {
      const report = await (await fetch(`${taskUrl}/report`)).text();
      if (!report.includes("Status: budget_exhausted") ||
          !report.includes("Reason: maxWallMs exceeded") ||
          !report.includes("## 逐项目标复核")) {
        throw new Error("wall timeout did not publish the terminal report");
      }
      const history = await (await fetch(`${taskUrl}/history`)).json() as {
        events: Array<{ kind: string }>;
      };
      if (history.events.filter((event) => event.kind === "report_written").length !== 1) {
        throw new Error("wall timeout did not record exactly one report");
      }
      const runtime = await (await fetch(`${taskUrl}/runtime`)).json() as {
        workerStatus: { status: string; activeIntentId: string | null };
      };
      if (runtime.workerStatus.status !== "budget_exhausted" || runtime.workerStatus.activeIntentId !== null) {
        throw new Error("runtime exposes stale worker state after the wall timeout");
      }
      console.log("[smoke] wall timeout and evidence boundary PASS");
      return;
    }
    if (result.task.status === "failed") throw new Error(result.task.error);
    await sleep(200);
  }
  throw new Error("wall timeout task did not finish");
}

async function main() {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-smoke-"));
  const goalsPath = join(dataRoot, "goals.json");
  writeFileSync(
    goalsPath,
    JSON.stringify(
      [
        {
          id: "recon",
          title: "HTTP recon",
          description: "Capture banner",
          evidencePatterns: ["recon/*.txt"],
        },
        {
          id: "report",
          title: "Findings note",
          description: "Write findings",
          evidencePatterns: ["goals/*.md"],
        },
      ],
      null,
      2,
    ),
  );

  process.env.GY_ALLOW_STUB_INSTALL = "1";
  process.env.GY_SMOKE_PAUSE_MS = "2500";
  // P1 acceptance: low threshold + min tool-call guard so mock writes ≥1 π
  process.env.GY_RELAY_TOKEN_THRESHOLD = "1";
  process.env.GY_RELAY_MIN_TOOL_CALLS = "1";
  const plane = await bootControlPlane({
    dataRoot,
    host: "127.0.0.1",
    port: 8799,
    runtime: "local",
    leaseMs: 5_000,
    watchdogMs: 1_000,
  });

  console.log(`[smoke] plane ${plane.url} data=${dataRoot}`);

  const createRes = await fetch(`${plane.url}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantId: "default",
      name: "smoke",
      mock: true,
      auth: {
        authorizationNote: "Written authorization: local smoke target owned by operator",
        targets: ["example.invalid"],
        outOfScope: [],
        capability: "full",
      },
      goals: JSON.parse(readFileSync(goalsPath, "utf8")),
      budget: {
        maxTokens: 100000,
        maxWallMs: 120000,
        maxToolCalls: 100,
        maxInstalls: 10,
        relayTokenThreshold: 1,
        relayMinToolCalls: 1,
      },
    }),
  });
  const created = (await createRes.json()) as {
    task: { id: string; workerPid: number | null; status: string };
  };
  if (!createRes.ok) throw new Error(JSON.stringify(created));
  const taskId = created.task.id;
  console.log(`[smoke] task=${taskId} pid=${created.task.workerPid}`);

  // Wait until running, then kill worker to force recovery
  let killed = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await (await fetch(`${plane.url}/tasks/${taskId}`)).json() as {
      task: { status: string; workerPid: number | null };
    };
    console.log(`[smoke] status=${st.task.status} pid=${st.task.workerPid}`);
    if (!killed && st.task.workerPid && st.task.status === "running") {
      try {
        process.kill(st.task.workerPid, "SIGKILL");
        console.log(`[smoke] killed worker ${st.task.workerPid}`);
        killed = true;
      } catch (err) {
        console.log(`[smoke] kill skipped: ${err}`);
      }
    }
    if (["completed", "failed", "budget_exhausted"].includes(st.task.status)) {
      const report = await (await fetch(`${plane.url}/tasks/${taskId}/report`)).text();
      const evidenceBanner = join(dataRoot, "tasks", taskId, "evidence", "recon", "banner.txt");
      if (!existsSync(evidenceBanner)) {
        throw new Error("missing recon evidence");
      }
      if (!report.includes("GongYuAI Report")) {
        throw new Error("missing report");
      }
      const relay0 = join(dataRoot, "tasks", taskId, "workspace", "relay", "π0.json");
      if (!existsSync(relay0)) {
        throw new Error("missing Session Relay π0.json");
      }
      if (!report.includes("foothold") && !report.includes("Session Relay")) {
        throw new Error("report missing relay injection");
      }
      const progressPath = join(dataRoot, "tasks", taskId, "workspace", "PROGRESS.md");
      const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "";
      if (!progress.includes("phase=bootstrap") || !progress.includes("phase=explore")) {
        throw new Error("missing graph phase sequence in PROGRESS.md");
      }
      const final = st.task.status;
      if (final !== "completed") {
        throw new Error(`expected completed, got ${final}`);
      }
      await checkWallTimeout(plane.url, JSON.parse(readFileSync(goalsPath, "utf8")));
      console.log("[smoke] PASS");
      console.log(report.slice(0, 800));
      await plane.close();
      rmSync(dataRoot, { recursive: true, force: true });
      return;
    }
  }
  throw new Error("smoke timed out");
}

main().catch(async (err) => {
  console.error("[smoke] FAIL", err);
  process.exit(1);
});
