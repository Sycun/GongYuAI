import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AddUserMcpSchema,
  AppSettingsSchema,
  CORE_MCP_IDS,
  ImportSkillSchema,
  McpServerConfigSchema,
  SkillPackConfigSchema,
  ToggleToolsItemSchema,
  ToolsSettingsPatchSchema,
  mergeMcpServers,
  mergeSkillPacks,
  type AddUserMcp,
  type AppSettings,
  type ImportSkill,
  type McpServerConfig,
  type ModelSettings,
  type ModelSettingsPatch,
  type SkillPackConfig,
  type ToggleToolsItem,
  type ToolsSettingsPatch,
  type UpdateSettingsPatch,
  type WorkerMcpServer,
  type WorkerSkillPack,
} from "@gongyuai/contracts";
import { discoverMcpCatalog, discoverSkillCatalog } from "./catalog-discover.js";

const MASK = "••••••••";

export type PublicSettings = {
  model: Omit<ModelSettings, "apiKey"> & {
    apiKeyConfigured: boolean;
    apiKeyMask: string;
  };
  update: {
    githubUrl: string;
    branch: string;
    githubTokenConfigured: boolean;
    githubTokenMask: string;
    lastCheckedAt: string | null;
    lastUpdatedAt: string | null;
    lastCommit: string | null;
  };
  mcpServers: Array<
    Omit<McpServerConfig, "env"> & {
      envConfigured: boolean;
      envKeys: string[];
    }
  >;
  skillPacks: SkillPackConfig[];
  version: string;
};

function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return MASK;
  return `${value.slice(0, 4)}${MASK}${value.slice(-4)}`;
}

function isMaskedOrEmpty(value: string | undefined): boolean {
  if (value == null || value === "") return true;
  return value.includes("••••") || value === MASK;
}

export class SettingsStore {
  private readonly path: string;
  private data: AppSettings;

  constructor(
    private readonly dataRoot: string,
    private readonly installRoot: string = process.cwd(),
  ) {
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(join(dataRoot, "mcp", "user"), { recursive: true });
    mkdirSync(join(dataRoot, "skills", "user"), { recursive: true });
    this.path = join(dataRoot, "settings.json");
    this.data = this.load();
  }

  private catalogMcp(): McpServerConfig[] {
    return discoverMcpCatalog(this.installRoot, this.dataRoot);
  }

  private catalogSkills(): SkillPackConfig[] {
    return discoverSkillCatalog(this.installRoot, this.dataRoot);
  }

  private load(): AppSettings {
    let raw: unknown = {};
    if (existsSync(this.path)) {
      try {
        raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      } catch {
        raw = {};
      }
    }
    const parsed = AppSettingsSchema.parse(raw);
    const merged: AppSettings = {
      ...parsed,
      mcpServers: mergeMcpServers(parsed.mcpServers ?? [], this.catalogMcp()),
      skillPacks: mergeSkillPacks(parsed.skillPacks ?? [], this.catalogSkills()),
    };
    this.write(merged);
    return merged;
  }

