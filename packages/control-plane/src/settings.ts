import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AddAssetCollectorSchema,
  AddUserMcpSchema,
  AppSettingsSchema,
  AssetCollectorConfigSchema,
  AssetCollectorPatchSchema,
  CORE_MCP_IDS,
  ImportSkillSchema,
  McpServerConfigSchema,
  SkillPackConfigSchema,
  ToggleToolsItemSchema,
  ToolsSettingsPatchSchema,
  assetCollectorEnvNames,
  chatPresets,
  modelBaseUrl,
  selectableChatModels,
  type ChatCatalog,
  type ChatConnection,
  type ChatProfile,
  mergeAssetCollectors,
  mergeMcpServers,
  mergeSkillPacks,
  type AddAssetCollector,
  type AddUserMcp,
  type AppSettings,
  type AssetCollectorConfig,
  type AssetCollectorPatch,
  type ImportSkill,
  type McpServerConfig,
  type ModelSettings,
  type ModelSettingsPatch,
  type SkillPackConfig,
  type ToggleToolsItem,
  type ToolsSettingsPatch,
  type UpdateSettingsPatch,
  type WorkerAssetCollector,
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
  assetCollectors: Array<
    Omit<AssetCollectorConfig, "apiKey" | "email"> & {
      emailConfigured: boolean;
      apiKeyConfigured: boolean;
      emailMask: string;
      apiKeyMask: string;
    }
  >;
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
      assetCollectors: mergeAssetCollectors(parsed.assetCollectors ?? []),
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
      assetCollectors: this.data.assetCollectors.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        enabled: c.enabled,
        builtin: c.builtin,
        baseUrl: c.baseUrl,
        method: c.method,
        authHeader: c.authHeader,
        authQueryParam: c.authQueryParam,
        queryParam: c.queryParam,
        queryEncoding: c.queryEncoding,
        bodyTemplate: c.bodyTemplate,
        resultPath: c.resultPath,
        addressFields: c.addressFields,
        emailConfigured: Boolean(c.email),
        apiKeyConfigured: Boolean(c.apiKey),
        emailMask: maskSecret(c.email),
        apiKeyMask: maskSecret(c.apiKey),
      })),
      version,
    };
  }

  chatProfiles(): ChatProfile[] {
    const profiles = new Map(chatPresets.map((profile) => [profile.id, profile]));
    const legacy = this.data.model;
    if (
      legacy.apiKey ||
      legacy.visionModelId ||
      legacy.modelId !== "gpt-4.1-mini" ||
      legacy.baseUrl !== "https://api.openai.com/v1" ||
      process.env.OPENAI_API_KEY
    ) {
      const env = this.workerEnv();
      profiles.set("existing", {
        id: "existing",
        name: "已有配置",
        protocol: "openai",
        modelId: env.GY_MODEL!,
        baseUrl: env.OPENAI_BASE_URL!,
        apiKey: env.OPENAI_API_KEY!,
        visionModelId: legacy.visionModelId,
        models: [],
      });
    }
    for (const profile of this.data.chatProfiles) {
      const previous = profiles.get(profile.id);
      profiles.set(profile.id, { ...profile, visionModelId: profile.visionModelId ?? previous?.visionModelId });
    }
    return [...profiles.values()];
  }

  saveChatApproval(policy: AppSettings["chatApproval"]) {
    if (policy.reviewer) {
      const { profileId, modelId } = policy.reviewer;
      const profile = this.chatProfiles().find((item) => item.id === profileId);
      if (!profile || !selectableChatModels(profile).includes(modelId)) throw new Error("请选择已配置的审批模型。");
    }
    this.write({ ...this.data, chatApproval: policy });
    return policy;
  }

  chatCatalog(): ChatCatalog {
    const profiles = this.chatProfiles();
    return {
      profiles: profiles.map(({ apiKey, ...profile }) => ({ ...profile, hasKey: Boolean(apiKey) })),
      defaultId: this.data.defaultChatProfile ?? (profiles.some((profile) => profile.id === "existing") ? "existing" : "deepseek"),
    };
  }

  chatKey(connection: ChatConnection): string {
    if (connection.apiKey) return connection.apiKey;
    const saved = this.chatProfiles().find((profile) => profile.id === connection.id);
    if (
      saved &&
      saved.protocol === connection.protocol &&
      modelBaseUrl(saved.baseUrl, saved.protocol) === modelBaseUrl(connection.baseUrl, connection.protocol)
    ) {
      return saved.apiKey;
    }
    return "";
  }

  saveChatProfile(input: ChatProfile, makeDefault: boolean): ChatCatalog {
    const previous = this.chatProfiles().find((profile) => profile.id === input.id);
    const profile = { ...input, apiKey: this.chatKey(input), visionModelId: input.visionModelId ?? previous?.visionModelId };
    const profiles = this.data.chatProfiles.filter((item) => item.id !== profile.id);
    this.write({
      ...this.data,
      chatProfiles: [...profiles, profile],
      defaultChatProfile: makeDefault ? profile.id : this.chatCatalog().defaultId,
    });
    return this.chatCatalog();
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

  patchAssetCollector(patch: AssetCollectorPatch): PublicSettings {
    const body = AssetCollectorPatchSchema.parse(patch);
    const list = [...this.data.assetCollectors];
    const idx = list.findIndex((c) => c.id === body.id);
    if (idx < 0) throw new Error(`asset collector not found: ${body.id}`);
    const cur = list[idx]!;
    const next = {
      ...cur,
      ...body,
      id: cur.id,
      kind: cur.builtin ? cur.kind : (body.kind ?? cur.kind),
      builtin: cur.builtin,
    };
    if (isMaskedOrEmpty(body.apiKey)) next.apiKey = cur.apiKey;
    if (isMaskedOrEmpty(body.email)) next.email = cur.email;
    list[idx] = AssetCollectorConfigSchema.parse(next);
    this.write({ ...this.data, assetCollectors: mergeAssetCollectors(list) });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  addAssetCollector(input: AddAssetCollector): PublicSettings {
    const body = AddAssetCollectorSchema.parse(input);
    if (this.data.assetCollectors.some((c) => c.id === body.id)) {
      throw new Error(`asset collector id already exists: ${body.id}`);
    }
    if (!body.baseUrl) throw new Error("自定义收集器需要 baseUrl");
    const entry = AssetCollectorConfigSchema.parse({
      ...body,
      kind: "custom",
      builtin: false,
    });
    this.write({
      ...this.data,
      assetCollectors: mergeAssetCollectors([...this.data.assetCollectors, entry]),
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  removeAssetCollector(id: string): PublicSettings {
    const hit = this.data.assetCollectors.find((c) => c.id === id);
    if (!hit) throw new Error(`asset collector not found: ${id}`);
    if (hit.builtin) throw new Error("不可删除内置收集器，只能关闭或改密钥");
    this.write({
      ...this.data,
      assetCollectors: this.data.assetCollectors.filter((c) => c.id !== id),
    });
    return this.publicView(process.env.npm_package_version ?? "0.1.0");
  }

  toggleAssetCollector(id: string, enabled: boolean): PublicSettings {
    return this.patchAssetCollector({ id, enabled });
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
    const env: Record<string, string> = {
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: base,
      GY_MODEL: model,
      GY_VISION: m.visionEnabled ? "1" : "0",
      GY_VISION_MODEL: m.visionModelId || "",
    };
    for (const c of this.data.assetCollectors) {
      if (!c.enabled) continue;
      const names = assetCollectorEnvNames(c.id);
      if (c.email) env[names.emailEnv] = c.email;
      if (c.apiKey) env[names.apiKeyEnv] = c.apiKey;
    }
    return env;
  }

  private toWorkerCollector(c: AssetCollectorConfig): WorkerAssetCollector {
    const names = assetCollectorEnvNames(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      enabled: c.enabled,
      baseUrl: c.baseUrl,
      emailEnv: c.kind === "fofa" || c.email ? names.emailEnv : undefined,
      apiKeyEnv: names.apiKeyEnv,
      method: c.method,
      authHeader: c.authHeader,
      authQueryParam: c.authQueryParam,
      queryParam: c.queryParam,
      queryEncoding: c.queryEncoding,
      bodyTemplate: c.bodyTemplate,
      resultPath: c.resultPath,
      addressFields: c.addressFields,
    };
  }

  /** Enabled collectors that have credentials (ready for asset_search). */
  enabledAssetCollectorsForManifest(): WorkerAssetCollector[] {
    return this.data.assetCollectors
      .filter((c) => {
        if (!c.enabled || !c.apiKey) return false;
        if (c.kind === "fofa" && !c.email) return false;
        return true;
      })
      .map((c) => this.toWorkerCollector(c));
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
