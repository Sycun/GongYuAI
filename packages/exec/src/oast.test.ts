import assert from "node:assert/strict";
import { test } from "node:test";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import {
  startOastListener,
  type OastCallbackHit,
  type OastListener,
  type OastListenerOptions,
} from "./oast.js";

/** onHit 在响应之后触发，测试统一等一小段再断言，避免读到旧计数。 */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startListener(
  overrides: Partial<OastListenerOptions> = {},
): Promise<{ listener: OastListener; hits: OastCallbackHit[] }> {
  const hits: OastCallbackHit[] = [];
  const listener = await startOastListener({
    listenHost: "127.0.0.1",
    listenPort: 0,
    publicBaseUrl: "http://10.0.0.9:8799",
    onHit: (hit) => {
      hits.push(hit);
      return true;
    },
    ...overrides,
  });
  return { listener, hits };
}

type HttpResult = { status: number; body: string; headers: IncomingHttpHeaders };

function httpRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

test("路径 /t/<token> 命中：200，token/来源/方法/原始 path/UA/protocol 都对", async () => {
  const { listener, hits } = await startListener();
  try {
    assert.ok(listener.port > 0);
    assert.equal(listener.boundUrl, `http://127.0.0.1:${listener.port}`);

    const token = "tok-path-0001";
    const res = await fetch(`${listener.boundUrl}/t/${token}?probe=1`, {
      headers: { "user-agent": "gy-oast-test/1.0" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    assert.equal(await res.text(), "");
    await settle();

    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.token, token);
    assert.equal(hit.sourceIp, "127.0.0.1");
    assert.equal(hit.method, "GET");
    assert.equal(hit.path, `/t/${token}?probe=1`);
    assert.equal(hit.userAgent, "gy-oast-test/1.0");
    assert.equal(hit.protocol, "http");
    assert.equal(new Date(hit.at).toISOString(), hit.at);
  } finally {
    await listener.close();
  }
});

test("query 形式 ?t=<token> 同样命中", async () => {
  const { listener, hits } = await startListener();
  try {
    const token = "tok-query-0002";
    const res = await fetch(`${listener.boundUrl}/collect?x=1&t=${token}`);
    assert.equal(res.status, 200);
    await settle();

    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.token, token);
    assert.equal(hits[0]!.path, `/collect?x=1&t=${token}`);
  } finally {
    await listener.close();
  }
});

test("取不到 token 的请求一律 400，且不调用 onHit", async () => {
  let calls = 0;
  const { listener } = await startListener({
    onHit: () => {
      calls += 1;
      return true;
    },
  });
  try {
    for (const path of ["/", "/collect", "/t", "/t/", "/?t=", "/?x=1"]) {
      const res = await fetch(`${listener.boundUrl}${path}`);
      assert.equal(res.status, 400, `path=${path}`);
    }
    await settle();
    assert.equal(calls, 0);
  } finally {
    await listener.close();
  }
});

test("两次命中计数为 2", async () => {
  const { listener, hits } = await startListener();
  try {
    const first = "tok-two-0003";
    const second = "tok-two-0004";
    const res1 = await fetch(`${listener.boundUrl}/t/${first}`);
    const res2 = await fetch(`${listener.boundUrl}/collect?t=${second}`, { method: "POST", body: "a=1" });
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    await settle();

    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((hit) => hit.token).sort(), [first, second].sort());
    assert.equal(hits[1]!.method, "POST");
  } finally {
    await listener.close();
  }
});

test("任意方法（POST/PUT）都接受，请求体在限额内被 drain", async () => {
  const { listener, hits } = await startListener();
  try {
    const token = "tok-method-0005";
    const post = await fetch(`${listener.boundUrl}/t/${token}`, { method: "POST", body: "p".repeat(1024) });
    const put = await fetch(`${listener.boundUrl}/t/${token}`, { method: "PUT", body: "q".repeat(1024) });
    assert.equal(post.status, 200);
    assert.equal(put.status, 200);
    await settle();

    assert.deepEqual(hits.map((hit) => hit.method), ["POST", "PUT"]);
  } finally {
    await listener.close();
  }
});

