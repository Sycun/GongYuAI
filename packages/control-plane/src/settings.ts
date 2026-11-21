import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppSettingsSchema,
  type AppSettings,
  type ModelSettings,
  type ModelSettingsPatch,
  type UpdateSettingsPatch,
} from "@gongyuai/contracts";

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

  constructor(private readonly dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    this.path = join(dataRoot, "settings.json");
    this.data = this.load();
  }

  private load(): AppSettings {
    if (!existsSync(this.path)) {
      const fresh = AppSettingsSchema.parse({});
      this.write(fresh);
      return fresh;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return AppSettingsSchema.parse(raw);
    } catch {
      return AppSettingsSchema.parse({});
    }
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

  /** Env vars injected into workers from persisted settings (+ process.env fallback). */
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
}
