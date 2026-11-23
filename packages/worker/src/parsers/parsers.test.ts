import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolOutput,
  type ParsedAsset,
  type SupportedTool,
} from "./index.js";

// ---------------------------------------------------------------------------
// Inline fixtures
// ---------------------------------------------------------------------------

const NMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="nmap -oX - -p 22,80,443,8443 10.0.0.5 10.0.0.6" version="7.94">
  <host>
    <status state="up" reason="syn-ack"/>
    <address addr="10.0.0.5" addrtype="ipv4"/>
    <hostnames>
      <hostname name="WWW.Example.COM." type="user"/>
      <hostname name="www.example.com" type="PTR"/>
    </hostnames>
    <ports>
      <extraports state="closed" count="997"/>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack"/>
        <service name="ssh" product="OpenSSH" version="9.6"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open" reason="syn-ack"/>
        <service name="http" product="nginx" version="1.25"/>
      </port>
      <port protocol="tcp" portid="443">
        <state state="closed" reason="reset"/>
        <service name="https"/>
      </port>
    </ports>
  </host>
  <host>
    <status state="up"/>
    <address addr="10.0.0.6" addrtype="ipv4"/>
    <hostnames>
      <hostname name="api.example.com" type="user"/>
    </hostnames>
    <ports>
      <port protocol="tcp" portid="8443">
        <state state="open"/>
        <service name="https-alt" product="Caddy" version="2.7"/>
      </port>
      <port protocol="tcp" portid="8080">
        <state state="open|filtered"/>
        <service name="http-proxy"/>
      </port>
    </ports>
  </host>
