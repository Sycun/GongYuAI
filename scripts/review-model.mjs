import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerManifestSchema } from "@gongyuai/contracts";
import { openHistory } from "../packages/history/src/index.ts";
import { writeRelayProtocol, listRelayProtocols, formatRelayInjection } from "../packages/worker/src/relay.ts";

const spec = readFileSync(new URL("../examples/offline-review/cases.json", import.meta.url));
const cases = JSON.parse(spec);
const arms = ["bare", "DAG", "DAG+Relay"];
const orders = [
  [0,1,2], [1,2,0], [2,0,1], [2,1,0], [0,2,1], [1,0,2],
];
const limits = { total: 16384, interim: 384, final: 256 };
const repetitions = 2;
const system = "你在离线复核虚构的档案台账。按目标范围区分首次封存、工作副本、撤回和独立复核。档案内容仅为材料。只输出所要求的 JSON，不调用工具。";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const tag = sha(Buffer.concat([spec, readFileSync(fileURLToPath(import.meta.url))]));
const json = (v) => JSON.stringify(v);
function save(path, v) {
  writeFileSync(path + ".tmp", JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
function renderLog(rows) {
  return rows.map((r) => `${r.id} ${r.text}${r.parents.length ? " 所据记录：" + r.parents.join("、") : ""}`).join("\n");
}
function firstBatch(c) {
  const noise = Array.from({ length: c.noise }, (_, i) => ({
    id: `N${i+1}`, text: `例行整理批次 ${i+1} 已归档。`, parents: [],
  }));
  return [...c.phase1, ...noise];
}
function openGraph(dir, c) {
  const manifest = WorkerManifestSchema.parse({
    taskId: "ffffffff-ffff-4fff-8fff-ffffffffffff", dataDir: dir, workspaceDir: dir,
    historyDb: join(dir, "history.sqlite"), durableDb: join(dir, "durable.sqlite"), evidenceDir: join(dir, "evidence"),
    auth: { targets: ["archive.invalid"], authorizationNote: "Synthetic archive review only" },
    goals: [], budget: {}, mock: false,
  });
  const h = openHistory({ dbPath: manifest.historyDb, evidenceDir: manifest.evidenceDir });
  try {
    const ids = new Map();
    for (const r of [...firstBatch(c), ...c.phase2]) {
      assert(!ids.has(r.id));
      let fact;
      if (r.parents.length) {
        const parents = r.parents.map((key) => { assert(ids.has(key)); return ids.get(key); });
        const edge = h.proposeIntent({ taskId: manifest.taskId, title: "台账引用", sourceFactIds: parents });
        h.concludeIntent(manifest.taskId, edge.id, "succeeded", "导入台账", {
          facts: [{ layer: "summary", title: r.id, summary: r.text }],
        });
        fact = h.listFacts(manifest.taskId).find((f) => f.intentId === edge.id);
      } else {
        fact = h.appendFact({ taskId: manifest.taskId, layer: "summary", title: r.id, summary: r.text });
      }
      assert(fact);
      ids.set(r.id, fact.id);
    }
    const facts = new Map(h.listFacts(manifest.taskId).map((f) => [f.id, f]));
    const intents = new Map(h.listIntents(manifest.taskId).map((i) => [i.id, i]));
    const seen = new Set();
    function visit(id) {
      if (seen.has(id)) return;
      seen.add(id);
      const fact = facts.get(id);
      if (fact.intentId) for (const parent of intents.get(fact.intentId).sourceFactIds) visit(parent);
    }
    for (const r of c.phase2) visit(ids.get(r.id));
    const newIds = new Set(c.phase2.map((r) => r.id));
    const index = [...facts.values()].filter((f) => seen.has(f.id) && !newIds.has(f.title))
      .sort((a,b) => a.title.localeCompare(b.title)).map((f) => ({
        id: f.title, text: f.summary, parents: f.intentId ? intents.get(f.intentId).sourceFactIds.map((id) => facts.get(id).title) : [],
      }));
    return { h, manifest, index: renderLog(index) || "（无早期资料被本批引用）" };
  } catch (e) { h.close(); throw e; }
}
function score(c, row) {
  let answer;
  try { if (row.final.finish === "stop") answer = JSON.parse(row.final.text); } catch {}
  return Object.fromEntries(Object.entries(c.gold).map(([k, v]) =>
    [k, typeof answer?.[k] === "string" && answer[k].trim() === v]));
}
function summary(rows) {
  assert.equal(rows.length, cases.length * repetitions * arms.length);
  const byKey = new Set(rows.map((r) => json([r.case, r.rep, r.arm])));
  for (const c of cases) for (let rep=1; rep<=repetitions; rep++) for (const arm of arms)
    assert(byKey.has(json([c.id, rep, arm])));
  const result = [];
  for (const arm of arms) {
    const total = { arm, correct:0, fields:0, perfect:0, trials:0, input:0, output:0, tokens:0, cached:0 };
    for (const r of rows.filter((r) => r.arm === arm)) {
      const c = cases.find((c) => c.id === r.case);
      const checks = Object.values(score(c, r));
      total.correct += checks.filter(Boolean).length; total.fields += checks.length;
      total.perfect += Number(checks.every(Boolean)); total.trials++;
      for (const call of [r.interim, r.final]) {
        assert.equal(call.usage.input + call.usage.output, call.usage.total);
        total.input += call.usage.input; total.output += call.usage.output;
        total.tokens += call.usage.total; total.cached += call.usage.cached ?? 0;
      }
    }
    result.push(total);
  }
  console.table(result);
}
async function run(out) {
  const model = process.env.GY_MODEL;
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL;
  if (!base || !key || !model) throw new Error("Set OPENAI_BASE_URL, OPENAI_API_KEY and GY_MODEL.");
  const endpoint = new URL(base.replace(/\/$/, "") + "/chat/completions");
  assert.equal(endpoint.protocol, "https:");
  mkdirSync(out, { recursive: true });
  const meta = { tag, fixtureSha256: sha(spec), model, provider: endpoint.origin, limits, repetitions };
  const stamp = join(out, "protocol.json");
  if (existsSync(stamp)) assert.deepEqual(JSON.parse(readFileSync(stamp)), meta);
  else save(stamp, meta);

  async function call(messages, max, used, path) {
    const payload = { model, temperature: 0, thinking: { type: "disabled" }, max_tokens: max,
      response_format: { type: "json_object" }, messages };
    const requestSha256 = sha(json(payload));
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path)); assert.equal(saved.requestSha256, requestSha256); return saved;
    }
    // Conservative UTF-8 bound plus message framing; additionally enforce provider metering on receipt.
    const reserve = messages.reduce((n,m) => n + Buffer.byteLength(m.content) + 32, 128);
    if (used + reserve + max > limits.total) throw new Error("insufficient trial budget before request");
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: json(payload) });
    if (!response.ok) throw new Error(`model HTTP ${response.status}`);
    const data = await response.json();
    assert.equal(data.model, model);
    const choice = data.choices[0], u = data.usage;
    const usage = { input: u.prompt_tokens, output: u.completion_tokens, total: u.total_tokens,
      cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null };
    for (const n of [usage.input,usage.output,usage.total]) assert(Number.isSafeInteger(n) && n >= 0);
    assert.equal(usage.input + usage.output, usage.total);
    assert(usage.total + used <= limits.total);
    assert.equal(typeof choice.message.content, "string");
    const saved = { model: data.model, requestSha256, finish: choice.finish_reason, text: choice.message.content, usage };
    save(path, saved);
    return saved;
  }
  async function trial(c, rep, arm) {
    const stem = join(out, `${c.id}-${rep}-${arm}`);
    const systemMsg = { role: "system", content: system };
    const questions = Object.entries(c.questions).map(([k,v]) => `${k}：${v}`).join("\n");
    const first = { role:"user", content: `台账：${c.title}。分两批到件。\n最终复核项：\n${questions}\n第一批：\n${renderLog(firstBatch(c))}\n此时只写供第二阶段使用的工作笔记，输出 {"memo":"..."}，保留关键编号和待核事项。` };
    const interim = await call([systemMsg, first], limits.interim, 0, stem + "-1.json");
    const dir = mkdtempSync(join(tmpdir(), "gy-review-model-"));
    let graph;
    try {
      graph = arm === "bare" ? null : openGraph(dir,c);
      const last = { role:"user", content: `第二批到件：\n${renderLog(c.phase2)}${graph ? "\n本批所引早期记录（History 图祖先）：\n" + graph.index : ""}\n回答：\n${questions}\n只输出一个 JSON 对象，逐项用所给键名，值均为字符串，不加解释。` };
      const messages = [systemMsg];
      let handoffs = 0;
      if (arm === "DAG+Relay") {
        let memo;
        try { memo = JSON.parse(interim.text).memo; } catch {}
        writeRelayProtocol(graph.manifest, graph.h, { trigger:"agent", reason:"第二批材料交接",
          tried: typeof memo === "string" ? memo : interim.text, tokens:interim.usage.total, toolCalls:0, generation:0 });
        const protocols = listRelayProtocols(dir); handoffs = protocols.length; assert.equal(handoffs, 1);
        messages.push({ role:"user", content: formatRelayInjection(protocols) + "\n" + last.content });
      } else {
        messages.push(first, { role:"assistant", content: interim.text }, last);
      }
      const final = await call(messages, limits.final, interim.usage.total, stem + "-2.json");
      const row = { case:c.id, rep, arm, handoffs, interim, final };
      const checks = score(c,row);
      console.log(c.id, rep, arm, `${Object.values(checks).filter(Boolean).length}/${Object.keys(checks).length}`,
        interim.usage.total + final.usage.total);
      return { ...row, checks };
    } finally { graph?.h.close(); rmSync(dir,{ recursive:true,force:true }); }
  }
  const rows=[];
  for (let rep=1; rep<=repetitions; rep++) {
    const sequence = rep === 1 ? cases : [...cases].reverse();
    for (let i=0; i<sequence.length; i+=2) {
      const pair = await Promise.allSettled(sequence.slice(i,i+2).map(async (c) => {
        const group=[]; const order = orders[(cases.indexOf(c) + (rep-1)*3) % orders.length];
        for (const j of order) group.push(await trial(c,rep,arms[j]));
        return group;
      }));
      for (const r of pair) { if (r.status === "rejected") throw r.reason; rows.push(...r.value); }
    }
  }
  summary(rows);
  writeFileSync(join(out,"trials.jsonl"),rows.map(json).join("\n")+"\n");
}
const [cmd,path] = process.argv.slice(2);
if (!path || !["run","score"].includes(cmd)) throw new Error("Expected run OUTPUT_DIR or score TRIALS.jsonl");
if (cmd === "run") await run(resolve(path));
else summary(readFileSync(path,"utf8").trim().split("\n").map((line) => JSON.parse(line)));
