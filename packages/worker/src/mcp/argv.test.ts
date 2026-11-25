import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMcpArgv, normalizeArgList } from "./builtin/from-manifest.js";

test("MCP argv keeps subcommands first and uses an explicit target flag", () => {
  assert.deepEqual(
    buildMcpArgv({ flags: "-mc 200 -of json -o /dev/stdout", targetFlag: "-u", target: "http://x", extraArgs: "" }),
    ["-mc", "200", "-of", "json", "-o", "/dev/stdout", "-u", "http://x"],
  );
  assert.deepEqual(
    buildMcpArgv({ flags: "dir", targetFlag: "-u", target: "http://x", extraArgs: "" }),
    ["dir", "-u", "http://x"],
  );
  assert.deepEqual(
    buildMcpArgv({ flags: "", targetFlag: "--url", target: "http://x", extraArgs: "--enumerate" }),
    ["--url", "http://x", "--enumerate"],
  );
  assert.deepEqual(
    buildMcpArgv({ flags: "-sV -oX -", targetFlag: "", target: "127.0.0.1", extraArgs: "" }),
    ["-sV", "-oX", "-", "127.0.0.1"],
  );
});

test("MCP argv normalizes JSON array flags and extraArgs without comma-joining", () => {
  assert.deepEqual(
    buildMcpArgv({
      flags: ["-p-", "-T4", "--min-rate", "2000", "-oX", "-"],
      targetFlag: "",
      target: "10.0.188.64",
      extraArgs: ["--host-timeout", "180s"],
    }),
    ["-p-", "-T4", "--min-rate", "2000", "-oX", "-", "10.0.188.64", "--host-timeout", "180s"],
  );
  assert.deepEqual(normalizeArgList(["-json -silent", "-title"]), ["-json", "-silent", "-title"]);
  assert.deepEqual(normalizeArgList(undefined), []);
});
