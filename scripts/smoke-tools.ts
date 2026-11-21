/**
 * Smoke: folder-discovered MCP/Skill + enabled gate on WorkerManifest.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootControlPlane } from "@gongyuai/control-plane";

async function main() {
  const dataRoot = mkdtempSync(join(tmpdir(), "gy-tools-"));
  const plane = await bootControlPlane({
    dataRoot,
    host: "127.0.0.1",
    port: 8798,
    runtime: "local",
    leaseMs: 30_000,
    watchdogMs: 5_000,
  });

  try {
    const settingsRes = await fetch(`${plane.url}/settings`);
    const settings = (await settingsRes.json()) as {
      mcpServers: Array<{ id: string; enabled: boolean }>;
      skillPacks: Array<{ id: string; enabled: boolean }>;
    };
    if (!settingsRes.ok) throw new Error(JSON.stringify(settings));

    const ids = settings.mcpServers.map((s) => s.id);
    if (ids.includes("kali") || ids.includes("kali-tools")) {
      throw new Error("monolithic kali MCP must not exist");
    }
    for (const need of ["nmap", "httpx", "nuclei", "sqlmap", "subfinder"]) {
      if (!ids.includes(need)) throw new Error(`missing builtin mcp ${need}`);
    }
    if (ids.length < 20) {
      throw new Error(`expected rich builtin MCP catalog, got ${ids.length}`);
    }
    for (const need of ["recon", "web-app", "evidence-first"]) {
      if (!settings.skillPacks.some((s) => s.id === need)) {
        throw new Error(`missing skill ${need}`);
      }
    }

    const off = await fetch(`${plane.url}/settings/tools/toggle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mcp", id: "nmap", enabled: false }),
    });
    if (!off.ok) throw new Error(await off.text());

    const createRes = await fetch(`${plane.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "tools-visibility",
        mock: true,
        auth: {
          authorizationNote: "Written authorization: tools smoke owned by operator",
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
        budget: {
          maxTokens: 10_000,
          maxWallMs: 60_000,
          maxToolCalls: 20,
          maxInstalls: 5,
        },
      }),
    });
    const created = (await createRes.json()) as {
      task: { id: string; dataDir: string };
    };
    if (!createRes.ok) throw new Error(JSON.stringify(created));

    const manifestPath = join(created.task.dataDir, "manifest.json");
    for (let i = 0; i < 20 && !existsSync(manifestPath); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      mcpServers: Array<{ id: string; rootDir?: string }>;
      skillPacks: Array<{ id: string }>;
    };
    if (manifest.mcpServers.some((s) => s.id === "nmap")) {
      throw new Error("nmap disabled but still on manifest");
    }
    if (!manifest.mcpServers.some((s) => s.id === "httpx" && s.rootDir)) {
      throw new Error("httpx enabled but missing rootDir on manifest");
    }
    if (!manifest.skillPacks.some((s) => s.id === "recon")) {
      throw new Error("recon skill missing from manifest");
    }

    await fetch(`${plane.url}/settings/tools/toggle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mcp", id: "nmap", enabled: true }),
    });

    console.log(
      `[smoke-tools] ok — ${ids.length} MCP, ${settings.skillPacks.length} skills; visibility gate works`,
    );

    await fetch(`${plane.url}/tasks/${created.task.id}/stop`, { method: "POST" }).catch(
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    await plane.close().catch(() => undefined);
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
