import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";

export type TaskCa = {
  certPath: string;
  keyPath: string;
  dir: string;
};

function openssl(args: string[], cwd: string): void {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`openssl unavailable: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`openssl ${args[0] ?? ""} failed: ${(result.stderr || result.stdout || "").slice(0, 500)}`);
  }
}

export const DEFAULT_TASK_CA_SUBJECT = "/CN=Local Proxy Root CA";

export type TaskCaOptions = {
  /** OpenSSL `-subj` value. Defaults to {@link DEFAULT_TASK_CA_SUBJECT}. */
  subject?: string;
};

/** Per-task CA. The key stays in the task directory at mode 0600 and is never installed system-wide. */
export function ensureTaskCa(taskDir: string, options: TaskCaOptions = {}): TaskCa {
  const subject = (options.subject ?? DEFAULT_TASK_CA_SUBJECT).trim() || DEFAULT_TASK_CA_SUBJECT;
  if (/[\r\n\u0000]/.test(subject)) throw new Error("invalid CA subject");
  const dir = join(taskDir, "traffic");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const certPath = join(dir, "ca.crt");
  const keyPath = join(dir, "ca.key");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"], dir);
    chmodSync(keyPath, 0o600);
    openssl([
      "req", "-x509", "-new", "-key", "ca.key", "-days", "30",
      "-out", "ca.crt", "-subj", subject,
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ], dir);
    chmodSync(certPath, 0o644);
  }
  return { certPath, keyPath, dir };
}

const leaves = new Map<string, { cert: string; key: string }>();

/** Leaf certificate for one CONNECT host, cached for the life of the process. */
export function leafFor(ca: TaskCa, host: string): { cert: string; key: string } {
  const name = host.trim().toLowerCase();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("invalid certificate host");
  }
  const cacheKey = `${ca.certPath}\n${name}`;
  const cached = leaves.get(cacheKey);
  if (cached) return cached;
  const id = createHash("sha256").update(name).digest("hex").slice(0, 16);
  const dir = join(ca.dir, "leafs", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const san = isIP(name) ? `IP:${name}` : `DNS:${name}`;
  writeFileSync(
    join(dir, "leaf.ext"),
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"], dir);
  chmodSync(join(dir, "leaf.key"), 0o600);
  openssl(["req", "-new", "-key", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${name}`], dir);
  openssl([
    "x509", "-req", "-in", "leaf.csr",
    "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAcreateserial",
    "-out", "leaf.crt", "-days", "7", "-extfile", "leaf.ext",
  ], dir);
  const pem = {
    cert: readFileSync(join(dir, "leaf.crt"), "utf8"),
    key: readFileSync(join(dir, "leaf.key"), "utf8"),
  };
  leaves.set(cacheKey, pem);
  return pem;
}
