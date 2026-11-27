import {
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";

/** Maximum compressed blob size loaded into memory for transparent decoding (2 MiB). */
export const MAX_COMPRESSED_BLOB_BYTES = 2 * 1024 * 1024;
/** Maximum decompressed output size to guard against compression bombs (8 MiB). */
export const MAX_DECOMPRESSED_BLOB_BYTES = 8 * 1024 * 1024;
/** Prefix window fed into partial flush fallback when a stream exceeds maxOutputLength. */
const PARTIAL_FALLBACK_INPUT_BYTES = 64 * 1024;

export type SupportedContentEncoding = "gzip" | "x-gzip" | "deflate" | "br" | "zstd";

const SUPPORTED = new Set<string>(["gzip", "x-gzip", "deflate", "br", "zstd"]);

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Parse HTTP `Content-Encoding` header tokens in application order.
 * Returns `[]` when absent/identity, or `null` if any token is unsupported.
 */
export function parseContentEncodings(headers?: HeaderBag): SupportedContentEncoding[] | null {
  if (!headers) return [];
  const tokens: string[] = [];
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== "content-encoding" || raw == null) continue;
    const parts = Array.isArray(raw) ? raw : [raw];
    for (const part of parts) {
      for (const item of String(part).split(",")) {
        const norm = item.trim().toLowerCase();
        if (!norm || norm === "identity") continue;
        tokens.push(norm);
      }
    }
  }
  if (tokens.length === 0) return [];
  for (const token of tokens) {
    if (!SUPPORTED.has(token)) return null;
  }
  return tokens as SupportedContentEncoding[];
}

export function hasSupportedContentEncoding(headers?: HeaderBag): boolean {
  const encodings = parseContentEncodings(headers);
  return encodings != null && encodings.length > 0;
}

function isTooLargeError(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === "object"
    && "code" in err
    && (err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE",
  );
}

function inflateEither(buf: Buffer, maxOutputLength: number, finishFlush?: number): Buffer {
  const opts = finishFlush != null ? { finishFlush, maxOutputLength } : { maxOutputLength };
  try {
    return inflateSync(buf, opts);
  } catch (err) {
    if (isTooLargeError(err)) throw err;
    return inflateRawSync(buf, opts);
  }
}

function decompressStrict(buf: Buffer, encoding: SupportedContentEncoding, maxOutputLength: number): Buffer {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(buf, { maxOutputLength });
    case "deflate":
      return inflateEither(buf, maxOutputLength);
    case "br":
      return brotliDecompressSync(buf, { maxOutputLength });
    case "zstd":
      return zstdDecompressSync(buf, { maxOutputLength });
  }
}

function decompressPartial(buf: Buffer, encoding: SupportedContentEncoding, maxOutputLength: number): Buffer {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength });
    case "deflate":
      return inflateEither(buf, maxOutputLength, zlibConstants.Z_SYNC_FLUSH);
    case "br":
      return brotliDecompressSync(buf, { finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH, maxOutputLength });
    case "zstd":
      return zstdDecompressSync(buf, { finishFlush: zlibConstants.ZSTD_e_continue, maxOutputLength });
  }
}

function decompressStage(
  buf: Buffer,
  encoding: SupportedContentEncoding,
  maxOutputLength: number,
): { bytes: Buffer; partial: boolean } | null {
  if (buf.length === 0) return { bytes: Buffer.alloc(0), partial: false };
  try {
    return { bytes: decompressStrict(buf, encoding, maxOutputLength), partial: false };
  } catch (strictErr) {
    const sample = isTooLargeError(strictErr) && buf.length > PARTIAL_FALLBACK_INPUT_BYTES
      ? buf.subarray(0, PARTIAL_FALLBACK_INPUT_BYTES)
      : isTooLargeError(strictErr)
        ? null
        : buf;
    if (!sample) return null;
    try {
      const out = decompressPartial(sample, encoding, maxOutputLength);
      return out.length > 0 ? { bytes: out, partial: true } : null;
    } catch {
      return null;
    }
  }
}

export type DecodedTrafficBody = {
  bytes: Buffer;
  encoding: string;
  partial: boolean;
};

/**
 * Decode an HTTP body buffer according to `Content-Encoding` (RFC 9110 reverse order).
 * Returns `null` when unencoded, unsupported, a compression bomb, or invalid compressed data.
 */
export function decodeTrafficBody(
  raw: Buffer,
  headers?: HeaderBag,
  maxOutputLength = MAX_DECOMPRESSED_BLOB_BYTES,
): DecodedTrafficBody | null {
  const encodings = parseContentEncodings(headers);
  if (!encodings || encodings.length === 0) return null;
  let current = raw;
  let partial = false;
  for (let i = encodings.length - 1; i >= 0; i -= 1) {
    const step = decompressStage(current, encodings[i]!, maxOutputLength);
    if (!step) return null;
    current = step.bytes;
    if (step.partial) partial = true;
  }
  return { bytes: current, encoding: encodings.join(", "), partial };
}

/** Decode up to `maxBytes` of UTF-8 preview text, falling back to raw UTF-8 on failure. */
export function decodeTrafficPreview(
  raw: Buffer,
  headers: HeaderBag | undefined,
  maxBytes: number,
): string {
  if (maxBytes <= 0 || raw.length === 0) return "";
  const decoded = decodeTrafficBody(raw, headers);
  const source = decoded ? decoded.bytes : raw;
  return source.subarray(0, maxBytes).toString("utf8");
}
