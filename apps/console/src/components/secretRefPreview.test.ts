import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isEnvVarRef,
  isMarkdownPath,
  resolveSecretRefTarget,
} from "./secretRefPreview";

test("isEnvVarRef identifies env pointers without false-matching evidence paths", () => {
  assert.equal(isEnvVarRef("PASSWORD"), true);
  assert.equal(isEnvVarRef("GY_FIXTURE_TOKEN"), true);
  assert.equal(isEnvVarRef("env:GY_FIXTURE_TOKEN"), true);
  assert.equal(isEnvVarRef("$ADMIN_PASS"), true);
  assert.equal(isEnvVarRef("evidence/c07/telnet_root_session_clean.txt"), false);
  assert.equal(isEnvVarRef("credentials/admin.txt"), false);
});

test("resolveSecretRefTarget normalizes evidence, workspace, line anchors, and http refs", () => {
  assert.deepEqual(
    resolveSecretRefTarget("evidence/c07/telnet_root_session_clean.txt"),
    {
      kind: "file",
      paths: [
        "c07/telnet_root_session_clean.txt",
        "evidence/c07/telnet_root_session_clean.txt",
      ],
    },
  );

  assert.deepEqual(
    resolveSecretRefTarget("workspace/evidence/d06/repro-chain.log"),
    {
      kind: "file",
      paths: [
        "d06/repro-chain.log",
        "evidence/d06/repro-chain.log",
        "workspace/evidence/d06/repro-chain.log",
      ],
    },
  );

  assert.deepEqual(
    resolveSecretRefTarget("`./evidence/a05/a05-hardcoded-credentials.md#L12-L20`"),
    {
      kind: "file",
      paths: [
        "a05/a05-hardcoded-credentials.md#L12-L20",
        "evidence/a05/a05-hardcoded-credentials.md#L12-L20",
        "a05/a05-hardcoded-credentials.md",
        "evidence/a05/a05-hardcoded-credentials.md",
      ],
    },
  );

  assert.deepEqual(
    resolveSecretRefTarget("http:77777777-7777-4777-8777-777777777777"),
    { kind: "http", trafficId: "77777777-7777-4777-8777-777777777777" },
  );

  assert.deepEqual(resolveSecretRefTarget("env:GY_TOKEN"), { kind: "none" });
  assert.deepEqual(resolveSecretRefTarget("PASSWORD"), { kind: "none" });
  assert.deepEqual(resolveSecretRefTarget("../etc/passwd"), { kind: "none" });
});

test("isMarkdownPath detects markdown files", () => {
  assert.equal(isMarkdownPath("evidence/a05/a05-hardcoded-credentials.md"), true);
  assert.equal(isMarkdownPath("notes.MARKDOWN"), true);
  assert.equal(isMarkdownPath("evidence/d06/repro-chain.log"), false);
});
