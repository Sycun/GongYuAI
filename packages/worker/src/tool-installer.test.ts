import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerManifestSchema, type WorkerManifest } from "@gongyuai/contracts";
import { openHistory } from "@gongyuai/history";
import { openMcpHub } from "./mcp/client.js";
import { openSkillHub } from "./skills/runtime.js";
import {
  builtinBinaryAvailable,
  invalidateBinaryHealth,
  resolveInstallPlan,
  validateToolInstallSpec,
} from "./tool-installer.js";
import { installTool, type ToolContext } from "./tools.js";
import { installMcp, installSkill, verifyGithubRepo, type FetchLike } from "./trusted-registry.js";

function makeFixture(t: { after: (fn: () => void) => void }, opts?: { mock?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "gy-installer-"));
  const dataDir = join(root, "tasks", "task-test");
  const workspaceDir = join(dataDir, "workspace");
  const evidenceDir = join(dataDir, "evidence");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const manifest: WorkerManifest = WorkerManifestSchema.parse({
    taskId: "00000000-0000-4000-8000-000000000001",
    dataDir,
    historyDb: join(dataDir, "history.sqlite"),
    durableDb: join(dataDir, "durable.sqlite"),
    evidenceDir,
    workspaceDir,
    auth: {
      authorizationNote: "Unit test authorization",
      targets: ["example.invalid"],
      capability: "active-lab",
    },
    goals: [
      {
        id: "g1",
        title: "test",
        description: "test",
        evidencePatterns: ["recon/*.txt"],
        passes: false,
      },
    ],
    budget: { maxTokens: 10000, maxWallMs: 60000, maxToolCalls: 20, maxInstalls: 5 },
    mock: opts?.mock ?? true,
  });
  const history = openHistory({ dbPath: manifest.historyDb, evidenceDir });
  t.after(() => {
    history.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx: ToolContext = { manifest, history, usage: { toolCalls: 0, installs: 0 } };
  return { root, manifest, history, ctx };
}

test("resolveInstallPlan prefers Kali APT first, then official upstream go/pipx, then brew", () => {
  // Kali Linux with apt-cache having httpx-toolkit
  const kaliPlan = resolveInstallPlan(
    { name: "httpx", method: "auto" },
    {
      platform: "linux",
      hasCommand: (c) => c === "apt-get" || c === "go",
      aptHasPackage: (p) => p === "httpx-toolkit",
    },
  );
  assert.equal(kaliPlan.method, "apt");
  assert.equal(kaliPlan.package, "httpx-toolkit");
  assert.equal(kaliPlan.source, "kali-apt");

  // Linux where APT does not carry katana -> falls back to official ProjectDiscovery go install
  const goFallback = resolveInstallPlan(
    { name: "katana", method: "auto" },
    {
      platform: "linux",
      hasCommand: (c) => c === "apt-get" || c === "go",
      aptHasPackage: () => false,
    },
  );
  assert.equal(goFallback.method, "go");
  assert.match(goFallback.package, /^github\.com\/projectdiscovery\/katana/);
  assert.equal(goFallback.source, "official:projectdiscovery");

  // Linux where APT does not carry arjun -> falls back to pipx
  const pipxFallback = resolveInstallPlan(
    { name: "arjun", method: "auto" },
    {
      platform: "linux",
      hasCommand: (c) => c === "apt-get" || c === "pipx",
      aptHasPackage: () => false,
    },
  );
  assert.equal(pipxFallback.method, "pipx");
  assert.equal(pipxFallback.package, "arjun");

  // macOS with brew
  const macPlan = resolveInstallPlan(
    { name: "nmap", method: "auto" },
    {
      platform: "darwin",
      hasCommand: (c) => c === "brew",
      aptHasPackage: () => false,
    },
  );
  assert.equal(macPlan.method, "brew");
  assert.equal(macPlan.package, "nmap");
});

test("validateToolInstallSpec rejects shell injection in package names", () => {
  assert.throws(() => validateToolInstallSpec("nmap", "nmap; id", "apt"), /invalid/);
  assert.throws(() => validateToolInstallSpec("nuclei", "github.com/foo/bar && id", "go"), /invalid/);
  assert.throws(() => validateToolInstallSpec("pkg", "@scope/pkg$(id)", "npm"), /invalid/);
  assert.doesNotThrow(() =>
    validateToolInstallSpec("nuclei", "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest", "go"),
  );
});

test("installTool reuses already-present binary without burning install budget", async (t) => {
  const { ctx } = makeFixture(t, { mock: false });
  const r = await installTool(ctx, { name: "bash", method: "auto" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyPresent, true);
  assert.equal(ctx.usage.installs, 0);
});

test("BINARY_HEALTH invalidates after installTool and enable_mcp auto-installs missing builtin binary", async (t) => {
  const { root, manifest, ctx } = makeFixture(t, { mock: true });
  const binName = `gytestbin${Date.now().toString(36)}`;
  const mcpDir = join(root, "mcp-custom");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(join(mcpDir, "mcp.json"), JSON.stringify({ id: binName, binary: binName, capability: "scan" }));
  manifest.mcpPool = [
    {
      id: binName,
      name: "Test CLI",
      transport: "builtin",
      rootDir: mcpDir,
      binary: binName,
      capability: "scan",
      args: [],
      env: {},
    },
  ];
  const origPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = origPath;
    invalidateBinaryHealth(binName);
  });

  const hub = await openMcpHub(manifest, ctx);
  try {
    // Initially cached as missing
    assert.equal(builtinBinaryAvailable(binName), false);
    assert.match(hub.catalogLines().join("\n"), /未安装/);

    // enable_mcp automatically invokes installTool (stub in mock mode), refreshes cache, and attaches!
    const msg = await hub.enable(binName, "need scanner");
    assert.match(msg, /已启用 MCP/);
    assert.match(msg, /已自动安装二进制/);
    assert.equal(builtinBinaryAvailable(binName), true);
    assert.ok(hub.enabledIds().includes(binName));
  } finally {
    await hub.close();
  }
});

