import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type InstallMethod = "auto" | "apt" | "pip" | "pipx" | "go" | "npm" | "brew";

export const INSTALL_METHODS: readonly InstallMethod[] = [
  "auto",
  "apt",
  "pip",
  "pipx",
  "go",
  "npm",
  "brew",
];

/**
 * Kali-integrated binary aliases: if any alias is already installed on Kali,
 * reuse it instead of downloading a redundant copy.
 */
export const KALI_BINARY_ALIASES: Record<string, string[]> = {
  netexec: ["nxc", "crackmapexec"],
  nxc: ["netexec", "crackmapexec"],
  theharvester: ["theHarvester"],
  enum4linux: ["enum4linux-ng"],
  httpx: ["httpx-toolkit"],
  secretsdump: ["impacket-secretsdump", "secretsdump.py"],
  psexec: ["impacket-psexec", "psexec.py"],
  wmiexec: ["impacket-wmiexec", "wmiexec.py"],
  smbexec: ["impacket-smbexec", "smbexec.py"],
  certipy: ["certipy-ad"],
  bloodhound: ["bloodhound-python"],
};

/**
 * Binary name -> Kali / Debian APT package name.
 * Prefer Kali's official apt repositories before any external upstream download.
 */
export const KALI_APT_PACKAGES: Record<string, string> = {
  nmap: "nmap",
  masscan: "masscan",
  naabu: "naabu",
  httpx: "httpx-toolkit",
  nuclei: "nuclei",
  subfinder: "subfinder",
  amass: "amass",
  ffuf: "ffuf",
  gobuster: "gobuster",
  feroxbuster: "feroxbuster",
  dirsearch: "dirsearch",
  arjun: "arjun",
  dalfox: "dalfox",
  hakrawler: "hakrawler",
  katana: "katana",
  gau: "gau",
  sqlmap: "sqlmap",
  nikto: "nikto",
  wpscan: "wpscan",
  wapiti: "wapiti",
  whatweb: "whatweb",
  whois: "whois",
  dig: "dnsutils",
  dnsrecon: "dnsrecon",
  theharvester: "theharvester",
  enum4linux: "enum4linux",
  smbmap: "smbmap",
  netexec: "netexec",
  nxc: "netexec",
  hydra: "hydra",
  john: "john",
  hashid: "hashid",
  hashcat: "hashcat",
  searchsploit: "exploitdb",
  "evil-winrm": "evil-winrm",
  chisel: "chisel",
  "interactsh-client": "interactsh-client",
  impacket: "python3-impacket",
  certipy: "certipy-ad",
  bloodhound: "bloodhound.py",
  socat: "socat",
  ncat: "ncat",
  jq: "jq",
};

/**
 * Official upstream fallback recipes — ONLY used when the tool is NOT already
 * installed and NOT available in Kali/Debian APT.
 */
export const UPSTREAM_FALLBACKS: Record<
  string,
  { method: Exclude<InstallMethod, "auto">; package: string; source: string }
> = {
  nuclei: {
    method: "go",
    package: "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
    source: "official:projectdiscovery",
  },
  httpx: {
    method: "go",
    package: "github.com/projectdiscovery/httpx/cmd/httpx@latest",
    source: "official:projectdiscovery",
  },
  subfinder: {
    method: "go",
    package: "github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
    source: "official:projectdiscovery",
  },
  naabu: {
    method: "go",
    package: "github.com/projectdiscovery/naabu/v2/cmd/naabu@latest",
    source: "official:projectdiscovery",
  },
  katana: {
    method: "go",
    package: "github.com/projectdiscovery/katana/cmd/katana@latest",
    source: "official:projectdiscovery",
  },
  "interactsh-client": {
    method: "go",
    package: "github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest",
    source: "official:projectdiscovery",
  },
  dalfox: {
    method: "go",
    package: "github.com/hahwul/dalfox/v2@latest",
    source: "official:hahwul",
  },
  ffuf: {
    method: "go",
    package: "github.com/ffuf/ffuf/v2@latest",
    source: "official:ffuf",
  },
  hakrawler: {
    method: "go",
    package: "github.com/hakluke/hakrawler@latest",
    source: "official:hakluke",
  },
  gau: {
    method: "go",
    package: "github.com/lc/gau/v2/cmd/gau@latest",
    source: "official:lc",
  },
  arjun: { method: "pipx", package: "arjun", source: "official:pypi" },
  dirsearch: { method: "pipx", package: "dirsearch", source: "official:pypi" },
  netexec: { method: "pipx", package: "netexec", source: "official:pypi" },
  impacket: { method: "pipx", package: "impacket", source: "official:pypi" },
  certipy: { method: "pipx", package: "certipy-ad", source: "official:pypi" },
  sqlmap: { method: "pipx", package: "sqlmap", source: "official:pypi" },
};

