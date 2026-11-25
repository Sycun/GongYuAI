import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  redactModelToolResult,
  redactOutboundChatMessages,
  redactOutboundText,
} from "./outbound-redact.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const GHP = `ghp_${"a".repeat(36)}`;
const PAT = `github_pat_${"b".repeat(22)}`;
const API = `sk-${"c".repeat(20)}`;
const PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIPRIVATE",
  "-----END PRIVATE KEY-----",
].join("\n");

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 6);
}

test("high-confidence secrets become stable placeholders", () => {
  const bearer = `Authorization: Bearer ${API}`;
  const input = `aws ${AWS} github ${GHP} pat ${PAT}\n${bearer}\n${PEM}\nkeep sk-short and AKIA123`;
  const redacted = redactOutboundText(input, { enabled: true });
  assert.equal(redacted.includes(AWS), false);
  assert.equal(redacted.includes(GHP), false);
  assert.equal(redacted.includes(PAT), false);
  assert.equal(redacted.includes(API), false);
  assert.equal(redacted.includes("MIIPRIVATE"), false);
  assert.match(redacted, new RegExp(`\\[REDACTED:AWS#${digest(AWS)}\\]`));
  assert.match(redacted, new RegExp(`\\[REDACTED:GITHUB#${digest(GHP)}\\]`));
  assert.match(redacted, new RegExp(`\\[REDACTED:GITHUB#${digest(PAT)}\\]`));
  assert.match(redacted, new RegExp(`\\[REDACTED:BEARER#${digest(bearer)}\\]`));
  assert.match(redacted, new RegExp(`\\[REDACTED:PEM#${digest(PEM)}\\]`));
  assert.match(redacted, /sk-short/);
  assert.match(redacted, /AKIA123/);
  assert.equal(redactOutboundText(redacted), redacted);
  assert.equal(redactOutboundText(`${AWS} ${AWS}`, { enabled: true }).split(digest(AWS)).length, 3);
});

test("redaction can be turned off and does not mutate evidence files or the source message", () => {
  const previous = process.env.GY_OUTBOUND_REDACT;
  delete process.env.GY_OUTBOUND_REDACT;
  const root = mkdtempSync(join(tmpdir(), "gy-redact-"));
  const evidence = join(root, "evidence", "note.txt");
  mkdirSync(join(root, "evidence"), { recursive: true });
  writeFileSync(evidence, `token ${AWS}`);
  const messages = [{ role: "tool" as const, content: `token ${AWS}`, tool_call_id: "1" }];
  try {
    const copy = redactOutboundText(readFileSync(evidence, "utf8"));
    assert.notEqual(copy, `token ${AWS}`);
    assert.equal(readFileSync(evidence, "utf8"), `token ${AWS}`);

    const redactedMessages = redactOutboundChatMessages(messages);
    assert.equal(messages[0]!.content, `token ${AWS}`);
    assert.notEqual(redactedMessages[0]!.content, messages[0]!.content);

    const tool = redactModelToolResult({
      details: { shellResult: AWS },
      output: [{ type: "text", text: AWS }],
    });
    assert.equal(tool.details.shellResult, AWS);
    assert.notEqual(tool.output[0]!.text, AWS);

    assert.equal(redactOutboundText(AWS, { enabled: false }), AWS);
    process.env.GY_OUTBOUND_REDACT = "off";
    assert.equal(redactOutboundText(AWS), AWS);
  } finally {
    if (previous === undefined) delete process.env.GY_OUTBOUND_REDACT;
    else process.env.GY_OUTBOUND_REDACT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