test("installMcp reuses Kali builtin MCP on alias, installs curated official MCP, and blocks untrusted npm/low-star repos", async (t) => {
  const { root, manifest, ctx } = makeFixture(t, { mock: true });
  const fakeNmapDir = join(root, "mcp-nmap");
  mkdirSync(fakeNmapDir, { recursive: true });
  writeFileSync(join(fakeNmapDir, "mcp.json"), JSON.stringify({ id: "nmap", binary: "bash", capability: "scan" }));
  manifest.mcpPool = [
    {
      id: "nmap",
      name: "Nmap Builtin",
      transport: "builtin",
      rootDir: fakeNmapDir,
      binary: "bash",
      capability: "scan",
      args: [],
      env: {},
    },
  ];

  const hub = await openMcpHub(manifest, ctx);
  try {
    // 1) Alias nmap-mcp -> reuses Kali builtin nmap, zero redundant downloads
    const reused = await installMcp(ctx, hub, { id: "nmap-mcp", reason: "port scan" });
    assert.equal(reused.ok, true);
    assert.equal(reused.reusedKali, true);
    assert.equal(reused.id, "nmap");
    assert.equal(ctx.usage.installs, 0);

    // 2) Curated official MCP (playwright) installs to <dataRoot>/mcp/user/playwright/mcp.json and hot-registers
    const installed = await installMcp(ctx, hub, { id: "playwright", reason: "SPA inspection" });
    assert.equal(installed.ok, true);
    assert.equal(hub.hasServer("playwright"), true);
    const saved = join(root, "mcp", "user", "playwright", "mcp.json");
    assert.equal(existsSync(saved), true);
    const meta = JSON.parse(readFileSync(saved, "utf8")) as { command: string; args: string[] };
    assert.equal(meta.command, "npx");
    assert.ok(meta.args.includes("@playwright/mcp@latest"));

    // 3) Untrusted npm scope rejected
    const badNpm = await installMcp(ctx, hub, {
      id: "shady-mcp",
      source: "npm:random-untrusted-mcp",
      reason: "test",
    });
    assert.equal(badNpm.ok, false);
    assert.match(badNpm.detail, /拒绝非官方 npm 作用域/);

    // 4) Low-star GitHub repo rejected
    const mockFetchLowStar: FetchLike = (async () =>
      new Response(JSON.stringify({ stargazers_count: 12, archived: false, default_branch: "main" }), {
        status: 200,
      })) as FetchLike;
    const badGh = await installMcp(
      ctx,
      hub,
      { id: "tiny-mcp", source: "github:someone/tiny-mcp", reason: "test" },
      { fetchFn: mockFetchLowStar },
    );
    assert.equal(badGh.ok, false);
    assert.match(badGh.detail, /拒绝安装低星仓库/);

    // 5) High-star (>=500) GitHub repo accepted
    const mockFetchHighStar: FetchLike = (async () =>
      new Response(JSON.stringify({ stargazers_count: 1200, archived: false, default_branch: "main" }), {
        status: 200,
      })) as FetchLike;
    const goodGh = await installMcp(
      ctx,
      hub,
      { id: "popular-mcp", source: "github:community/popular-mcp", reason: "test" },
      { fetchFn: mockFetchHighStar },
    );
    assert.equal(goodGh.ok, true);
    assert.equal(hub.hasServer("popular-mcp"), true);
  } finally {
    await hub.close();
  }
});

