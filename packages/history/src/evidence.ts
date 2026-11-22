import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, posix, resolve, win32 } from "node:path";

function normalizeEvidencePath(path: string): string {
  const input = path.replace(/\\/g, "/");
  const normalized = posix.normalize(input);
  if (
    !input ||
    normalized === "." ||
    normalized.endsWith("/") ||
    input.includes("\0") ||
    win32.isAbsolute(input) ||
    /^[a-z]:/i.test(input) ||
    input.split("/").includes("..")
  ) {
    throw new Error(`invalid relative evidence path: ${path}`);
  }
  return normalized;
}

function evidenceRoot(evidenceDir: string, allowMissing?: false): string;
function evidenceRoot(evidenceDir: string, allowMissing: true): string | undefined;
function evidenceRoot(evidenceDir: string, allowMissing = false): string | undefined {
  const root = resolve(evidenceDir);
  const stat = lstatSync(root, { throwIfNoEntry: !allowMissing });
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error("invalid evidence directory");
  return realpathSync(root);
}

export function resolveEvidenceFile(evidenceDir: string, path: string) {
  const relativePath = normalizeEvidencePath(path);
  const absolutePath = join(evidenceRoot(evidenceDir), relativePath);
  if (realpathSync(absolutePath) !== absolutePath) {
    throw new Error(`evidence path uses a symbolic link: ${relativePath}`);
  }
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || stat.nlink !== 1) {
    throw new Error(`evidence must be a regular file without hard links: ${relativePath}`);
  }
  return { relativePath, absolutePath, stat };
}

export function readEvidenceFile(evidenceDir: string, path: string): string {
  const { absolutePath } = resolveEvidenceFile(evidenceDir, path);
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    const { stat } = resolveEvidenceFile(evidenceDir, path);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("evidence file changed while opening it");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function listEvidenceFiles(evidenceDir: string): string[] {
  function walk(dir: string, prefix: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const relativePath = prefix + entry.name;
      if (entry.isDirectory()) return walk(join(dir, entry.name), `${relativePath}/`);
      return entry.isFile() ? [relativePath] : [];
    });
  }
  const root = evidenceRoot(evidenceDir, true);
  return root ? walk(root, "") : [];
}

export function writeEvidenceFile(evidenceDir: string, path: string, content: string): string {
  const relativePath = normalizeEvidencePath(path);
  const parts = relativePath.split("/");
  const name = parts.pop()!;
  let dir = evidenceRoot(evidenceDir);
  for (const part of parts) {
    dir = join(dir, part);
    mkdirSync(dir, { recursive: true });
    if (realpathSync(dir) !== dir) throw new Error(`evidence directory uses a symbolic link: ${path}`);
  }
  const absolutePath = join(dir, name);
  const fd = openSync(
    absolutePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    const { stat } = resolveEvidenceFile(evidenceDir, relativePath);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error("evidence file changed while opening it");
    }
    // Delay truncation until the opened file has passed the containment check.
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
  return relativePath;
}
