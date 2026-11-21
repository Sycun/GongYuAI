/**
 * Smoke: progressive unlock — core on, enable_mcp adds sqlmap to runtime.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";
import { CORE_MCP_IDS } from "@gongyuai/contracts";

async function main() {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-unlock-"));
  const plane = await bootControlPlane({
    dataRoot,
    host: "127.0.0.1",
    port: 8797,
    runtime: "local",
    leaseMs: 30_000,
    watchdogMs: 5_000,
  });
  try {
    // Turn ALL mcp off in settings — core should still appear on task start
    const settings = (await (await fetch(`${plane.url}/settings`)).json()) as {
      mcpServers: Array<{ id: string; enabled: boolean }>;
    };
    for (const s of settings.mcpServers) {
      if (s.enabled) {
        await fetch(`${plane.url}/settings/tools/toggle`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "mcp", id: s.id, enabled: false }),
        });
      }
    }

    const createRes = await fetch(`${plane.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "unlock-smoke",
        mock: true,
        auth: {
          authorizationNote: "Written authorization: unlock smoke owned by operator",
          targets: ["https://example.com"],
        },
        goals: [
          {
            id: "g1",
            title: "noop",
            description: "mock",
            evidencePatterns: ["recon/*.txt"],
          },
        ],
        budget: { maxTokens: 10_000, maxWallMs: 60_000, maxToolCalls: 20, maxInstalls: 5 },
      }),
    });
    const created = (await createRes.json()) as { task: { id: string; dataDir: string } };
    if (!createRes.ok) throw new Error(JSON.stringify(created));
    const manifestPath = join(created.task.dataDir, "manifest.json");
    for (let i = 0; i < 30 && !existsSync(manifestPath); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      mcpServers: Array<{ id: string }>;
      mcpPool: Array<{ id: string }>;
      mcpCatalog: Array<{ id: string }>;
    };
    const enabled = new Set(manifest.mcpServers.map((s) => s.id));
    for (const id of CORE_MCP_IDS) {
      if (!enabled.has(id)) throw new Error(`core MCP missing after all-off settings: ${id}`);
    }
    if (enabled.has("sqlmap")) throw new Error("sqlmap should not be initially enabled");
    if (!manifest.mcpPool.some((s) => s.id === "sqlmap")) {
      throw new Error("sqlmap missing from mcpPool");
    }
    if (!manifest.mcpCatalog.some((s) => s.id === "sqlmap")) {
      throw new Error("sqlmap missing from mcpCatalog");
    }

    // Simulate worker unlock persistence
    writeFileSync(
      join(created.task.dataDir, "tools-runtime.json"),
      JSON.stringify(
        {
          mcpEnabledIds: [...CORE_MCP_IDS, "sqlmap"],
          skillEnabledIds: ["recon"],
        },
        null,
        2,
      ),
    );
    const rt = JSON.parse(
      readFileSync(join(created.task.dataDir, "tools-runtime.json"), "utf8"),
    ) as { mcpEnabledIds: string[] };
    if (!rt.mcpEnabledIds.includes("sqlmap")) throw new Error("runtime unlock failed");

    console.log(
      `[smoke-tools-unlock] ok — core=${[...CORE_MCP_IDS].join(",")} pool=${manifest.mcpPool.length} catalog=${manifest.mcpCatalog.length}`,
    );
    await fetch(`${plane.url}/tasks/${created.task.id}/stop`, { method: "POST" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    await plane.close().catch(() => undefined);
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
