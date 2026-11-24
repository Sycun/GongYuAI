import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDsmlMarkup, parseDsmlCalls } from "./dsml.js";

const SAMPLE = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="command">
<｜｜DSML｜｜ parameter name="command" string="true">curl -s -m 15 http://10.0.100.58</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="purpose" string="true">VPN 联通预检：确认靶场 VPN 已连通</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

test("parses deepseek dsml invoke block into a command call", () => {
  assert.equal(hasDsmlMarkup(SAMPLE), true);
  assert.deepEqual(parseDsmlCalls(SAMPLE), [
    {
      name: "command",
      args: { command: "curl -s -m 15 http://10.0.100.58", purpose: "VPN 联通预检：确认靶场 VPN 已连通" },
    },
  ]);
});

test("plain text and empty markup yield no calls", () => {
  assert.equal(hasDsmlMarkup("hello"), false);
  assert.deepEqual(parseDsmlCalls("hello"), []);
  assert.deepEqual(parseDsmlCalls("<｜｜DSML｜｜ calls></｜｜DSML｜｜ calls>"), []);
});

test("multiple invokes are all surfaced for the caller to reject", () => {
  const two = `${SAMPLE}\n<｜｜DSML｜｜ invoke name="needs_input"><｜｜DSML｜｜ parameter name="reason" string="true">缺坐标</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>`;
  assert.equal(parseDsmlCalls(two).length, 2);
});