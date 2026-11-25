import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_BROWSER_USER_AGENT, performHttpRequest, type HttpRequestOptions } from "./http.js";

/** 只放行实验本机；任何外域（如 other.invalid）都被拒。 */
const allowLocal: HttpRequestOptions["authorizeHost"] = (host) =>
  host === "127.0.0.1" ? { allowed: true } : { allowed: false, reason: "outside test scope" };

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fileBody(serialized: string): string {
  const split = serialized.indexOf("\n\n");
  return split < 0 ? "" : serialized.slice(split + 2);
}

function tempEvidence(): string {
  return mkdtempSync(join(tmpdir(), "gy-http-"));
}

type Lab = {
  base: string;
  requests: string[];
  close: () => Promise<void>;
};

/**
 * 本地 fixture：日期头关掉（否则同一请求跨秒时响应 sha 不稳定），
 * 默认 chunked 响应头在两次调用间是稳定的。
 */
async function startLab(): Promise<Lab> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    res.sendDate = false;
    requests.push(`${req.method ?? "?"} ${req.url ?? "/"}`);
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    switch (pathname) {
      case "/hello":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-lab": "yes" });
        res.end("hello world");
        break;
      case "/start":
        res.writeHead(302, { location: "/next" });
        res.end("go");
        break;
      case "/next":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("redirected");
        break;
      case "/outside":
        res.writeHead(302, { location: "http://other.invalid/" });
        res.end("offsite");
        break;
      case "/missing":
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        break;
      case "/large":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("x".repeat(20 * 1024));
        break;
      case "/unicode":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("A" + "😀".repeat(40));
        break;
      default:
        res.writeHead(404);
        res.end("unknown");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function withLab<T>(fn: (lab: Lab) => Promise<T>): Promise<T> {
  const lab = await startLab();
  try {
    return await fn(lab);
  } finally {
    await lab.close();
  }
}

test("200：bodyHead、请求/响应 sha 落盘一致、path 归一化", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact, headers, bodyHead } = await performHttpRequest(
        { url: `${lab.base}/a/../hello?q=1#frag` },
        { evidenceDir: dir, authorizeHost: allowLocal },
      );

      assert.equal(artifact.status, 200);
      assert.equal(artifact.method, "GET");
      assert.equal(artifact.host, "127.0.0.1");
      assert.equal(artifact.path, "/hello?q=1");
      assert.equal(artifact.url, `${lab.base}/hello?q=1`);
      assert.equal(bodyHead, "hello world");
      assert.equal(artifact.responseHead, "hello world");
      assert.equal(artifact.truncated, false);
      assert.equal(artifact.redirects.length, 0);
      assert.equal(artifact.error, undefined);
      assert.equal(artifact.blockedRedirect, undefined);
      assert.ok(!Number.isNaN(Date.parse(artifact.startedAt)));
      assert.ok(artifact.durationMs >= 0);

      // 返回的 header 全部小写。
      assert.equal(headers["x-lab"], "yes");
      assert.ok(Object.keys(headers).every((name) => name === name.toLowerCase()));

      const requestText = readFileSync(join(dir, artifact.requestPath), "utf8");
      const responseText = readFileSync(join(dir, artifact.responsePath), "utf8");
      assert.equal(sha(requestText), artifact.requestSha256);
      assert.equal(sha(responseText), artifact.responseSha256);
      assert.equal(Buffer.byteLength(requestText, "utf8"), artifact.requestBytes);
      assert.equal(Buffer.byteLength(responseText, "utf8"), artifact.responseBytes);
      assert.ok(requestText.startsWith(`GET ${lab.base}/hello?q=1\n`), requestText.slice(0, 80));
      assert.ok(responseText.startsWith("HTTP/1.1 200\n"), responseText.slice(0, 80));
      assert.match(responseText, /\nx-lab: yes\n/);
      assert.equal(fileBody(responseText), "hello world");

      // 落盘权限 0o600。
      assert.equal(statSync(join(dir, artifact.requestPath)).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, artifact.responsePath)).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("302 同主机：逐跳授权、redirects 记录、最终 200", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    const authorizedHosts: string[] = [];
    try {
      const { artifact, bodyHead } = await performHttpRequest(
        { url: `${lab.base}/start` },
        {
          evidenceDir: dir,
          authorizeHost: (host) => {
            authorizedHosts.push(host);
            return allowLocal(host);
          },
        },
      );

      assert.equal(artifact.status, 200);
      assert.equal(bodyHead, "redirected");
      assert.equal(artifact.responseHead, "redirected");
      assert.deepEqual(artifact.redirects, [`${lab.base}/next`]);
      // 始发 host + 跳转目标 host 都过了授权闸。
      assert.deepEqual(authorizedHosts, ["127.0.0.1", "127.0.0.1"]);
      // artifact 记录始发请求；响应是终结响应。
      assert.equal(artifact.url, `${lab.base}/start`);
      assert.equal(artifact.path, "/start");
      assert.equal(artifact.blockedRedirect, undefined);
      assert.deepEqual(lab.requests, ["GET /start", "GET /next"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("302 → 外域：停止、记录 blockedRedirect、状态仍为 302、不请求 other.invalid", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const { artifact, headers } = await performHttpRequest(
        { url: `${lab.base}/outside` },
        { evidenceDir: dir, authorizeHost: allowLocal },
      );

      assert.equal(artifact.status, 302);
      assert.equal(artifact.blockedRedirect, "other.invalid");
      assert.deepEqual(artifact.redirects, []);
      assert.equal(artifact.error, undefined);
      assert.equal(headers["location"], "http://other.invalid/");
      // 只发生了一次网络请求，且目标从不是 other.invalid。
      assert.equal(calls.length, 1);
      assert.ok(calls.every((call) => !call.includes("other.invalid")), calls.join(", "));
      assert.deepEqual(lab.requests, ["GET /outside"]);

      const responseText = readFileSync(join(dir, artifact.responsePath), "utf8");
      assert.ok(responseText.startsWith("HTTP/1.1 302\n"));
      assert.equal(fileBody(responseText), "offsite");
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("404 正常返回，不当作错误", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact, bodyHead } = await performHttpRequest(
        { url: `${lab.base}/missing` },
        { evidenceDir: dir, authorizeHost: allowLocal },
      );
      assert.equal(artifact.status, 404);
      assert.equal(bodyHead, "not found");
      assert.equal(artifact.truncated, false);
      assert.equal(artifact.error, undefined);
      assert.equal(artifact.blockedRedirect, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("相同请求两次：sha 相同且不重复写文件", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const opts: HttpRequestOptions = { evidenceDir: dir, authorizeHost: allowLocal };
      const payload = { url: `${lab.base}/hello`, headers: { "X-Trace": "same" } };

      const first = await performHttpRequest(payload, opts);
      const requestFile = join(dir, first.artifact.requestPath);
      const responseFile = join(dir, first.artifact.responsePath);
      const requestMtime = statSync(requestFile).mtimeMs;
      const responseMtime = statSync(responseFile).mtimeMs;

      await delay(20);
      const second = await performHttpRequest(payload, opts);

      assert.equal(second.artifact.requestSha256, first.artifact.requestSha256);
      assert.equal(second.artifact.responseSha256, first.artifact.responseSha256);
      // 已存在即跳过写入：mtime 不变。
      assert.equal(statSync(requestFile).mtimeMs, requestMtime);
      assert.equal(statSync(responseFile).mtimeMs, responseMtime);

      const names = readdirSync(join(dir, "http"));
      assert.equal(names.filter((name) => name.endsWith(".req.txt")).length, 1);
      assert.equal(names.filter((name) => name.endsWith(".res.txt")).length, 1);
      assert.deepEqual(lab.requests, ["GET /hello", "GET /hello"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("网络错误（端口关闭）：status 0 + error 非空，不抛", async () => {
  const lab = await startLab();
  const port = new URL(lab.base).port;
  await lab.close();
  const dir = tempEvidence();
  try {
    const { artifact, headers, bodyHead } = await performHttpRequest(
      { url: `http://127.0.0.1:${port}/closed`, timeoutMs: 3_000 },
      { evidenceDir: dir, authorizeHost: allowLocal },
    );

    assert.equal(artifact.status, 0);
    assert.ok(artifact.error && artifact.error.length > 0, "error 应非空");
    assert.equal(artifact.blockedRedirect, undefined);
    assert.deepEqual(headers, {});
    assert.equal(bodyHead, "");
    assert.equal(artifact.truncated, false);

    const requestText = readFileSync(join(dir, artifact.requestPath), "utf8");
    const responseText = readFileSync(join(dir, artifact.responsePath), "utf8");
    assert.equal(sha(requestText), artifact.requestSha256);
    assert.equal(sha(responseText), artifact.responseSha256);
    assert.equal(responseText, "HTTP/1.1 0\n\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("响应体超 maxResponseBytes：截断、不劈开 UTF-8 字符、truncated=true", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact, bodyHead } = await performHttpRequest(
        { url: `${lab.base}/unicode` },
        { evidenceDir: dir, authorizeHost: allowLocal, maxResponseBytes: 10 },
      );

      assert.equal(artifact.truncated, true);
      const responseText = readFileSync(join(dir, artifact.responsePath), "utf8");
      const body = fileBody(responseText);
      assert.equal(body, "A😀😀");
      assert.equal(Buffer.byteLength(body, "utf8"), 9);
      assert.ok(!body.includes("\uFFFD"));
      assert.ok(Buffer.byteLength(body, "utf8") <= 10);
      assert.equal(bodyHead, body);
      // sha 与落盘内容一致。
      assert.equal(sha(responseText), artifact.responseSha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("responseHead 最多 16 KiB，文件保留完整 body", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact } = await performHttpRequest(
        { url: `${lab.base}/large` },
        { evidenceDir: dir, authorizeHost: allowLocal },
      );

      assert.equal(artifact.truncated, false);
      assert.equal(Buffer.byteLength(artifact.responseHead, "utf8"), 16 * 1024);
      const responseText = readFileSync(join(dir, artifact.responsePath), "utf8");
      assert.equal(Buffer.byteLength(fileBody(responseText), "utf8"), 20 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("follow:false 直接返回 3xx，不跟随", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact, headers } = await performHttpRequest(
        { url: `${lab.base}/start`, follow: false },
        { evidenceDir: dir, authorizeHost: allowLocal },
      );

      assert.equal(artifact.status, 302);
      assert.deepEqual(artifact.redirects, []);
      assert.equal(headers["location"], "/next");
      assert.equal(artifact.url, `${lab.base}/start`);
      assert.deepEqual(lab.requests, ["GET /start"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("始发 host 被拒：不发起网络请求、status 0、blockedRedirect 记录", async () => {
  await withLab(async (lab) => {
    const dir = tempEvidence();
    try {
      const { artifact } = await performHttpRequest(
        { url: `${lab.base}/hello` },
        {
          evidenceDir: dir,
          authorizeHost: () => ({ allowed: false, reason: "initial host outside scope" }),
        },
      );

      assert.equal(artifact.status, 0);
      assert.equal(artifact.blockedRedirect, "127.0.0.1");
      assert.match(artifact.error ?? "", /blocked.*authorizeHost/);
      assert.deepEqual(artifact.redirects, []);
      assert.deepEqual(lab.requests, []);
      assert.equal(readFileSync(join(dir, artifact.responsePath), "utf8"), "HTTP/1.1 0\n\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("未传 User-Agent 时使用浏览器默认值，显式头优先于选项与环境变量", async () => {
  const previous = process.env.GY_HTTP_USER_AGENT;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers["user-agent"] ?? ""));
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const dir = tempEvidence();
  const url = `http://127.0.0.1:${address.port}/ua`;
  try {
    delete process.env.GY_HTTP_USER_AGENT;
    const first = await performHttpRequest(
      { url },
      { evidenceDir: dir, authorizeHost: allowLocal },
    );
    assert.equal(seen.at(-1), DEFAULT_BROWSER_USER_AGENT);
    const requestText = readFileSync(join(dir, first.artifact.requestPath), "utf8");
    assert.ok(requestText.includes(`User-Agent: ${DEFAULT_BROWSER_USER_AGENT}`));

    await performHttpRequest(
      { url, headers: { "User-Agent": "CustomAgent/1" } },
      { evidenceDir: dir, authorizeHost: allowLocal, userAgent: "OptAgent/3" },
    );
    assert.equal(seen.at(-1), "CustomAgent/1");

    process.env.GY_HTTP_USER_AGENT = "EnvAgent/2";
    await performHttpRequest(
      { url },
      { evidenceDir: dir, authorizeHost: allowLocal },
    );
    assert.equal(seen.at(-1), "EnvAgent/2");

    await performHttpRequest(
      { url },
      { evidenceDir: dir, authorizeHost: allowLocal, userAgent: "OptAgent/3" },
    );
    assert.equal(seen.at(-1), "OptAgent/3");
  } finally {
    if (previous === undefined) delete process.env.GY_HTTP_USER_AGENT;
    else process.env.GY_HTTP_USER_AGENT = previous;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
