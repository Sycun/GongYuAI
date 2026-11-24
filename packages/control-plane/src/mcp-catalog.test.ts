import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../../../mcp/builtin");
const PARSER_IDS = new Set(["nmap", "httpx", "nuclei", "ffuf"]);
const CAPABILITIES = new Set(["observe", "scan", "active-lab", "full"]);

test("builtin MCP catalog carries capability/parser/health metadata", () => {
  const ids = readdirSync(ROOT).filter((id) => statSync(join(ROOT, id)).isDirectory());
  assert.ok(ids.length >= 30, `expected >=30 packs, got ${ids.length}`);
  for (const id of ids) {
    const raw = JSON.parse(readFileSync(join(ROOT, id, "mcp.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.id ?? id, id, `${id}: id must match directory`);
    assert.ok(typeof raw.binary === "string" && raw.binary, `${id}: binary missing`);
    assert.ok(CAPABILITIES.has(String(raw.capability)), `${id}: capability missing/invalid`);
    assert.ok(Number(raw.timeoutMs) > 0, `${id}: timeoutMs missing`);
    if (id === "ffuf") assert.equal(raw.targetFlag, "-u");
    if (id === "wpscan") assert.equal(raw.targetFlag, "--url");
    if (id === "smbmap") assert.equal(raw.targetFlag, "-H");
    if (PARSER_IDS.has(id)) {
      assert.equal(raw.parser, id, `${id}: parser key missing`);
      assert.match(String(raw.defaultFlags ?? ""), /(-oX|-json|-jsonl|-of json)/, `${id}: default flags must be machine-readable`);
    }
  }
});
