import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applySessionToHeaders,
  httpSessionStorePath,
  listHttpSessionSummaries,
  loadHttpSessions,
  upsertHttpSession,
} from "./http-sessions.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gy-http-sessions-"));
}

test("legacy http-sessions.json loads as cookies and round-trips without headers", () => {
  const dir = tempDir();
  try {
    writeFileSync(httpSessionStorePath(dir), JSON.stringify({
      user: {
        "Example.COM": { sessionid: "legacy-secret", csrf: "legacy-csrf" },
      },
    }));
    const loaded = loadHttpSessions(dir);
    assert.deepEqual(loaded.user?.["example.com"]?.cookies, {
      sessionid: "legacy-secret",
      csrf: "legacy-csrf",
    });
    assert.deepEqual(loaded.user?.["example.com"]?.headers, {});

    upsertHttpSession(dir, {
      name: "user",
      host: "example.com",
      cookie: "extra=1",
    });
    const raw = JSON.parse(readFileSync(httpSessionStorePath(dir), "utf8")) as {
      user: { "example.com": Record<string, unknown> };
    };
    assert.equal(raw.user["example.com"]?.cookies, undefined);
    assert.equal(raw.user["example.com"]?.sessionid, "legacy-secret");
    assert.equal(raw.user["example.com"]?.extra, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored headers fill gaps and explicit headers or cookie names win", () => {
  const merged = applySessionToHeaders(
    { authorization: "caller-auth", Cookie: "sid=caller" },
    {
      cookies: { sid: "stored-sid", extra: "from-jar" },
      headers: { Authorization: "stored-auth", "X-CSRF-Token": "csrf-secret" },
    },
  );
  assert.equal(merged.authorization, "caller-auth");
  assert.equal(Object.values(merged).includes("stored-auth"), false);
  assert.equal(merged["X-CSRF-Token"], "csrf-secret");
  assert.match(merged.Cookie ?? "", /sid=caller/);
  assert.match(merged.Cookie ?? "", /extra=from-jar/);
  assert.doesNotMatch(merged.Cookie ?? "", /stored-sid/);
});

test("session material for one host is not applied to another", () => {
  const dir = tempDir();
  try {
    upsertHttpSession(dir, {
      name: "user",
      host: "a.example",
      cookies: { sid: "secret-a" },
      headers: { "X-From": "a" },
    });
    upsertHttpSession(dir, {
      name: "user",
      host: "b.example",
      cookies: { sid: "secret-b" },
      headers: { Authorization: "secret-b-header" },
    });
    const store = loadHttpSessions(dir);
    const applied = applySessionToHeaders({}, store.user?.["a.example"]);
    assert.match(applied.Cookie ?? "", /sid=secret-a/);
    assert.equal(applied["X-From"], "a");
    assert.equal(applied.Authorization, undefined);
    assert.doesNotMatch(JSON.stringify(applied), /secret-b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session summaries list key names only", () => {
  const dir = tempDir();
  const cookieSecret = "cookie-secret-value";
  const headerSecret = "header-secret-value";
  try {
    upsertHttpSession(dir, {
      name: "admin",
      host: "lab.example",
      cookie: `sid=${cookieSecret}`,
      headers: { Authorization: headerSecret, "X-CSRF-Token": "csrf" },
    });
    const listed = listHttpSessionSummaries(dir);
    assert.deepEqual(listed, [{
      name: "admin",
      host: "lab.example",
      cookieKeys: ["sid"],
      headerKeys: ["Authorization", "X-CSRF-Token"],
    }]);
    const encoded = JSON.stringify(listed);
    assert.equal(encoded.includes(cookieSecret), false);
    assert.equal(encoded.includes(headerSecret), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
