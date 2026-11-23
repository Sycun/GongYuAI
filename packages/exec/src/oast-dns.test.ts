import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { test } from "node:test";
import { dnsTokenFor, startOastDnsListener, type OastDnsHit } from "./oast-dns.js";

const DOMAIN = "oob.lab.test";
const TOKEN = "abcdef1234567890";

function encodeQuery(name: string, id = 0x1234): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".")) {
    const bytes = Buffer.from(label, "ascii");
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0); // A
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, ...parts, tail]);
}

function ask(port: number, query: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("dns query timeout"));
    }, 2_000);
    socket.on("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg);
    });
    socket.send(query, port, "127.0.0.1");
  });
}

function questionEnd(buf: Buffer): number {
  let offset = 12;
  for (;;) {
    const length = buf[offset]!;
    offset += 1;
    if (length === 0) break;
    offset += length;
  }
  return offset + 4;
}

test("dnsTokenFor accepts exactly <token>.<domain>", () => {
  assert.equal(dnsTokenFor(`${TOKEN}.${DOMAIN}`, DOMAIN), TOKEN);
  assert.equal(dnsTokenFor(`${TOKEN}.${DOMAIN}.`, DOMAIN), TOKEN);
  assert.equal(dnsTokenFor(`a.${TOKEN}.${DOMAIN}`, DOMAIN), null);
  assert.equal(dnsTokenFor(`${TOKEN}.other.test`, DOMAIN), null);
  assert.equal(dnsTokenFor(`short.${DOMAIN}`, DOMAIN), null);
});

test("valid A query gets an answer and records one DNS hit", async () => {
  const hits: OastDnsHit[] = [];
  const listener = await startOastDnsListener({
    listenHost: "127.0.0.1",
    listenPort: 0,
    domain: DOMAIN,
    answerIp: "10.9.9.9",
    onHit: (hit) => {
      hits.push(hit);
      return true;
    },
  });
  try {
    assert.equal(listener.hostname(TOKEN), `${TOKEN}.${DOMAIN}`);
    const response = await ask(listener.port, encodeQuery(`${TOKEN}.${DOMAIN}`));
    assert.equal(response.readUInt16BE(0), 0x1234);
    assert.equal(response.readUInt16BE(2) & 0x8000, 0x8000); // QR
    assert.equal(response.readUInt16BE(6), 1); // ANCOUNT
    const end = questionEnd(response);
    assert.equal(response.readUInt16BE(end + 2), 1); // type A
    assert.deepEqual([...response.subarray(end + 12, end + 16)], [10, 9, 9, 9]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.token, TOKEN);
    assert.equal(hits[0]!.protocol, "dns");
    assert.match(hits[0]!.sourceIp, /^127\.0\.0\.1$/);
  } finally {
    await listener.close();
  }
});

test("unknown token or non-A query returns no answer and no hit", async () => {
  const hits: OastDnsHit[] = [];
  const listener = await startOastDnsListener({
    listenPort: 0,
    domain: DOMAIN,
    onHit: (hit) => {
      hits.push(hit);
      return true;
    },
  });
  try {
    const unknown = await ask(listener.port, encodeQuery(`short.${DOMAIN}`));
    assert.equal(unknown.readUInt16BE(6), 0); // ANCOUNT
    assert.equal(unknown.readUInt16BE(2) & 0x000f, 3); // NXDOMAIN
    const other = await ask(listener.port, encodeQuery(`${TOKEN}.other.test`));
    assert.equal(other.readUInt16BE(6), 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(hits.length, 0);
  } finally {
    await listener.close();
  }
});

test("close is idempotent", async () => {
  const listener = await startOastDnsListener({
    listenPort: 0,
    domain: DOMAIN,
    onHit: () => true,
  });
  await listener.close();
  await listener.close();
});
