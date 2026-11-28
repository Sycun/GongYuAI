import assert from "node:assert/strict";
import test from "node:test";
import { api, probe } from "./api";
import { submitAssignment } from "./chat/transport";

type MockReply = {
  status?: number;
  body?: string;
  throwErr?: unknown;
};

async function withMockFetch(
  handler: (url: string, init?: RequestInit) => MockReply | Promise<MockReply>,
  fn: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = await handler(url, init);
    if (reply.throwErr) throw reply.throwErr;
    return new Response(reply.body ?? "", { status: reply.status ?? 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("probe classifies 200, 404, 401/403, 500, and aborted signals accurately", async () => {
  await withMockFetch(
    (url) => {
      if (url === "/ok") return { status: 200, body: JSON.stringify({ ready: true }) };
      if (url === "/missing") return { status: 404, body: JSON.stringify({ error: "not registered" }) };
      if (url === "/denied") return { status: 403, body: JSON.stringify({ message: "scope denied" }) };
      if (url === "/boom") return { status: 502, body: "bad gateway" };
      return { throwErr: new Error("socket hang up") };
    },
    async () => {
      const ok = await probe<{ ready: boolean }>("/ok");
      assert.equal(ok.ok, true);
      if (ok.ok) assert.equal(ok.json.ready, true);

      const miss = await probe("/missing");
      assert.deepEqual(miss, { ok: false, status: 404, error: "not registered", kind: "unregistered" });

      const denied = await probe("/denied");
      assert.deepEqual(denied, { ok: false, status: 403, error: "scope denied", kind: "forbidden" });

      const boom = await probe("/boom");
      assert.deepEqual(boom, { ok: false, status: 502, error: "bad gateway", kind: "failed" });

      const ac = new AbortController();
      ac.abort();
      const aborted = await probe("/aborted", ac.signal);
      assert.equal(aborted.ok, false);
      if (!aborted.ok) assert.equal(aborted.kind, "aborted");
    },
  );
});

test("api client encodes query parameters, prioritizes taskId for knowledge scope, and surfaces HTTP errors", async () => {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  await withMockFetch(
    (url, init) => {
      seen.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url === "/tasks/fail") {
        return { status: 400, body: JSON.stringify({ error: "invalid scope" }) };
      }
      if (url === "/tasks/submit") {
        return { status: 422, body: JSON.stringify({ error: "目标不能为空" }) };
      }
      return { status: 200, body: JSON.stringify({ ok: true, traffic: [] }) };
    },
    async () => {
      await api.traffic("task/1", { host: "app.test", status: 200, offset: 0, path: "" });
      await api.evidenceFile("t1", "dir/a b.txt", { fallbackWorkspace: true });
      await api.validateRun("t1", "f-1", true);
      await api.knowledgeSearch({ taskId: "t-anchor", engagementId: "eng-ignored" }, "sql 注入", "hybrid");
      await api.knowledgeSummary({ engagementId: "eng-only" });

      assert.equal(seen[0]?.url, "/tasks/task%2F1/traffic?host=app.test&status=200&offset=0");
      assert.equal(seen[1]?.url, "/tasks/t1/evidence/file?path=dir%2Fa%20b.txt&fallbackWorkspace=1");
      assert.equal(seen[2]?.url, "/tasks/t1/findings/f-1/validate-run");
      assert.deepEqual(JSON.parse(seen[2]?.body ?? "{}"), { findingId: "f-1", force: true });
      // taskId takes priority over engagementId to prevent 409 scope mismatch
      assert.equal(seen[3]?.url, "/knowledge/search?q=sql+%E6%B3%A8%E5%85%A5&mode=hybrid&taskId=t-anchor");
      assert.equal(seen[4]?.url, "/knowledge/summary?engagementId=eng-only");

      await assert.rejects(() => api.task("fail"), /invalid scope/);
      await assert.rejects(
        () =>
          submitAssignment(
            "req-1",
            [],
            { profileId: "default", modelId: "gpt-4o" } as never,
            new AbortController().signal,
          ),
        /目标不能为空/,
      );
    },
  );
});