</nmaprun>`;

const HTTPX_JSONL = `{"url":"https://App.Example.com/login?next=%2Fhome#section","host":"App.Example.com:443","status_code":200,"tech":["Nginx","React"],"title":"Login","webserver":"nginx"}
{"url":"http://api.example.com:8080/v1/users?id=42","host":"api.example.com:8080","status_code":302,"tech":["Express"],"title":"","webserver":"Express"}`;

const NUCLEI_JSONL = `{"template-id":"tech-detect","info":{"name":"Nginx Detection","severity":"info"},"host":"https://app.example.com","matched-at":"https://app.example.com/login","type":"http"}
{"template-id":"cve-2024-0001","info":{"name":"Example RCE","severity":"warning"},"host":"https://api.example.com:443","matched-at":"https://api.example.com:443/v1/users?id=42","type":"http"}`;

const FFUF_JSON = `{
  "commandline": "ffuf -u https://app.example.com/FUZZ -w words.txt -of json",
  "results": [
    {
      "input": {"FUZZ": "admin"},
      "status": 200,
      "length": 1234,
      "words": 56,
      "lines": 7,
      "url": "https://app.example.com/admin"
    },
    {
      "input": {"FUZZ": "missing"},
      "status": 404,
      "length": 0,
      "words": 1,
      "lines": 1,
      "url": "https://app.example.com/missing"
    }
  ]
}`;

function findByPort(
  assets: ParsedAsset[],
  address: string,
  port: number,
): ParsedAsset | undefined {
  return assets.find(
    (asset) =>
      asset.address === address &&
      asset.kind === "service" &&
      asset.attrs.port === port,
  );
}

// ---------------------------------------------------------------------------
// nmap
// ---------------------------------------------------------------------------

test("nmap parses open services and hostnames, ignoring non-open states", () => {
  const out = parseToolOutput("nmap", NMAP_XML);

  assert.equal(out.skipped, false);
  assert.equal(out.reason, undefined);
  assert.equal(out.findings.length, 0);
  assert.equal(out.assets.length, 5);
  assert.equal(out.assets.filter((asset) => asset.kind === "service").length, 3);
  assert.equal(out.assets.filter((asset) => asset.kind === "domain").length, 2);
  assert.equal(out.assets.filter((asset) => asset.kind === "ip").length, 0);

  const ssh = findByPort(out.assets, "10.0.0.5", 22);
  assert.ok(ssh);
  assert.equal(ssh.kind, "service");
  assert.equal(ssh.parent, "10.0.0.5");
  assert.deepEqual(ssh.attrs, { port: 22, protocol: "ssh" });

  const alternateHttps = findByPort(out.assets, "10.0.0.6", 8443);
  assert.ok(alternateHttps);
  assert.equal(alternateHttps.parent, "10.0.0.6");
  assert.deepEqual(alternateHttps.attrs, {
    port: 8443,
    protocol: "https-alt",
  });

  const domain = out.assets.find(
    (asset) =>
      asset.kind === "domain" && asset.address === "www.example.com",
  );
  assert.ok(domain);
  assert.equal(domain.parent, "10.0.0.5");
  assert.deepEqual(domain.attrs, {});

  // Duplicate hostnames on one host collapse; closed and open|filtered ports
  // never become assets.
  assert.equal(
    out.assets.filter(
      (asset) =>
        asset.kind === "domain" && asset.address === "www.example.com",
    ).length,
    1,
  );
  assert.equal(out.assets.some((asset) => asset.attrs.port === 443), false);
  assert.equal(out.assets.some((asset) => asset.attrs.port === 8080), false);

  assert.deepEqual(
    out.assets.map((asset) => asset.address),
    [
      "10.0.0.5",
      "10.0.0.5",
      "10.0.0.6",
      "api.example.com",
      "www.example.com",
    ],
  );
});

test("nmap truncates at 2000 assets without marking output skipped", () => {
  const ports = Array.from(
    { length: 2005 },
    (_, index) =>
      `<port protocol="tcp" portid="${index + 1}"><state state="open"/><service name="svc-${index + 1}"/></port>`,
  ).join("");
  const xml = `<nmaprun version="7.94"><host><address addr="10.9.0.1" addrtype="ipv4"/><ports>${ports}</ports></host></nmaprun>`;

  const out = parseToolOutput("nmap", xml);

  assert.equal(out.skipped, false);
  assert.equal(out.assets.length, 2000);
  assert.equal(out.assets[1999]?.attrs.port, 2000);
  assert.equal(out.assets.some((asset) => asset.attrs.port === 2001), false);
});

test("nmap distinguishes empty input from a valid scan with no hosts", () => {
  const empty = parseToolOutput("nmap", "   \n\t ");
  assert.equal(empty.skipped, true);
  assert.deepEqual(empty.assets, []);
  assert.deepEqual(empty.findings, []);
  assert.match(empty.reason ?? "", /empty input/);

  const noHosts = parseToolOutput(
    "nmap",
    '<nmaprun version="7.94"></nmaprun>',
  );
  assert.equal(noHosts.skipped, false);
  assert.equal(noHosts.assets.length, 0);
});

// ---------------------------------------------------------------------------
// httpx
// ---------------------------------------------------------------------------

test("httpx parses endpoints, normalizes host/URL, and keeps query values", () => {
  const out = parseToolOutput("httpx", HTTPX_JSONL);

  assert.equal(out.skipped, false);
  assert.equal(out.reason, undefined);
  assert.equal(out.findings.length, 0);
  assert.equal(out.assets.length, 2);

  assert.deepEqual(
    out.assets.map((asset) => asset.address),
    [
      "http://api.example.com:8080/v1/users?id=42",
      "https://app.example.com/login?next=%2Fhome",
    ],
  );

  const api = out.assets[0];
  assert.ok(api);
  assert.equal(api.kind, "endpoint");
  assert.equal(api.parent, "api.example.com");
  assert.deepEqual(api.attrs, { status: 302, tech: ["Express"] });

  const app = out.assets[1];
  assert.ok(app);
  assert.equal(app.kind, "endpoint");
  assert.equal(app.parent, "app.example.com");
  assert.deepEqual(app.attrs, {
    status: 200,
    tech: ["Nginx", "React"],
    title: "Login",
  });
  assert.equal(app.address.includes("#"), false);
  assert.equal(app.address.includes("next=%2Fhome"), true);
});

test("httpx dedupes normalized duplicate endpoints", () => {
  const firstLine = HTTPX_JSONL.split("\n")[0] ?? "";
  const out = parseToolOutput("httpx", `${HTTPX_JSONL}\n${firstLine}`);

  assert.equal(out.skipped, false);
  assert.equal(out.assets.length, 2);
});

test("httpx drops invalid URL records, and skips when none remain", () => {
  const mixed = `{"url":"not-a-url","host":"bad.example.com","status_code":200}
{"url":"https://ok.example.com/","host":"ok.example.com","status_code":200}`;
  const out = parseToolOutput("httpx", mixed);

  assert.equal(out.skipped, false);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0]?.address, "https://ok.example.com/");
  assert.match(out.reason ?? "", /ignored 1 invalid record/);

  const allInvalid = parseToolOutput(
    "httpx",
    '{"url":"not-a-url","status_code":200}',
  );
  assert.equal(allInvalid.skipped, true);
  assert.deepEqual(allInvalid.assets, []);
  assert.deepEqual(allInvalid.findings, []);
});

// ---------------------------------------------------------------------------
// nuclei
// ---------------------------------------------------------------------------

test("nuclei parses findings, downgrades invalid severity, and emits no assets", () => {
  const out = parseToolOutput("nuclei", NUCLEI_JSONL);

  assert.equal(out.skipped, false);
  assert.equal(out.reason, undefined);
  assert.equal(out.assets.length, 0);
  assert.equal(out.findings.length, 2);

  assert.deepEqual(
    out.findings.map((finding) => finding.asset),
    ["api.example.com", "app.example.com"],
  );

  const rce = out.findings[0];
  assert.ok(rce);
  assert.equal(rce.title, "Example RCE");
  assert.equal(rce.vulnClass, "nuclei:cve-2024-0001");
  assert.equal(rce.severity, "info"); // "warning" is not a contract severity
  assert.equal(rce.endpoint, "https://api.example.com/v1/users?id=42");

  const tech = out.findings[1];
  assert.ok(tech);
  assert.equal(tech.title, "Nginx Detection");
  assert.equal(tech.vulnClass, "nuclei:tech-detect");
  assert.equal(tech.severity, "info");
  assert.equal(tech.endpoint, "https://app.example.com/login");
});

test("nuclei dedupes findings by asset, vulnClass, and endpoint", () => {
  const firstLine = NUCLEI_JSONL.split("\n")[0] ?? "";
  const out = parseToolOutput("nuclei", `${NUCLEI_JSONL}\n${firstLine}`);

  assert.equal(out.skipped, false);
  assert.equal(out.findings.length, 2);
});

// ---------------------------------------------------------------------------
// ffuf
// ---------------------------------------------------------------------------

test("ffuf emits one finding and endpoint for each non-404 result", () => {
  const out = parseToolOutput("ffuf", FFUF_JSON);

  assert.equal(out.skipped, false);
  assert.equal(out.reason, undefined);
  assert.equal(out.assets.length, 1);
  assert.deepEqual(out.assets[0], {
    address: "https://app.example.com/admin",
    kind: "endpoint",
    parent: "app.example.com",
    attrs: { status: 200 },
  });

  assert.equal(out.findings.length, 1);
  const finding = out.findings[0];
  assert.ok(finding);
  assert.equal(finding.asset, "app.example.com");
  assert.equal(finding.vulnClass, "ffuf:exposed-path");
  assert.equal(finding.severity, "info");
  assert.equal(finding.endpoint, "https://app.example.com/admin");
  assert.equal(finding.title, "Exposed path: /admin");
  assert.match(finding.note ?? "", /status=200/);
  assert.match(finding.note ?? "", /length=1234/);
  assert.match(finding.note ?? "", /words=56/);
  assert.match(finding.note ?? "", /lines=7/);

  // The 404 wordlist answer is neither an asset nor a finding.
  assert.equal(
    out.assets.some((asset) => asset.address.endsWith("/missing")),
    false,
  );
});

test("ffuf all-404 and empty results are successful scans with no hits", () => {
  const all404 = `{"results":[{"status":404,"length":0,"words":1,"lines":1,"url":"https://app.example.com/missing"}]}`;
  const out = parseToolOutput("ffuf", all404);
  assert.equal(out.skipped, false);
  assert.deepEqual(out.assets, []);
  assert.deepEqual(out.findings, []);

  const empty = parseToolOutput("ffuf", '{"results":[]}');
  assert.equal(empty.skipped, false);
  assert.deepEqual(empty.assets, []);
  assert.deepEqual(empty.findings, []);
});

// ---------------------------------------------------------------------------
// skip / no-throw discipline
// ---------------------------------------------------------------------------

test("empty and whitespace-only input skips for every tool", () => {
  const tools: SupportedTool[] = ["nmap", "httpx", "nuclei", "ffuf"];
  for (const tool of tools) {
    const out = parseToolOutput(tool, " \n\t ");
    assert.equal(out.skipped, true);
    assert.deepEqual(out.assets, []);
    assert.deepEqual(out.findings, []);
    assert.equal(typeof out.reason, "string");
    assert.notEqual(out.reason, "");
  }
});

test("bad JSON/XML and format mismatches skip instead of throwing", () => {
  const cases: Array<[SupportedTool, string]> = [
    ["httpx", '{"url": "https://example.com/",'],
    ["nuclei", '{"template-id": "x", "info": {'],
    ["ffuf", '{"results": ['],
    ["ffuf", '{"not-results": []}'],
    ["nmap", '<nmaprun><host><address addr="10.0.0.1" addrtype="ipv4"/></nmaprun>'],
    ["nmap", "not xml at all"],
  ];

  for (const [tool, text] of cases) {
    assert.doesNotThrow(() => parseToolOutput(tool, text));
    const out = parseToolOutput(tool, text);
    assert.equal(out.skipped, true);
    assert.deepEqual(out.assets, []);
    assert.deepEqual(out.findings, []);
    assert.equal(typeof out.reason, "string");
    assert.notEqual(out.reason, "");
  }
});

test("one malformed JSONL line skips the whole output", () => {
  const validLine =
    '{"url":"https://ok.example.com/","host":"ok.example.com","status_code":200}';
  const out = parseToolOutput("httpx", `${validLine}\nnot-json`);

  assert.equal(out.skipped, true);
  assert.deepEqual(out.assets, []);
  assert.match(out.reason ?? "", /line 2/);
});

test("parser never throws for non-text input or an unknown tool", () => {
  assert.doesNotThrow(() =>
    parseToolOutput("httpx", null as unknown as string),
  );
  const notText = parseToolOutput("httpx", null as unknown as string);
  assert.equal(notText.skipped, true);
  assert.deepEqual(notText.assets, []);
  assert.deepEqual(notText.findings, []);

  const unknown = parseToolOutput("whatweb" as SupportedTool, "anything");
  assert.equal(unknown.skipped, true);
  assert.match(unknown.reason ?? "", /unsupported tool/);
});