  /** Re-scan mcp/ and skills/ folders; keep enabled prefs. */
  rescanCatalog(): PublicSettings {
    this.write({
      ...this.data,
      mcpServers: mergeMcpServers(this.data.mcpServers, this.catalogMcp()),
      skillPacks: mergeSkillPacks(this.data.skillPacks, this.catalogSkills()),
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  private write(data: AppSettings): void {
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* ignore */
    }
    this.data = data;
  }

  get(): AppSettings {
    return this.data;
  }

  publicView(version: string): PublicSettings {
    const m = this.data.model;
    const u = this.data.update;
    return {
      model: {
        provider: m.provider,
        modelId: m.modelId,
        baseUrl: m.baseUrl,
        visionEnabled: m.visionEnabled,
        visionModelId: m.visionModelId,
        apiKeyConfigured: Boolean(m.apiKey),
        apiKeyMask: maskSecret(m.apiKey),
      },
      update: {
        githubUrl: u.githubUrl,
        branch: u.branch,
        githubTokenConfigured: Boolean(u.githubToken),
        githubTokenMask: maskSecret(u.githubToken),
        lastCheckedAt: u.lastCheckedAt,
        lastUpdatedAt: u.lastUpdatedAt,
        lastCommit: u.lastCommit,
      },
      mcpServers: this.data.mcpServers.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        enabled: s.enabled,
        builtin: s.builtin,
        source: s.source,
        transport: s.transport,
        rootDir: s.rootDir,
        command: s.command,
        args: s.args,
        url: s.url,
        envConfigured: Object.keys(s.env ?? {}).length > 0,
        envKeys: Object.keys(s.env ?? {}),
      })),
      skillPacks: this.data.skillPacks,
      version,
    };
  }

  patchModel(patch: ModelSettingsPatch): PublicSettings {
    const next = { ...this.data.model, ...patch };
    if (isMaskedOrEmpty(patch.apiKey)) {
      next.apiKey = this.data.model.apiKey;
    }
    this.write({ ...this.data, model: AppSettingsSchema.shape.model.parse(next) });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  patchUpdate(patch: UpdateSettingsPatch): PublicSettings {
    const next = { ...this.data.update, ...patch };
    if (isMaskedOrEmpty(patch.githubToken)) {
      next.githubToken = this.data.update.githubToken;
    }
    this.write({ ...this.data, update: AppSettingsSchema.shape.update.parse(next) });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  patchTools(patch: ToolsSettingsPatch): PublicSettings {
    const body = ToolsSettingsPatchSchema.parse(patch);
    let mcpServers = this.data.mcpServers;
    let skillPacks = this.data.skillPacks;
    if (body.mcpServers) {
      mcpServers = mergeMcpServers(body.mcpServers, this.catalogMcp());
    }
    if (body.skillPacks) {
      skillPacks = mergeSkillPacks(body.skillPacks, this.catalogSkills());
    }
    this.write({ ...this.data, mcpServers, skillPacks });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  toggleToolsItem(item: ToggleToolsItem): PublicSettings {
    const body = ToggleToolsItemSchema.parse(item);
    if (body.kind === "mcp") {
      const mcpServers = this.data.mcpServers.map((s) =>
        s.id === body.id ? { ...s, enabled: body.enabled } : s,
      );
      if (!mcpServers.some((s) => s.id === body.id)) {
        throw new Error(`mcp not found: ${body.id}`);
      }
      this.write({ ...this.data, mcpServers });
    } else {
      const skillPacks = this.data.skillPacks.map((s) =>
        s.id === body.id ? { ...s, enabled: body.enabled } : s,
      );
      if (!skillPacks.some((s) => s.id === body.id)) {
        throw new Error(`skill not found: ${body.id}`);
      }
      this.write({ ...this.data, skillPacks });
    }
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  addUserMcp(input: AddUserMcp): PublicSettings {
    const body = AddUserMcpSchema.parse(input);
    if (this.data.mcpServers.some((s) => s.id === body.id)) {
      throw new Error(`mcp id already exists: ${body.id}`);
    }
    if (body.transport === "stdio" && !body.command) {
      throw new Error("stdio MCP 需要 command");
    }
    if (body.transport === "http" && !body.url) {
      throw new Error("http MCP 需要 url");
    }
    const entry = McpServerConfigSchema.parse({
      ...body,
      builtin: false,
      source: "user",
      description: "",
      category: "user",
    });
    this.write({
      ...this.data,
      mcpServers: [...this.data.mcpServers, entry],
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  removeUserMcp(id: string): PublicSettings {
    const hit = this.data.mcpServers.find((s) => s.id === id);
    if (!hit) throw new Error(`mcp not found: ${id}`);
    if (hit.builtin) throw new Error("不可删除内置 MCP，只能关闭");
    this.write({
      ...this.data,
      mcpServers: this.data.mcpServers.filter((s) => s.id !== id),
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  importSkill(input: ImportSkill): PublicSettings {
    const body = ImportSkillSchema.parse(input);
    if (this.data.skillPacks.some((s) => s.id === body.id)) {
      throw new Error(`skill id already exists: ${body.id}`);
    }
    let rootDir = body.rootDir;
    if (body.skillMarkdown) {
      rootDir = join(this.dataRoot, "skills", "user", body.id);
      mkdirSync(rootDir, { recursive: true });
      writeFileSync(join(rootDir, "SKILL.md"), body.skillMarkdown, "utf8");
      writeFileSync(
        join(rootDir, "skill.json"),
        JSON.stringify(
          { id: body.id, name: body.name, defaultEnabled: body.enabled },
          null,
          2,
        ),
        "utf8",
      );
    }
    if (!rootDir) throw new Error("需要 rootDir 或 skillMarkdown");
    if (!existsSync(join(rootDir, "SKILL.md"))) {
      throw new Error(`缺少 SKILL.md: ${rootDir}`);
    }
    const entry = SkillPackConfigSchema.parse({
      id: body.id,
      name: body.name,
      description: "",
      enabled: body.enabled,
      builtin: false,
      source: "user",
      rootDir,
    });
    this.write({
      ...this.data,
      skillPacks: [...this.data.skillPacks, entry],
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  removeUserSkill(id: string): PublicSettings {
    const hit = this.data.skillPacks.find((s) => s.id === id);
    if (!hit) throw new Error(`skill not found: ${id}`);
    if (hit.builtin) throw new Error("不可删除内置 Skill，只能关闭");
    this.write({
      ...this.data,
      skillPacks: this.data.skillPacks.filter((s) => s.id !== id),
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  markUpdated(meta: { commit: string | null }): void {
    this.write({
      ...this.data,
      update: {
        ...this.data.update,
        lastCheckedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        lastCommit: meta.commit,
      },
    });
  }

  workerEnv(): Record<string, string> {
    const m = this.data.model;
    const key = m.apiKey || process.env.OPENAI_API_KEY || "";
    const base = m.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const model = m.modelId || process.env.GY_MODEL || "gpt-4.1-mini";
    return {
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: base,
      GY_MODEL: model,
      GY_VISION: m.visionEnabled ? "1" : "0",
      GY_VISION_MODEL: m.visionModelId || "",
    };
  }

  modelForManifest(): NonNullable<import("@gongyuai/contracts").WorkerManifest["model"]> {
    const m = this.data.model;
    return {
      provider: m.provider || "openai",
      modelId: m.modelId || "gpt-4.1-mini",
      baseUrl: m.baseUrl || undefined,
      apiKeyEnv: "OPENAI_API_KEY",
      visionEnabled: m.visionEnabled,
      visionModelId: m.visionModelId || undefined,
    };
  }

  private toWorkerMcp(s: McpServerConfig): WorkerMcpServer {
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      rootDir: s.rootDir,
      command: s.command,
      args: s.args ?? [],
      url: s.url,
      env: s.env ?? {},
    };
  }

  allMcpForManifest(): WorkerMcpServer[] {
    return this.data.mcpServers.map((s) => this.toWorkerMcp(s));
  }

  /**
   * Initial enabled set = settings.enabled ∪ CORE_MCP_IDS (progressive unlock baseline).
   */
  enabledMcpForManifest(): WorkerMcpServer[] {
    const core = new Set<string>(CORE_MCP_IDS);
    return this.data.mcpServers
      .filter((s) => s.enabled || core.has(s.id))
      .map((s) => this.toWorkerMcp(s));
  }

  mcpCatalogForManifest(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
  }> {
    return this.data.mcpServers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      category: s.category ?? "general",
    }));
  }

  allSkillsForManifest(): WorkerSkillPack[] {
    return this.data.skillPacks.map((s) => ({
      id: s.id,
      name: s.name,
      rootDir: s.rootDir,
    }));
  }

  /**
   * Legacy field: we no longer pre-inject skill bodies into the system prompt.
   * Keep empty — model uses routing table + load_skill.
   */
  enabledSkillsForManifest(): WorkerSkillPack[] {
    return [];
  }

  /** Packs that participate in the skill router (settings.enabled). */
  routedSkillsForManifest(): WorkerSkillPack[] {
    return this.data.skillPacks
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        rootDir: s.rootDir,
      }));
  }

  skillCatalogForManifest(): Array<{
    id: string;
    name: string;
    description: string;
    category: string;
  }> {
    return this.data.skillPacks
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? "",
        category: "skill",
      }));
  }
}
