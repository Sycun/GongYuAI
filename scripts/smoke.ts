/**
 * End-to-end smoke: mock worker closed loop + crash recovery.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
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
        targets: ["https://example.com"],
        outOfScope: [],
      },
      goals: JSON.parse(readFileSync(goalsPath, "utf8")),
      budget: {
        maxTokens: 100000,
        maxWallMs: 120000,
        maxToolCalls: 100,
        maxInstalls: 10,
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
      const final = st.task.status;
      if (final !== "completed") {
        throw new Error(`expected completed, got ${final}`);
      }
      console.log("[smoke] PASS");
      console.log(report.slice(0, 500));
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
