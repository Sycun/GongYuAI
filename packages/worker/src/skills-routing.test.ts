import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openHistory } from "@gongyuai/history";
import type { WorkerManifest } from "@gongyuai/contracts";
import { openSkillHub } from "./skills/runtime.js";

const TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SKILLS_ROOT = fileURLToPath(new URL("../../../skills/", import.meta.url));
const NEW_SKILLS = [
  {
    id: "enterprise-oa-erp-audit",
    triggers: ["泛微", "weaver", "e-cology", "e-office", "seeyon", "致远", "用友", "yonyou", "nc", "蓝凌", "通达", "金蝶"],
    marker: "①静态指纹与版本区间确认",
  },
  {
    id: "java-microservice-middleware",
    triggers: ["ruoyi", "若依", "jeecg", "actuator", "spring cloud gateway", "nacos", "xxl-job", "shiro", "fastjson", "druid"],
    marker: "接口前缀绕过系统化核验",
  },
  {
    id: "ai-infra-service-audit",
    triggers: ["vllm", "dify", "ray", "mlflow", "gradio", "jupyter", "triton", "comfyui", "chromadb", "qdrant"],
    marker: "工作流代码沙箱边界",
  },
] as const;

test("routing.json registers the three enterprise audit playbooks with the required triggers", () => {
  const routing = JSON.parse(readFileSync(join(SKILLS_ROOT, "routing.json"), "utf8")) as {
    routes: Array<{ id: string; triggers: string[] }>;
  };
  for (const expected of NEW_SKILLS) {
    const route = routing.routes.find((item) => item.id === expected.id);
    assert.ok(route, `routing.json 缺少 ${expected.id}`);
    for (const trigger of expected.triggers) {
      assert.ok(route!.triggers.includes(trigger), `${expected.id} 缺少触发词 ${trigger}`);
    }
    assert.ok(existsSync(join(SKILLS_ROOT, "builtin", expected.id, "SKILL.md")));
    assert.ok(existsSync(join(SKILLS_ROOT, "builtin", expected.id, "skill.json")));
  }
});

test("openSkillHub exposes and loads the three built-in playbooks", () => {
  const root = mkdtempSync(join(tmpdir(), "gy-skill-routes-"));
  const evidenceDir = join(root, "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(join(root, "workspace"), { recursive: true });
  const history = openHistory({ dbPath: join(root, "history.sqlite"), evidenceDir });
  try {
    const pool = [
      { id: "component-vuln-intel", name: "组件情报", rootDir: join(SKILLS_ROOT, "builtin", "component-vuln-intel") },
      ...NEW_SKILLS.map((skill) => ({
        id: skill.id,
        name: skill.id,
        rootDir: join(SKILLS_ROOT, "builtin", skill.id),
      })),
    ];
    const manifest: WorkerManifest = {
      taskId: TASK_ID,
      engagementId: "eng-skills",
      dataDir: root,
      historyDb: join(root, "history.sqlite"),
      durableDb: join(root, "durable.sqlite"),
      evidenceDir,
      workspaceDir: join(root, "workspace"),
      auth: {
        authorizationNote: "skill route fixture",
        targets: ["lab.example.com"],
        outOfScope: [],
        capability: "active-lab",
      },
      scopeVersion: 1,
      goals: [],
      budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0, relayTokenThreshold: 30_000, relayMinToolCalls: 2 },
      execution: { maxConcurrentExplores: 1, maxIntentsPerReason: 4, maxIntentsPerAssetRoot: 2, exploreTimeoutMs: 900_000, reasonLeaseMs: 120_000 },
      commandConfirmation: "auto",
      workerId: "w0-skills",
      workerSlot: 0,
      workerCount: 1,
      mock: false,
      mcpServers: [],
      mcpPool: [],
      mcpCatalog: [],
      skillPacks: pool,
      skillPool: pool,
      skillCatalog: pool.map((pack) => ({ id: pack.id, name: pack.name, description: "", category: "skill" })),
      assetCollectors: [],
    };
    const hub = openSkillHub(manifest, history);
    const table = hub.routingTable().join("\n");
    for (const expected of NEW_SKILLS) {
      assert.match(table, new RegExp(`\`${expected.id}\``));
      const body = hub.load(expected.id, "route loading test");
      assert.ok(body.includes(expected.id), `${expected.id} 加载结果应包含 id`);
      assert.ok(body.includes(expected.marker), `${expected.id} 正文缺少关键纪律标记`);
    }
    assert.ok(hub.loadedIds().length >= NEW_SKILLS.length);
  } finally {
    history.close();
    rmSync(root, { recursive: true, force: true });
  }
});