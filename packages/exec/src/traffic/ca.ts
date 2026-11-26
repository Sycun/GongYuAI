import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Per-task CA. Safe under multi-worker simultaneous startup via atomic lock + rename. */
export function ensureTaskCa(taskDir: string, options: TaskCaOptions = {}): TaskCa {
  const subject = (options.subject ?? DEFAULT_TASK_CA_SUBJECT).trim() || DEFAULT_TASK_CA_SUBJECT;
  if (/[\r\n\u0000]/.test(subject)) throw new Error("invalid CA subject");
  const dir = join(taskDir, "traffic");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const certPath = join(dir, "ca.crt");
  const keyPath = join(dir, "ca.key");
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { certPath, keyPath, dir };
  }

  const lockDir = join(dir, ".ca-init.lock");
  const deadline = Date.now() + 8_000;
  let acquired = false;
  while (Date.now() < deadline) {
    if (existsSync(certPath) && existsSync(keyPath)) {
      return { certPath, keyPath, dir };
    }
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      acquired = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 15_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* lock already released */
      }
      sleepSync(25);
    }
  }

  try {
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      const nonce = `${process.pid}-${randomUUID().slice(0, 8)}`;
      const tmpKey = `ca.key.${nonce}.tmp`;
      const tmpCrt = `ca.crt.${nonce}.tmp`;
      openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", tmpKey], dir);
      chmodSync(join(dir, tmpKey), 0o600);
      openssl([
        "req", "-x509", "-new", "-key", tmpKey, "-days", "30",
        "-out", tmpCrt, "-subj", subject,
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      ], dir);
      chmodSync(join(dir, tmpCrt), 0o644);
      renameSync(join(dir, tmpKey), keyPath);
      renameSync(join(dir, tmpCrt), certPath);
    }
  } finally {
    if (acquired) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return { certPath, keyPath, dir };
}

const leaves = new Map<string, { cert: string; key: string }>();

/** Leaf certificate for one CONNECT host, cached in memory and isolated across concurrent worker processes. */
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
  const nonce = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const extFile = `leaf.${nonce}.ext`;
  const keyFile = `leaf.${nonce}.key`;
  const csrFile = `leaf.${nonce}.csr`;
  const crtFile = `leaf.${nonce}.crt`;
  const srlFile = `leaf.${nonce}.srl`;
  const san = isIP(name) ? `IP:${name}` : `DNS:${name}`;
  try {
    writeFileSync(
      join(dir, extFile),
      `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyFile], dir);
    chmodSync(join(dir, keyFile), 0o600);
    openssl(["req", "-new", "-key", keyFile, "-out", csrFile, "-subj", `/CN=${name}`], dir);
    openssl([
      "x509", "-req", "-in", csrFile,
      "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAserial", srlFile, "-CAcreateserial",
      "-out", crtFile, "-days", "7", "-extfile", extFile,
    ], dir);
    const pem = {
      cert: readFileSync(join(dir, crtFile), "utf8"),
      key: readFileSync(join(dir, keyFile), "utf8"),
    };
    leaves.set(cacheKey, pem);
    return pem;
  } finally {
    for (const f of [extFile, keyFile, csrFile, crtFile, srlFile]) {
      rmSync(join(dir, f), { force: true });
    }
  }
}