test("installSkill verifies official/high-star GitHub, hot-registers, and SkillHub supports references/ loading", async (t) => {
  const { root, manifest, history, ctx } = makeFixture(t, { mock: true });
  const localSkillDir = join(root, "skills-local", "cbh-demo");
  mkdirSync(join(localSkillDir, "references"), { recursive: true });
  writeFileSync(join(localSkillDir, "SKILL.md"), "# Demo Skill\nMain body");
  writeFileSync(join(localSkillDir, "references", "checklist.md"), "# Checklist\nItem 1");
  manifest.skillPool = [{ id: "cbh-demo", name: "Demo Skill", rootDir: localSkillDir }];

  const skillHub = openSkillHub(manifest, history);

  // 1) Loading SKILL.md advertises references/, and ref= loads the reference while blocking traversal
  const mainBody = skillHub.load("cbh-demo", "check main");
  assert.match(mainBody, /references\/checklist\.md/);
  const refBody = skillHub.load("cbh-demo", "check ref", "references/checklist.md");
  assert.match(refBody, /Item 1/);
  const badRef = skillHub.load("cbh-demo", "traversal", "../SKILL.md");
  assert.match(badRef, /非法参考路径/);

  // 2) installSkill on existing local skill reuses without downloading
  const reused = await installSkill(ctx, skillHub, { id: "cbh-demo", reason: "already local" });
  assert.equal(reused.ok, true);
  assert.equal(ctx.usage.installs, 0);

  // 3) installSkill from official OWASP curated source downloads, persists, hot-registers & loads
  const mockFetch: FetchLike = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/repos/")) {
      return new Response(
        JSON.stringify({ stargazers_count: 35000, archived: false, default_branch: "master" }),
        { status: 200 },
      );
    }
    return new Response("# OWASP SSRF\nVerify internal metadata access.", { status: 200 });
  }) as FetchLike;
  const installed = await installSkill(ctx, skillHub, { id: "owasp-ssrf", reason: "ssrf test" }, { fetchFn: mockFetch });
  assert.equal(installed.ok, true);
  assert.equal(skillHub.hasSkill("owasp-ssrf"), true);
  assert.match(installed.content ?? "", /OWASP SSRF/);
  assert.equal(existsSync(join(root, "skills", "user", "owasp-ssrf", "SKILL.md")), true);

  // 4) Low-star community skill repo rejected
  const lowStarFetch: FetchLike = (async () =>
    new Response(JSON.stringify({ stargazers_count: 5, archived: false, default_branch: "main" }), {
      status: 200,
    })) as FetchLike;
  const rejected = await verifyGithubRepo("randomuser", "tiny-skill", lowStarFetch);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /500/);
});
