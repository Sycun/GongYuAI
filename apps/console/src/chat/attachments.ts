import { MAX_TEXT_BYTES, MAX_IMAGE_BYTES, type ChatFile, type ImageType } from "@gongyuai/contracts/chat-input";
import { newId } from "./id";

export type FileRef = { id: string; name: string };
export type DraftFile = FileRef & { bytes: number; payload: ChatFile };

export async function prepareFile(file: File): Promise<DraftFile> {
  const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const imageTypes: Partial<Record<string, ImageType>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
  const mediaType = imageTypes[ext] ?? "text/plain";
  if (mediaType === "text/plain" && !/^(txt|md|log|csv|tsv|json|yaml|yml|xml|ini)$/.test(ext)) throw new Error("请选择 UTF-8 文本或 PNG、JPEG、WebP 图片。");
  if (file.size > (mediaType === "text/plain" ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES)) throw new Error("文本单个限 128 KiB，图片单个限 1 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let data: string;
  if (mediaType === "text/plain") {
    try { data = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(file.name + " 不是 UTF-8 文本。"); }
    if (data.includes("\0")) throw new Error(file.name + " 含有二进制内容。");
  } else {
    const pieces: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    data = btoa(pieces.join(""));
  }
  return { id: newId(), name: file.name, bytes: file.size, payload: { name: file.name, mediaType, data } };
}

let database: Promise<IDBDatabase> | undefined;
function openFiles() {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("gongyuai.chat.attachments", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { database = undefined; reject(new Error("浏览器无法打开附件存储。")); };
  });
  return database;
}

export async function storeFiles(files: DraftFile[]) {
  if (!files.length) return;
  const db = await openFiles();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    for (const file of files) store.put(file.payload, file.id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(new Error("附件保存失败，请检查浏览器剩余空间。"));
  });
}

export async function readFiles(refs?: FileRef[]): Promise<ChatFile[] | undefined> {
  if (!refs?.length) return undefined;
  const store = (await openFiles()).transaction("files").objectStore("files");
  return Promise.all(refs.map(ref => new Promise<ChatFile>((resolve, reject) => {
    const req = store.get(ref.id);
    req.onsuccess = () => req.result ? resolve(req.result) : reject(new Error("本地附件缺失，请重新添加：" + ref.name));
    req.onerror = () => reject(new Error("读取附件失败：" + ref.name));
  })));
}
