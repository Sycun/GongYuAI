import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SettingsStore } from "./settings.js";

export type UpdatePhase =
  | "idle"
  | "fetching"
  | "extracting"
  | "overlay"
  | "building"
  | "restarting"
  | "done"
  | "failed";

export type UpdateStatus = {
  phase: UpdatePhase;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  commit: string | null;
  error: string | null;
  silent: true;
};

function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/#?\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/i, "") };
}

function resolveToken(settings: SettingsStore): string {
  const fromSettings = settings.get().update.githubToken;
  if (fromSettings) return fromSettings;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim();
  return "";
}

export class SilentUpdater {
  private status: UpdateStatus = {
    phase: "idle",
    message: "",
    startedAt: null,
    finishedAt: null,
    commit: null,
    error: null,
    silent: true,
  };
  private running = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly installRoot: string,
    private readonly dataRoot: string,
  ) {}

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  start(): UpdateStatus {
    if (this.running) return this.getStatus();
    this.running = true;
    this.status = {
      phase: "fetching",
      message: "拉取更新",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      commit: null,
      error: null,
      silent: true,
    };
    void this.run().finally(() => {
      this.running = false;
    });
    return this.getStatus();
  }

  private set(phase: UpdatePhase, message: string, error: string | null = null): void {
    this.status = {
      ...this.status,
      phase,
      message,
      error,
      finishedAt: phase === "done" || phase === "failed" ? new Date().toISOString() : null,
    };
  }

  private async run(): Promise<void> {
    const work = mkdtempSync(join(tmpdir(), "gy-update-"));
    try {
      const cfg = this.settings.get().update;
      const parsed = parseGithubUrl(cfg.githubUrl);
      if (!parsed) {
        this.set("failed", "无效的 GitHub 地址", `bad url: ${cfg.githubUrl}`);
        return;
      }

      const token = resolveToken(this.settings);
      const branch = cfg.branch || "main";
      const tarballUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(branch)}`;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "GongYuAI-updater",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;

      this.set("fetching", "下载源码包");
      const res = await fetch(tarballUrl, { headers, redirect: "follow" });
      if (!res.ok) {
        this.set(
          "failed",
          "下载失败",
          `github ${res.status}: ${(await res.text()).slice(0, 400)}`,
        );
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const tarPath = join(work, "src.tar.gz");
      writeFileSync(tarPath, buf);

      this.set("extracting", "解压");
      const extractDir = join(work, "extract");
      mkdirSync(extractDir, { recursive: true });
      const tar = spawnSync("tar", ["-xzf", tarPath, "-C", extractDir], { encoding: "utf8" });
      if (tar.status !== 0) {
        this.set("failed", "解压失败", tar.stderr || tar.stdout);
        return;
      }
      const top = spawnSync("ls", [extractDir], { encoding: "utf8" });
      const folder = (top.stdout || "").trim().split("\n").filter(Boolean)[0];
      if (!folder) {
        this.set("failed", "空包", "no extracted folder");
        return;
      }
      const srcRoot = join(extractDir, folder);

      // Prefer commit from folder name: owner-repo-<sha>
      const commitGuess = folder.split("-").pop() || null;
      this.status.commit = commitGuess;

      this.set("overlay", "静默覆盖");
      const settingsBackup = join(work, "settings.json.bak");
      const liveSettings = join(this.dataRoot, "settings.json");
      if (existsSync(liveSettings)) {
        writeFileSync(settingsBackup, readFileSync(liveSettings));
      }

      const excludes = [
        "--exclude",
        ".gongyuai",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        "--exclude",
        ".env",
        "--exclude",
        "packages/control-plane/web",
      ];
      const rsync = spawnSync(
        "rsync",
        ["-a", "--delete", ...excludes, `${srcRoot}/`, `${this.installRoot}/`],
        { encoding: "utf8" },
      );
      if (rsync.status !== 0) {
        this.set("failed", "覆盖失败", rsync.stderr || rsync.stdout);
        return;
      }

      if (existsSync(settingsBackup)) {
        mkdirSync(this.dataRoot, { recursive: true });
        writeFileSync(liveSettings, readFileSync(settingsBackup), { mode: 0o600 });
      }

      this.set("building", "构建");
      const env = {
        ...process.env,
        PATH: process.env.PATH ?? "",
        CI: "1",
      };
      const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
        cwd: this.installRoot,
        encoding: "utf8",
        env,
        timeout: 600_000,
      });
      // frozen may fail on first sync — retry without
      if (install.status !== 0) {
        const install2 = spawnSync("pnpm", ["install"], {
          cwd: this.installRoot,
          encoding: "utf8",
          env,
          timeout: 600_000,
        });
        if (install2.status !== 0) {
          this.set("failed", "依赖安装失败", install2.stderr || install2.stdout);
          return;
        }
      }

      const build = spawnSync("pnpm", ["build"], {
        cwd: this.installRoot,
        encoding: "utf8",
        env,
        timeout: 600_000,
      });
      if (build.status !== 0) {
        this.set("failed", "构建失败", (build.stderr || build.stdout).slice(0, 2000));
        return;
      }

      const consoleBuild = spawnSync("pnpm", ["build:console"], {
        cwd: this.installRoot,
        encoding: "utf8",
        env,
        timeout: 300_000,
      });
      if (consoleBuild.status !== 0) {
        this.set(
          "failed",
          "控制台构建失败",
          (consoleBuild.stderr || consoleBuild.stdout).slice(0, 2000),
        );
        return;
      }

      this.settings.markUpdated({ commit: commitGuess });
      this.set("restarting", "静默重启");
      this.scheduleRestart();
      this.set("done", "已更新");
    } catch (err) {
      this.set("failed", "更新异常", err instanceof Error ? err.message : String(err));
    } finally {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleRestart(): void {
    const port = process.env.GY_PORT || "8877";
    const host = process.env.GY_HOST || "0.0.0.0";
    const dataDir = this.dataRoot;
    const root = this.installRoot;
    const script = join(tmpdir(), `gy-restart-${process.pid}.sh`);
    const body = `#!/usr/bin/env bash
set -e
export PATH="$HOME/.n/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"
sleep 2
fuser -k ${port}/tcp 2>/dev/null || true
sleep 1
cd "${root}"
nohup pnpm gy serve --host ${host} --port ${port} --data-dir "${dataDir}" >/tmp/gy-serve.log 2>&1 &
disown || true
rm -f "${script}"
`;
    writeFileSync(script, body, { mode: 0o700 });
    const child = spawn("bash", [script], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }
}

export function resolveInstallRoot(): string {
  // packages/control-plane/{src|dist}/updater → repo root
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}