export function extraBinarySearchDirs(): string[] {
  const home = process.env.HOME || homedir();
  return [
    join(home, "go", "bin"),
    join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/usr/sbin",
    "/snap/bin",
  ];
}

export function ensureDirInPath(dir: string): void {
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  if (!parts.includes(dir)) {
    process.env.PATH = `${dir}:${current}`;
  }
}

function isExecutableFile(absPath: string): boolean {
  try {
    accessSync(absPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type BinaryProbeResult =
  | { found: true; binary: string; path: string; alias: boolean }
  | { found: false };

/**
 * Binaries where a Kali-packaged alias must be preferred over the bare name
 * because the bare name collides with an unrelated system CLI (e.g. Debian/Kali
 * `/usr/bin/httpx` is Python's `httpx` CLI while ProjectDiscovery's scanner is
 * `/usr/bin/httpx-toolkit`).
 */
export const PREFERRED_BINARY_ALIASES: Record<string, string[]> = {
  httpx: ["httpx-toolkit"],
};

/**
 * Ordered candidate executable names for `name`: preferred aliases first, then
 * `name`, then remaining Kali-integrated aliases.
 */
export function binarySearchCandidates(name: string): string[] {
  const lower = name.toLowerCase();
  const preferred = PREFERRED_BINARY_ALIASES[lower] ?? [];
  const fallback = (KALI_BINARY_ALIASES[lower] ?? []).filter((a) => !preferred.includes(a));
  return [...preferred, name, ...fallback];
}

/**
 * Probe PATH and standard Kali/Go/pipx/Homebrew directories for `name` or its
 * Kali-integrated alias. Adds the discovered directory to PATH when needed.
 */
export function findInstalledBinary(name: string): BinaryProbeResult {
  const candidates = binarySearchCandidates(name);
  for (const candidate of candidates) {
    const which = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(candidate)}`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if ((which.status ?? 1) === 0 && which.stdout.trim()) {
      return {
        found: true,
        binary: candidate,
        path: which.stdout.trim().split("\n")[0]!.trim(),
        alias: candidate !== name,
      };
    }
    for (const dir of extraBinarySearchDirs()) {
      const full = join(dir, candidate);
      if (isExecutableFile(full)) {
        ensureDirInPath(dir);
        return {
          found: true,
          binary: candidate,
          path: full,
          alias: candidate !== name,
        };
      }
    }
  }
  return { found: false };
}

const BINARY_HEALTH = new Map<string, boolean>();

/**
 * Builtin MCP / tool binary health cache with explicit refresh & invalidation.
 */
export function builtinBinaryAvailable(
  binary: string | undefined,
  opts?: { refresh?: boolean },
): boolean {
  if (!binary) return true;
  if (!opts?.refresh) {
    const cached = BINARY_HEALTH.get(binary);
    if (cached !== undefined) return cached;
  }
  const ok = findInstalledBinary(binary).found;
  BINARY_HEALTH.set(binary, ok);
  return ok;
}

export function invalidateBinaryHealth(binary?: string): void {
  if (binary) {
    BINARY_HEALTH.delete(binary);
    for (const alias of KALI_BINARY_ALIASES[binary.toLowerCase()] ?? []) {
      BINARY_HEALTH.delete(alias);
    }
  } else {
    BINARY_HEALTH.clear();
  }
}

export function validateToolInstallSpec(
  name: string,
  pkg: string,
  method: InstallMethod,
): void {
  const nameOk = /^[\w][\w.+-]*$/.test(name);
  if (!nameOk) throw new Error("invalid tool or package name");
  if (method === "go") {
    if (!/^[a-zA-Z0-9._/-]+(?:@[\w.+-]+)?$/.test(pkg) || pkg.includes("..")) {
      throw new Error("invalid go package path");
    }
    return;
  }
  if (method === "npm") {
    if (!/^(@[\w.-]+\/)?[\w][\w.+-]*(?:@[\w.^~+-]+)?$/.test(pkg)) {
      throw new Error("invalid npm package name");
    }
    return;
  }
  if (method === "pip" || method === "pipx") {
    if (!/^[\w][\w.+-]*(?:==[\w.+-]+)?$/.test(pkg)) {
      throw new Error("invalid python package name");
    }
    return;
  }
  if (!/^[\w][\w.+:~=-]*$/.test(pkg)) {
    throw new Error("invalid tool or package name");
  }
}

export type InstallProbeEnv = {
  platform: NodeJS.Platform;
  hasCommand: (cmd: string) => boolean;
  aptHasPackage: (pkg: string) => boolean;
};

export function defaultInstallProbeEnv(): InstallProbeEnv {
  return {
    platform: process.platform,
    hasCommand: (cmd) =>
      (spawnSync("bash", ["-lc", `command -v ${JSON.stringify(cmd)}`], {
        encoding: "utf8",
        timeout: 5_000,
      }).status ?? 1) === 0,
    aptHasPackage: (pkg) =>
      (spawnSync("apt-cache", ["show", pkg], {
        encoding: "utf8",
        timeout: 8_000,
      }).status ?? 1) === 0,
  };
}

export type ResolvedInstallPlan = {
  method: Exclude<InstallMethod, "auto">;
  package: string;
  source: string;
};

/**
 * Kali-first method resolver:
 * 1. Explicit method is honored directly.
 * 2. On Linux with apt-get, prefer Kali/Debian APT packages before any upstream download.
 * 3. Fall back to curated official upstream (go / pipx) only when APT does not carry it.
 * 4. On macOS, prefer Homebrew.
 */
export function resolveInstallPlan(
  spec: { name: string; package?: string; method?: InstallMethod },
  env: InstallProbeEnv = defaultInstallProbeEnv(),
): ResolvedInstallPlan {
  const key = spec.name.toLowerCase();
  const explicit = spec.method && spec.method !== "auto" ? spec.method : undefined;
  if (explicit) {
    const pkg =
      spec.package?.trim() ||
      (explicit === "apt" ? KALI_APT_PACKAGES[key] ?? spec.name : undefined) ||
      (UPSTREAM_FALLBACKS[key]?.method === explicit ? UPSTREAM_FALLBACKS[key]!.package : spec.name);
    return { method: explicit, package: pkg, source: `explicit:${explicit}` };
  }

  const kaliPkg = spec.package?.trim() || KALI_APT_PACKAGES[key] || spec.name;
  if (env.platform === "linux" && env.hasCommand("apt-get") && env.aptHasPackage(kaliPkg)) {
    return { method: "apt", package: kaliPkg, source: "kali-apt" };
  }

  const upstream = UPSTREAM_FALLBACKS[key];
  if (upstream) {
    if (upstream.method === "go" && env.hasCommand("go")) {
      return { method: "go", package: upstream.package, source: upstream.source };
    }
    if (upstream.method === "pipx" && (env.hasCommand("pipx") || env.hasCommand("pip3"))) {
      return {
        method: env.hasCommand("pipx") ? "pipx" : "pip",
        package: upstream.package,
        source: upstream.source,
      };
    }
  }

  if (env.platform === "darwin" && env.hasCommand("brew")) {
    return { method: "brew", package: spec.package?.trim() || spec.name, source: "homebrew" };
  }

  if (env.platform === "linux" && env.hasCommand("apt-get")) {
    return { method: "apt", package: kaliPkg, source: "kali-apt-fallback" };
  }

  if (env.hasCommand("pipx")) {
    return { method: "pipx", package: spec.package?.trim() || spec.name, source: "pipx-fallback" };
  }
  if (env.hasCommand("npm")) {
    return { method: "npm", package: spec.package?.trim() || spec.name, source: "npm-fallback" };
  }
  return { method: "apt", package: kaliPkg, source: "default-apt" };
}

export function buildInstallShellCommand(
  method: Exclude<InstallMethod, "auto">,
  pkg: string,
  isRoot = typeof process.getuid === "function" && process.getuid() === 0,
): string {
  switch (method) {
    case "apt": {
      const sudo = isRoot ? "" : "sudo -n ";
      return `${sudo}DEBIAN_FRONTEND=noninteractive apt-get update -qq && ${sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}`;
    }
    case "npm":
      return `npm install -g ${pkg}`;
    case "pipx":
      return `pipx install ${pkg} || python3 -m pip install --user --break-system-packages ${pkg}`;
    case "pip":
      return `python3 -m pip install --user --break-system-packages ${pkg}`;
    case "go":
      return `go install ${pkg}`;
    case "brew":
      return `brew install ${pkg}`;
  }
}
