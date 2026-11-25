#!/usr/bin/env tsx
/**
 * 批量把本地目录（.md / .txt / .pdf / .docx）导入 GongYuAI 参考资料库，并可选触发云端/本地向量化。
 *
 * 用法：
 *   npx tsx scripts/knowledge-import-dir.ts --dir "/path/to/知识库" [--skip-embed]
 *   npx tsx scripts/knowledge-import-dir.ts --embed-only
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { KnowledgeStore, SettingsStore } from "@gongyuai/control-plane";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

const hasFlag = (flag: string) => process.argv.includes(flag);

const dataDir = resolve(argValue("--data-dir") ?? ".gongyuai");
const targetDir = argValue("--dir") ? resolve(argValue("--dir")!) : null;
const skipEmbed = hasFlag("--skip-embed");
const embedOnly = hasFlag("--embed-only");
const rebuild = hasFlag("--rebuild");
const maxTextBytes = 7 * 1024 * 1024;
const maxPdfBytes = Number(argValue("--max-pdf-mb") ?? "16") * 1024 * 1024;

if (!embedOnly && !targetDir) {
  console.error("Usage: tsx scripts/knowledge-import-dir.ts --dir <path> [--skip-embed] [--embed-only] [--rebuild]");
  process.exit(1);
}

const settings = new SettingsStore(dataDir, process.cwd());
const knowledge = new KnowledgeStore(dataDir, {
  embeddingSettings: () => {
    const cur = settings.get().knowledgeEmbedding;
    return skipEmbed ? { ...cur, enabled: false } : cur;
  },
});

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "_images" || entry.name === "Images") {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function extractDocxText(filePath: string): string | null {
  try {
    const text = execFileSync("textutil", ["-convert", "txt", "-stdout", filePath], {
      encoding: "utf8",
      maxBuffer: maxTextBytes,
      timeout: 30_000,
    });
    return text.trim() || null;
  } catch {
    return null;
  }
}

function tagsFromRelPath(relPath: string): { publisher: string; tags: string[] } {
  const parts = relPath.split(sep).filter(Boolean);
  const publisher = (parts.length > 1 ? parts[0]! : "本地知识库").slice(0, 200);
  const rawTags = parts
    .slice(0, -1)
    .map((p) => p.trim().slice(0, 60))
    .filter((p) => p.length > 0);
  const tags = [...new Set(rawTags)].slice(0, 8);
  return { publisher, tags };
}

async function runImport(root: string) {
  if (!existsSync(root)) {
    throw new Error(`Directory not found: ${root}`);
  }
  const files = walkFiles(root);
  const stats = {
    scanned: files.length,
    imported: 0,
    unchanged: 0,
    updated: 0,
    skippedUnsupported: 0,
    skippedEmptyOrLarge: 0,
    failed: 0,
  };

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const ext = extname(file).toLowerCase();
    if (ext !== ".md" && ext !== ".txt" && ext !== ".pdf" && ext !== ".docx") {
      stats.skippedUnsupported += 1;
      continue;
    }
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      stats.failed += 1;
      continue;
    }
    if (size === 0 || (ext === ".pdf" ? size > maxPdfBytes : size > maxTextBytes)) {
      stats.skippedEmptyOrLarge += 1;
      continue;
    }

    const relPath = relative(root, file);
    const { publisher, tags } = tagsFromRelPath(relPath);
    const title = basename(file, ext).slice(0, 300) || relPath.slice(0, 300);
    const sourceKey = `dir:${relPath}`.slice(0, 300);

    try {
      let result;
      if (ext === ".md" || ext === ".txt") {
        const content = readFileSync(file, "utf8");
        if (!content.trim()) {
          stats.skippedEmptyOrLarge += 1;
          continue;
        }
        result = knowledge.import({
          title,
          publisher,
          sourceKind: "original",
          format: ext === ".md" ? "markdown" : "text",
          sourceKey,
          content,
          tags,
          note: relPath,
          scope: { kind: "shared" },
        });
      } else if (ext === ".pdf") {
        const buf = readFileSync(file);
        result = knowledge.import({
          title,
          publisher,
          sourceKind: "original",
          format: "pdf",
          sourceKey,
          contentBase64: buf.toString("base64"),
          tags,
          note: relPath,
          scope: { kind: "shared" },
        });
      } else {
        const content = extractDocxText(file);
        if (!content) {
          stats.skippedEmptyOrLarge += 1;
          continue;
        }
        result = knowledge.import({
          title,
          publisher,
          sourceKind: "original",
          format: "text",
          sourceKey,
          content,
          tags: [...new Set([...tags, "docx"])].slice(0, 8),
          note: relPath,
          scope: { kind: "shared" },
        });
      }

      if (result.outcome === "created") stats.imported += 1;
      else if (result.outcome === "unchanged") stats.unchanged += 1;
      else stats.updated += 1;
    } catch (err) {
      stats.failed += 1;
      if (stats.failed <= 15) {
        console.warn(`[WARN] ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const doneDocs = stats.imported + stats.unchanged + stats.updated + stats.failed;
    if (doneDocs > 0 && doneDocs % 100 === 0) {
      console.log(
        `[IMPORT] processed=${doneDocs} created=${stats.imported} unchanged=${stats.unchanged} failed=${stats.failed}`,
      );
    }
  }

  console.log("[IMPORT DONE]", JSON.stringify(stats));
}

async function waitForEmbedding() {
  const scope = { engagementId: null };
  const action = rebuild ? knowledge.rebuildIndex(scope, {}) : knowledge.retryIndex(scope, {});
  console.log("[EMBED START]", JSON.stringify(action.status));

  let lastLog = "";
  while (true) {
    const st = knowledge.indexStatus(scope);
    const line = `state=${st.state} indexed=${st.indexedChunks}/${st.totalChunks} pending=${st.pendingChunks} failed=${st.failedChunks}`;
    if (line !== lastLog) {
      console.log(`[EMBED] ${line}`);
      lastLog = line;
    }
    if (st.pendingChunks === 0 && st.state !== "indexing") {
      console.log("[EMBED DONE]", JSON.stringify(st));
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  if (!embedOnly && targetDir) {
    await runImport(targetDir);
  }
  if (!skipEmbed) {
    await waitForEmbedding();
  }
  knowledge.close();
}

main().catch((err) => {
  console.error(err);
  knowledge.close();
  process.exit(1);
});
