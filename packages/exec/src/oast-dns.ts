import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { netdJsonAsync, netdStreamNdjson, shouldUseGoBackend } from "./netd-client.js";

/**
 * P14-B2 — DNS 回调通道（UDP）。
 *
 * 只做一件事：对 `<token>.<domain>` 的 A 查询回一个公告地址并记一次 hit。
 * 命中只证明「目标解析了这个域名」，不等于可利用；是否采信仍由调用方的
 * 令牌台账判定（onHit 返回 true/false）。不落盘、不读环境变量。
 *
 * 解析失败、qtype 不是 A、域名不匹配 → 回 NXDOMAIN/空 NOERROR，且不记 hit。
 */

export type OastDnsHit = {
  token: string;
  at: string;
  sourceIp: string;
  protocol: "dns";
};

export type OastDnsListenerOptions = {
  /** UDP bind interface (default 127.0.0.1). */
  listenHost?: string;
  /** UDP bind port; 0 = ephemeral (default). 53 needs privilege. */
  listenPort?: number;
  /** Callback domain suffix, e.g. `oob.lab.test`. */
  domain: string;
  /** A-record address returned for a token query (default 127.0.0.1). */
  answerIp?: string;
  /** TTL seconds for the answer (default 60). */
  ttlSec?: number;
  onHit: (hit: OastDnsHit) => boolean | Promise<boolean>;
};

export type OastDnsListener = {
  port: number;
  /** `<token>.<domain>` for payloads. */
  hostname(token: string): string;
  close(): Promise<void>;
};

const MIN_TOKEN_LABEL_LENGTH = 8;
const MAX_TOKEN_LABEL_LENGTH = 64;
const TYPE_A = 1;
const CLASS_IN = 1;
const NXDOMAIN = 3;

function decodeQName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let cursor = offset;
  for (let guard = 0; guard < 64; guard += 1) {
    if (cursor >= buf.length) return null;
    const length = buf[cursor]!;
    cursor += 1;
    if (length === 0) return { name: labels.join("."), next: cursor };
    if ((length & 0xc0) !== 0) return null; // compression pointers are not expected in queries
    if (cursor + length > buf.length) return null;
    labels.push(buf.subarray(cursor, cursor + length).toString("ascii"));
    cursor += length;
  }
  return null;
}

function ipv4ToBytes(ip: string): Buffer | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
  return Buffer.from(bytes);
}

/** Extract the token when the queried name is exactly `<token>.<domain>`. */
export function dnsTokenFor(name: string, domain: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\.$/, "");
  const suffix = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!normalized.endsWith(`.${suffix}`)) return null;
  const label = normalized.slice(0, -(suffix.length + 1));
  if (label.includes(".")) return null;
  if (label.length < MIN_TOKEN_LABEL_LENGTH || label.length > MAX_TOKEN_LABEL_LENGTH) return null;
  return /^[a-z0-9]+$/.test(label) ? label : null;
}

function buildResponse(
  query: Buffer,
  questionEnd: number,
  answerIp: Buffer | null,
  ttlSec: number,
): Buffer {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2); // id
  // QR=1, Opcode=0, AA=1, TC=0, RD=1, RA=1, Z=0, RCODE=0|NXDOMAIN
  const rcode = answerIp ? 0 : NXDOMAIN;
  header.writeUInt16BE(0x8580 | rcode, 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(answerIp ? 1 : 0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = query.subarray(12, questionEnd);
  if (!answerIp) return Buffer.concat([header, question]);
  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // pointer to question name
  answer.writeUInt16BE(TYPE_A, 2);
  answer.writeUInt16BE(CLASS_IN, 4);
  answer.writeUInt32BE(ttlSec, 6);
  answer.writeUInt16BE(4, 10);
  answerIp.copy(answer, 12);
  return Buffer.concat([header, question, answer]);
}

export function startOastDnsListener(opts: OastDnsListenerOptions): Promise<OastDnsListener> {
  const listenHost = opts.listenHost ?? "127.0.0.1";
  const answer = ipv4ToBytes(opts.answerIp ?? "127.0.0.1") ?? Buffer.from([127, 0, 0, 1]);
  const ttlSec = Math.max(0, Math.min(86_400, opts.ttlSec ?? 60));
  const domain = opts.domain.replace(/^\.+|\.+$/g, "").toLowerCase();
  if (!domain) return Promise.reject(new Error("oast dns domain required"));

  if (shouldUseGoBackend()) {
    return (async () => {
      const started = await netdJsonAsync<{ id: string; port: number; domain: string }>(
        "POST",
        "/v1/oast/dns/start",
        {
          listenHost,
          listenPort: opts.listenPort ?? 0,
          domain,
          answerIp: opts.answerIp ?? "127.0.0.1",
          ttlSec,
        },
      );
      const stream = await netdStreamNdjson<OastDnsHit>(
        `/v1/oast/dns/${started.id}/events`,
        (hit) => {
          try {
            void Promise.resolve(opts.onHit(hit)).catch(() => undefined);
          } catch {
            /* ignore */
          }
        },
      );
      let closing: Promise<void> | null = null;
      return {
        port: started.port,
        hostname: (token: string) => `${token}.${domain}`,
        close(): Promise<void> {
          if (closing === null) {
            closing = (async () => {
              stream.close();
              await netdJsonAsync("POST", `/v1/oast/dns/${started.id}/stop`, {}, 10_000).catch(() => {});
            })();
          }
          return closing;
        },
      };
    })();
  }

  return new Promise((resolve, reject) => {
    const socket: Socket = createSocket({ type: "udp4" });
    let closed = false;
    const close = (): Promise<void> =>
      new Promise((done) => {
        if (closed) {
          done();
          return;
        }
        closed = true;
        try {
          socket.close(() => done());
        } catch {
          done();
        }
      });

    socket.on("error", (err) => {
      if (!closed) {
        closed = true;
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`oast dns listen ${listenHost}:${opts.listenPort ?? 0} failed: ${err.message}`));
      }
    });

    socket.on("message", (msg: Buffer, rinfo: RemoteInfo) => {
      try {
        if (msg.length < 12) return;
        const qdcount = msg.readUInt16BE(4);
        if (qdcount < 1) {
          socket.send(buildResponse(msg, 12, null, ttlSec), rinfo.port, rinfo.address);
          return;
        }
        const decoded = decodeQName(msg, 12);
        if (!decoded) {
          socket.send(buildResponse(msg, 12, null, ttlSec), rinfo.port, rinfo.address);
          return;
        }
        const qtypeOffset = decoded.next;
        const qtype = msg.readUInt16BE(qtypeOffset);
        const questionEnd = qtypeOffset + 4;
        const token = dnsTokenFor(decoded.name, domain);
        const valid = token !== null && qtype === TYPE_A;
        socket.send(
          buildResponse(msg, questionEnd, valid ? answer : null, ttlSec),
          rinfo.port,
          rinfo.address,
        );
        if (!valid || !token) return;
        const hit: OastDnsHit = {
          token,
          at: new Date().toISOString(),
          sourceIp: rinfo.address.replace(/^::ffff:/, ""),
          protocol: "dns",
        };
        void Promise.resolve(opts.onHit(hit)).catch(() => undefined);
      } catch {
        /* malformed packet: never crash the listener */
      }
    });

    socket.bind(opts.listenPort ?? 0, listenHost, () => {
      const address = socket.address();
      resolve({
        port: address.port,
        hostname: (token: string) => `${token}.${domain}`,
        close,
      });
    });
  });
}
