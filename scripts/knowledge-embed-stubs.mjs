/**
 * 页面验收用的本机 OpenAI 兼容 /embeddings 替身服务。
 *
 * 四个角色各占一个端口，行为可经 POST /__control 热调（维度、延迟、探测/正文分维、期望密钥）：
 *   8898 local-slow   —— 慢响应（默认 2300ms），复现「慢响应 + 页面轮询」
 *   8899 cloud-A      —— 云端服务 A（12 维）
 *   8900 cloud-B      —— 云端服务 B（16 维），与 A 不同来源，用于核对密钥不串用
 *   8901 dim-broken   —— 探测 12 维、正文 3 维，用于维度错配；恢复后两维一致
 *
 * 每个请求记一行 JSONL（时间、模型、输入条数、返回维度、延迟、凭据是否出现/是否符合期望），
 * 凭据**只记布尔**，绝不落密钥原文。输入正文为合成资料，可完整记录。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const logDir = process.argv[2] ?? join(process.cwd(), "out/knowledge-embed-stubs");
mkdirSync(logDir, { recursive: true });

const CONCEPTS = [
  { dim: 0, words: ["换班", "换任", "交接", "handover", "commander", "负责人"] },
  { dim: 1, words: ["续上", "继续", "续接", "state", "resume", "progress", "进度"] },
  { dim: 2, words: ["更正", "回函", "correction", "凭据"] },
];

function conceptVector(text, dim, offset) {
  const lower = String(text).toLowerCase();
  const vector = new Array(dim).fill(0);
  for (const concept of CONCEPTS) {
    const hits = concept.words.filter((word) => lower.includes(word)).length;
    if (hits) vector[concept.dim + offset] = hits;
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) { vector[dim - 1] = 1; sum = 1; }
  const norm = Math.sqrt(sum);
  return vector.map((value) => value / norm);
}

const ROLES = [
  { name: "local-slow", port: 8898, dim: 8, offset: 0, delayMs: 2300, expectedKey: null },
  { name: "cloud-A", port: 8899, dim: 12, offset: 4, delayMs: 0, expectedKey: null },
  { name: "cloud-B", port: 8900, dim: 16, offset: 4, delayMs: 0, expectedKey: null },
  { name: "dim-broken", port: 8901, dim: 12, offset: 0, delayMs: 0, expectedKey: null },
];

for (const role of ROLES) {
  const state = {
    probeDim: role.dim,
    bodyDim: role.dim,
    delayMs: role.delayMs,
    expectedKey: role.expectedKey,
    /** 第 N 个请求（1 起）悬挂不答，直到 /__control {release:true}，用于制造确定性的「在途」窗口。 */
    holdCall: 0,
    holdMs: 600_000,
    calls: 0,
    pending: [],
  };
  const log = (entry) => {
    appendFileSync(join(logDir, `${role.name}.jsonl`), `${JSON.stringify(entry)}\n`);
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const reply = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && url.pathname === "/__control") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (body.probeDim !== undefined) state.probeDim = body.probeDim;
        if (body.bodyDim !== undefined) state.bodyDim = body.bodyDim;
        if (body.delayMs !== undefined) state.delayMs = body.delayMs;
        if (body.expectedKey !== undefined) state.expectedKey = body.expectedKey;
        if (body.holdCall !== undefined) state.holdCall = body.holdCall;
        if (body.holdMs !== undefined) state.holdMs = body.holdMs;
        if (body.release) {
          const pending = state.pending.splice(0);
          log({ ts: new Date().toISOString(), service: role.name, kind: "release", held: pending.length });
          for (const done of pending) done();
        }
        log({ ts: new Date().toISOString(), service: role.name, kind: "control", ...body, expectedKeyLogged: body.expectedKey !== undefined });
        return reply(200, { ok: true, state: { probeDim: state.probeDim, bodyDim: state.bodyDim, delayMs: state.delayMs, holdCall: state.holdCall, expectedKeySet: state.expectedKey !== null, pending: state.pending.length } });
      }
      if (req.method === "GET" && url.pathname === "/__state") {
        return reply(200, { service: role.name, calls: state.calls, probeDim: state.probeDim, bodyDim: state.bodyDim, delayMs: state.delayMs, holdCall: state.holdCall, expectedKeySet: state.expectedKey !== null, pending: state.pending.length });
      }
      if (req.method !== "POST" || !url.pathname.endsWith("/embeddings")) {
        return reply(404, { error: "not found" });
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dim = inputs.length === 1 ? state.probeDim : state.bodyDim;
      state.calls += 1;
      const auth = String(req.headers.authorization ?? "");
      const entry = {
        ts: new Date().toISOString(),
        service: role.name,
        kind: "embeddings",
        model: body.model,
        n: inputs.length,
        dim,
        delayMs: state.delayMs,
        held: state.holdCall === state.calls,
        auth: {
          present: auth.length > 0,
          matchesExpected: state.expectedKey === null ? null : auth === `Bearer ${state.expectedKey}`,
        },
        inputs,
      };
      log(entry);
      const respond = () => reply(200, {
        data: inputs.map((text, index) => ({ index, embedding: conceptVector(text, dim, role.offset) })),
      });
      if (state.holdCall === state.calls) {
        state.pending.push(respond);
      } else if (state.delayMs > 0) {
        setTimeout(respond, state.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise((resolve) => server.listen(role.port, "127.0.0.1", resolve));
  console.log(`[stub] ${role.name} on http://127.0.0.1:${role.port}/v1 (dim=${role.dim})`);
}
console.log(`[stub] logs -> ${logDir}`);
