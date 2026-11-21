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

const SERVE_LOG = "/tmp/gy-serve.log";
const STATUS_FILE = "update-status.json";
const UPDATE_LOG = "logs/update-last.log";

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

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.slice(0, 12);
}

function commitsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function combinedOutput(r: { stdout?: string | null; stderr?: string | null }): string {
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
}

function githubHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "GongYuAI-updater",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
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
  ) {
    this.hydrateFromDisk();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** Called at boot: finish a pending restart or surface last failure. */
  hydrateFromDisk(): void {
    const path = this.statusPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as UpdateStatus;
      if (!raw || typeof raw.phase !== "string") return;
      this.status = { ...raw, silent: true };

      if (raw.phase === "restarting" && raw.commit) {
        const head = this.localHeadSha();
        // git checkout: require HEAD matches expected tip; tarball installs have no HEAD.
        const ok = this.hasGitCheckout()
          ? commitsMatch(head, raw.commit)
          : true;
        if (ok) {
          const commit = shortSha(head ?? raw.commit);
          this.settings.markUpdated({ commit });
          this.status = {
            ...this.status,
            phase: "done",
            message: "已更新",
            commit,
            error: null,
            finishedAt: new Date().toISOString(),
            silent: true,
          };
          this.persist();
        }
      }
    } catch {
      /* ignore corrupt status */
    }
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
    this.persist();
    void this.run().finally(() => {
      this.running = false;
    });
    return this.getStatus();
  }

  private statusPath(): string {
    return join(this.dataRoot, STATUS_FILE);
  }

  private logPath(): string {
    return join(this.dataRoot, UPDATE_LOG);
  }

  private persist(): void {
    try {
      mkdirSync(this.dataRoot, { recursive: true });
      writeFileSync(this.statusPath(), JSON.stringify(this.status, null, 2));
    } catch {
      /* ignore */
    }
  }

  private set(phase: UpdatePhase, message: string, error: string | null = null): void {
    this.status = {
      ...this.status,
      phase,
      message,
      error,
      finishedAt: phase === "done" || phase === "failed" ? new Date().toISOString() : null,
    };
    this.persist();
  }

  private writeUpdateLog(label: string, body: string): string {
    const path = this.logPath();
    mkdirSync(dirname(path), { recursive: true });
    const text = `[${new Date().toISOString()}] ${label}\n${body}\n`;
    writeFileSync(path, text);
    return path;
  }

  private failWithLog(message: string, label: string, body: string): void {
    const path = this.writeUpdateLog(label, body);
    const tail = body.slice(-2000);
    this.set("failed", message, `${tail}\n\n完整日志: ${path}`);
  }

  private hasGitCheckout(): boolean {
    return existsSync(join(this.installRoot, ".git"));
  }

  private localHeadSha(): string | null {
    if (!this.hasGitCheckout()) return null;
    const r = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: this.installRoot,
      encoding: "utf8",
    });
    if (r.status !== 0) return null;
    return (r.stdout || "").trim() || null;
  }

  private async fetchTipSha(
    parsed: { owner: string; repo: string },
    branch: string,
    token: string,
  ): Promise<string | null> {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(branch)}`;
    try {
      const res = await fetch(url, { headers: githubHeaders(token) });
      if (!res.ok) return null;
      const json = (await res.json()) as { sha?: string };
      return json.sha ?? null;
    } catch {
      return null;
    }
  }

  private tipViaGit(branch: string): string | null {
    if (!this.hasGitCheckout()) return null;
    const fetch = spawnSync("git", ["fetch", "origin", branch], {
      cwd: this.installRoot,
      encoding: "utf8",
      timeout: 120_000,
    });
    if (fetch.status !== 0) return null;
    const rev = spawnSync("git", ["rev-parse", `origin/${branch}`], {
      cwd: this.installRoot,
      encoding: "utf8",
    });
    if (rev.status !== 0) return null;
    return (rev.stdout || "").trim() || null;
  }

  private syncViaGit(branch: string): { ok: true; commit: string } | { ok: false; error: string } {
    const fetch = spawnSync("git", ["fetch", "origin", branch], {
      cwd: this.installRoot,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (fetch.status !== 0) {
      return { ok: false, error: combinedOutput(fetch) || "git fetch failed" };
    }
    const reset = spawnSync("git", ["reset", "--hard", `origin/${branch}`], {
      cwd: this.installRoot,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (reset.status !== 0) {
      return { ok: false, error: combinedOutput(reset) || "git reset failed" };
    }
    const head = this.localHeadSha();
    if (!head) return { ok: false, error: "git rev-parse HEAD failed after reset" };
    return { ok: true, commit: head };
  }

  private async syncViaTarball(
    work: string,
    parsed: { owner: string; repo: string },
    branch: string,
    token: string,
    tipSha: string | null,
  ): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
    const tarballUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(branch)}`;
    this.set("fetching", "下载源码包");
    const res = await fetch(tarballUrl, {
      headers: githubHeaders(token),
      redirect: "follow",
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `github ${res.status}: ${(await res.text()).slice(0, 400)}`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tarPath = join(work, "src.tar.gz");
    writeFileSync(tarPath, buf);

    this.set("extracting", "解压");
    const extractDir = join(work, "extract");
    mkdirSync(extractDir, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", tarPath, "-C", extractDir], { encoding: "utf8" });
    if (tar.status !== 0) {
      return { ok: false, error: combinedOutput(tar) || "tar failed" };
    }
    const top = spawnSync("ls", [extractDir], { encoding: "utf8" });
    const folder = (top.stdout || "").trim().split("\n").filter(Boolean)[0];
    if (!folder) return { ok: false, error: "no extracted folder" };
    const srcRoot = join(extractDir, folder);
    const commitGuess = tipSha || folder.split("-").pop() || null;

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
      "private",
      "--exclude",
      "mcp/user",
      "--exclude",
      "skills/user",
      "--exclude",
      "packages/control-plane/web",
    ];
    const rsync = spawnSync(
      "rsync",
      ["-a", "--delete", ...excludes, `${srcRoot}/`, `${this.installRoot}/`],
      { encoding: "utf8" },
    );
    if (rsync.status !== 0) {
      return { ok: false, error: combinedOutput(rsync) || "rsync failed" };
    }

    if (existsSync(settingsBackup)) {
      mkdirSync(this.dataRoot, { recursive: true });
      writeFileSync(liveSettings, readFileSync(settingsBackup), { mode: 0o600 });
    }

    if (!commitGuess) return { ok: false, error: "could not resolve commit sha" };
    return { ok: true, commit: commitGuess };
  }

  private runBuild(): { ok: true } | { ok: false; step: string; output: string } {
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
    if (install.status !== 0) {
      const install2 = spawnSync("pnpm", ["install"], {
        cwd: this.installRoot,
        encoding: "utf8",
        env,
        timeout: 600_000,
      });
      if (install2.status !== 0) {
        return {
          ok: false,
          step: "依赖安装失败",
          output: combinedOutput(install2) || combinedOutput(install),
        };
      }
    }

    const build = spawnSync("pnpm", ["build"], {
      cwd: this.installRoot,
      encoding: "utf8",
      env,
      timeout: 600_000,
    });
    if (build.status !== 0) {
      return { ok: false, step: "构建失败", output: combinedOutput(build) };
    }

    const consoleBuild = spawnSync("pnpm", ["build:console"], {
      cwd: this.installRoot,
      encoding: "utf8",
      env,
      timeout: 300_000,
    });
    if (consoleBuild.status !== 0) {
      return {
        ok: false,
        step: "控制台构建失败",
        output: combinedOutput(consoleBuild),
      };
    }
    return { ok: true };
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

      this.set("fetching", "查询远端 tip");
      let tipSha = await this.fetchTipSha(parsed, branch, token);
      if (!tipSha && this.hasGitCheckout()) {
        tipSha = this.tipViaGit(branch);
      }

      const localHead = this.localHeadSha();
      const last = cfg.lastCommit;
      // Prefer live HEAD; without .git, lastCommit is the install fingerprint.
      const already =
        tipSha &&
        (commitsMatch(tipSha, localHead) ||
          (!localHead && commitsMatch(tipSha, last)));
      if (already) {
        const commit = shortSha(tipSha);
        this.status.commit = commit;
        this.settings.markUpdated({ commit });
        this.set("done", "已是最新");
        return;
      }

      let syncCommit: string;
      if (this.hasGitCheckout()) {
        this.set("overlay", "git 同步");
        const synced = this.syncViaGit(branch);
        if (!synced.ok) {
          this.failWithLog("git 同步失败", "git sync", synced.error);
          return;
        }
        syncCommit = synced.commit;
      } else {
        const synced = await this.syncViaTarball(work, parsed, branch, token, tipSha);
        if (!synced.ok) {
          this.failWithLog("同步失败", "tarball sync", synced.error);
          return;
        }
        syncCommit = synced.commit;
      }

      this.status.commit = shortSha(syncCommit);
      this.persist();

      this.set("building", "构建");
      const built = this.runBuild();
      if (!built.ok) {
        this.failWithLog(built.step, built.step, built.output);
        return;
      }

      // Persist expected commit; markUpdated happens on next boot hydrate.
      this.status.commit = shortSha(syncCommit);
      this.set(
        "restarting",
        `静默重启中（日志 ${SERVE_LOG}）`,
      );
      this.scheduleRestart();
      // Stay on restarting — do not set done here.
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
nohup pnpm gy serve --host ${host} --port ${port} --data-dir "${dataDir}" >${SERVE_LOG} 2>&1 &
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