test("Host 头 <token>.<dnsName> 兜底命中；段数或首段长度不足则不命中", async () => {
  const { listener, hits } = await startListener();
  try {
    const token = "hosttoken001";
    const viaHost = await httpRequest(`${listener.boundUrl}/`, {
      headers: { host: `${token}.oast.example.test` },
    });
    assert.equal(viaHost.status, 200);
    await settle();

    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.token, token);
    assert.equal(hits[0]!.path, "/");
    assert.equal(hits[0]!.protocol, "http");

    const twoLabels = await httpRequest(`${listener.boundUrl}/`, { headers: { host: `${token}.test` } });
    assert.equal(twoLabels.status, 400);
    const shortLabel = await httpRequest(`${listener.boundUrl}/`, {
      headers: { host: "short.oast.example.test" },
    });
    assert.equal(shortLabel.status, 400);
    await settle();
    assert.equal(hits.length, 1);
  } finally {
    await listener.close();
  }
});

test("x-forwarded-for 优先作 sourceIp，否则用 socket 远端地址", async () => {
  const { listener, hits } = await startListener();
  try {
    const token = "tok-xff-0006";
    await fetch(`${listener.boundUrl}/t/${token}`, {
      headers: { "x-forwarded-for": "203.0.113.9, 10.1.2.3" },
    });
    await fetch(`${listener.boundUrl}/t/${token}`);
    await settle();

    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.sourceIp, "203.0.113.9");
    assert.equal(hits[1]!.sourceIp, "127.0.0.1");
  } finally {
    await listener.close();
  }
});

test("请求体超过 maxBodyBytes 直接断链，不记 hit", async () => {
  const { listener, hits } = await startListener({ maxBodyBytes: 64 });
  try {
    const token = "tok-big-0007";
    await assert.rejects(
      httpRequest(`${listener.boundUrl}/t/${token}`, { method: "POST", body: "z".repeat(4096) }),
    );
    await settle();
    assert.equal(hits.length, 0);
  } finally {
    await listener.close();
  }
});

test("close() 幂等，关闭后连接被拒（不产生未处理异常）", async () => {
  const { listener } = await startListener();
  const token = "tok-close-0008";
  const res = await fetch(`${listener.boundUrl}/t/${token}`);
  assert.equal(res.status, 200);
  await res.text();

  const closing = listener.close();
  assert.equal(listener.close(), closing);
  await closing;
  await listener.close();

  await assert.rejects(httpRequest(`${listener.boundUrl}/t/${token}`), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNREFUSED");
    return true;
  });
});

test("close() 对挂起连接最多等 1s，强拆后 resolve", async () => {
  const { listener } = await startListener();
  const socket = connect(listener.port, "127.0.0.1");
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    // 只有请求行 + 一个 header，headers 未结束：服务端不会产生 request，连接一直挂着。
    socket.write("GET /t/tok-hang-0009 HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    await settle(100);

    const startedAt = Date.now();
    await listener.close();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 900, `close 提前返回：${elapsed}ms`);
    assert.ok(elapsed < 5_000, `close 超时：${elapsed}ms`);
  } finally {
    socket.destroy();
    await listener.close();
  }
});

test("publicBaseUrl 带尾斜杠时 callbackUrl 不出现双斜杠", async () => {
  const { listener } = await startListener({ publicBaseUrl: "http://10.0.0.9:8799/" });
  try {
    assert.equal(listener.callbackUrl("tok-callback-01"), "http://10.0.0.9:8799/t/tok-callback-01");
  } finally {
    await listener.close();
  }
});

test("端口被占用时 startOastListener reject，错误可读且带 code", async () => {
  const { listener } = await startListener();
  try {
    await assert.rejects(
      startOastListener({
        listenHost: "127.0.0.1",
        listenPort: listener.port,
        publicBaseUrl: "http://10.0.0.9:8799",
        onHit: () => true,
      }),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
        assert.match((error as Error).message, /EADDRINUSE/);
        assert.match((error as Error).message, new RegExp(String(listener.port)));
        return true;
      },
    );
  } finally {
    await listener.close();
  }
});
