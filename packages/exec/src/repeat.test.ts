import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandRepeatHash,
  isRepeatExemptCommand,
  normalizeCommandForRepeat,
} from "./repeat.js";

test("normalization collapses whitespace but keeps argument case and order", () => {
  assert.equal(normalizeCommandForRepeat("  nmap   -sV  target  "), "nmap -sV target");
  assert.equal(normalizeCommandForRepeat("curl -d 'A=B' x;"), "curl -d 'A=B' x");
  assert.notEqual(
    commandRepeatHash("curl -d 'A=B' x"),
    commandRepeatHash("curl -d 'a=b' x"),
  );
  assert.notEqual(
    commandRepeatHash("nmap -sV host"),
    commandRepeatHash("nmap -sS host"),
  );
  assert.equal(
    commandRepeatHash("nmap  -sV   host"),
    commandRepeatHash("nmap -sV host"),
  );
});

test("read-only polling is exempt; exploitation retries are not", () => {
  assert.equal(isRepeatExemptCommand("sleep 5"), true);
  assert.equal(isRepeatExemptCommand("curl -s -o /dev/null -w '%{http_code}' http://x"), true);
  assert.equal(isRepeatExemptCommand("curl http://x/?id=1'"), false);
  assert.equal(isRepeatExemptCommand("nmap -sV host"), false);
  assert.equal(isRepeatExemptCommand("sqlmap -u http://x --batch"), false);
});
