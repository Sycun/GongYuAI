import { MAX_CHAT_FILES, MAX_TEXT_BYTES, MAX_IMAGE_BYTES, MAX_FILES_BYTES, type ChatMessage, type ChatFile } from "@gongyuai/contracts";

function fileSize(file: ChatFile) {
  if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255 || typeof file.data !== "string") return -1;
  if (file.mediaType === "text/plain") {
    const bytes = Buffer.byteLength(file.data);
    return bytes <= MAX_TEXT_BYTES && !file.data.includes("\0") ? bytes : -1;
  }
  if (file.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data)) return -1;
  const bytes = Buffer.from(file.data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return -1;
  const header = bytes.subarray(0, 12);
  const valid = (file.mediaType === "image/png" && header.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
    || (file.mediaType === "image/jpeg" && header.subarray(0, 3).toString("hex") === "ffd8ff")
    || (file.mediaType === "image/webp" && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP");
  return valid ? bytes.length : -1;
}

export function validMessages(input: unknown): input is ChatMessage[] {
  if (!Array.isArray(input) || !input.length || input.at(-1)?.role !== "user") return false;
  return input.every(m => {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") return false;
    const files = m.attachments === undefined ? [] : m.attachments;
    if (!Array.isArray(files) || files.length > MAX_CHAT_FILES || (m.role !== "user" && files.length)) return false;
    const sizes = files.map(fileSize);
    return Boolean(m.content.trim() || files.length) && sizes.every(n => n >= 0) && sizes.reduce((a,b) => a+b, 0) <= MAX_FILES_BYTES;
  });
}
