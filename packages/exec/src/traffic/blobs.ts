import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TrafficBlobRef } from "@gongyuai/contracts";

/** Lane default: one slice is 8 KiB unless the caller asks for more. */
export const DEFAULT_BLOB_READ = 8 * 1024;
/** Hard cap for one slice. Larger bodies are read with a later offset. */
export const MAX_BLOB_READ = 64 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

export type BlobSlice = {
  sha256: string;
  offset: number;
  maxBytes: number;
  size: number;
  bytes: Buffer;
  nextOffset: number | null;
};

function blobRoot(taskDir: string): string {
  return resolve(taskDir, "traffic", "_blobs", "sha256");
}

/** Content-addressed path `<taskDir>/traffic/_blobs/sha256/<ab>/<hash>.bin`. */
export function blobPath(taskDir: string, sha256: string): string {
  const hash = sha256.trim().toLowerCase();
  if (!SHA256.test(hash)) throw new Error("invalid sha256");
  const root = blobRoot(taskDir);
  const file = resolve(root, hash.slice(0, 2), `${hash}.bin`);
  const rel = relative(root, file);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error("blob path escaped the task store");
  }
  return file;
}

function contained(taskDir: string, file: string): string {
  const root = blobRoot(taskDir);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realFile = realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    throw new Error("blob path escaped the task store");
  }
  return realFile;
}

/**
 * Write a body once. An existing digest is left untouched (dedup, no rewrite).
 * File mode is 0600. Empty input is not stored.
 */
export function putBlob(
  taskDir: string,
  bytes: Buffer,
  contentType?: string,
): TrafficBlobRef | undefined {
  if (bytes.length === 0) return undefined;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dest = blobPath(taskDir, sha256);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    if (existsSync(dest)) {
      unlinkSync(tmp);
    } else {
      try {
        renameSync(tmp, dest);
      } catch (err) {
        if (existsSync(dest)) unlinkSync(tmp);
        else throw err;
      }
    }
  }
  const ref: TrafficBlobRef = { sha256, size: bytes.length };
  if (contentType) ref.contentType = contentType;
  return ref;
}

/** Move a finished temp file into the content-addressed slot. */
export function commitHashedFile(
  taskDir: string,
  tmp: string,
  sha256: string,
  size: number,
  contentType?: string,
): TrafficBlobRef | undefined {
  if (size <= 0) {
    if (existsSync(tmp)) unlinkSync(tmp);
    return undefined;
  }
  const dest = blobPath(taskDir, sha256);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  if (existsSync(dest)) {
    unlinkSync(tmp);
  } else {
    try {
      renameSync(tmp, dest);
    } catch (err) {
      if (existsSync(dest)) unlinkSync(tmp);
      else throw err;
    }
  }
  const ref: TrafficBlobRef = { sha256, size };
  if (contentType) ref.contentType = contentType;
  return ref;
}

export function normalizeSlice(offset?: number, maxBytes?: number): { offset: number; maxBytes: number } {
  const off = offset ?? 0;
  const max = maxBytes ?? DEFAULT_BLOB_READ;
  if (!Number.isInteger(off) || off < 0) throw new Error("invalid offset");
  if (!Number.isInteger(max) || max < 1) throw new Error("invalid maxBytes");
  if (max > MAX_BLOB_READ) throw new Error(`maxBytes exceeds ${MAX_BLOB_READ}`);
  return { offset: off, maxBytes: max };
}

/** Read one window of a stored body without loading the rest of the file. */
export function readBlobSlice(
  taskDir: string,
  sha256: string,
  offset?: number,
  maxBytes?: number,
): BlobSlice {
  const bounds = normalizeSlice(offset, maxBytes);
  const file = contained(taskDir, blobPath(taskDir, sha256));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(bounds.maxBytes, Math.max(0, size - bounds.offset));
    const bytes = Buffer.alloc(length);
    if (length > 0) readSync(fd, bytes, 0, length, bounds.offset);
    const next = bounds.offset + length;
    return {
      sha256: sha256.trim().toLowerCase(),
      offset: bounds.offset,
      maxBytes: bounds.maxBytes,
      size,
      bytes,
      nextOffset: next < size ? next : null,
    };
  } finally {
    closeSync(fd);
  }
}

/** Read an entire stored blob when its size is within `maxBytes`, otherwise return `null`. */
export function readBlobBytes(
  taskDir: string,
  sha256: string,
  maxBytes: number,
): Buffer | null {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) return null;
  const file = contained(taskDir, blobPath(taskDir, sha256));
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size <= 0 || size > maxBytes) return null;
    const bytes = Buffer.alloc(size);
    readSync(fd, bytes, 0, size, 0);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
