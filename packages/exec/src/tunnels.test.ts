import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildTunnelCommand, TunnelManager, type TunnelMeta } from "./tunnels.js";

function tempBase(): string {
  return mkdtempSync(join(tmpdir(), "gy-tunnels-"));
}

function clean(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}

/** 运行时用例的准入探测：工具不存在就明确 skip，而不是把环境差异当失败。 */
function commandExists(bin: string): boolean {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
  return result.status === 0;
}

function findMetaFiles(baseDir: string): string[] {
  try {
    const entries = readdirSync(join(baseDir, "tunnels"), { recursive: true }) as string[];
    return entries.filter((entry) => String(entry).endsWith("meta.json"));
  } catch {
    return [];
  }
}

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

type EchoServer = { port: number; close: () => Promise<void> };

function startEchoServer(): Promise<EchoServer> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function tcpRoundTrip(port: number, payload: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (error: Error | null, value = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`隧道 ${port} 回显超时（已收到 ${JSON.stringify(data)}）`)),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length >= payload.length) finish(null, data);
    });
    socket.on("error", (error) => finish(error));
  });
}

/** open() 的 300ms 探测之后 socat 偶尔还没完成 bind：小步重试，别把时序当失败。 */
async function echoWithRetry(port: number, payload: string, attempts = 40): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await tcpRoundTrip(port, payload);
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function fixtureMeta(
  baseDir: string,
  id: string,
  patch: Pick<TunnelMeta, "status" | "pid"> & Partial<TunnelMeta>,
): TunnelMeta {
  return {
    id,
    kind: "socat",
    targetHost: "10.0.0.5",
    targetPort: 445,
    localPort: 22_500,
    command: "socat TCP-LISTEN:22500,bind=127.0.0.1,reuseaddr,fork TCP:10.0.0.5:445",
    logPath: join(baseDir, "tunnels", id, "socat.log"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function writeFixture(baseDir: string, meta: TunnelMeta): void {
  const dir = join(baseDir, "tunnels", meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

test("buildTunnelCommand：socat 只 bind 127.0.0.1，端口与目标参数正确", () => {
  const command = buildTunnelCommand({
    kind: "socat",
    targetHost: "10.0.0.5",
    targetPort: 445,
    localPort: 21_001,
  });
  assert.deepEqual(command, {
    bin: "socat",
    args: ["TCP-LISTEN:21001,bind=127.0.0.1,reuseaddr,fork", "TCP:10.0.0.5:445"],
    localPort: 21_001,
    targetHost: "10.0.0.5",
    targetPort: 445,
  });
  assert.ok(command.args[0]!.includes("bind=127.0.0.1"));
  assert.ok(!command.args[0]!.includes("0.0.0.0"));
});

test("buildTunnelCommand：ssh-local 带 -N/ExitOnForwardFailure/BatchMode 与 127.0.0.1 -L", () => {
  const command = buildTunnelCommand({
    kind: "ssh-local",
    via: "ops@jump.example.test",
    targetHost: "10.0.0.5",
    targetPort: 445,
    localPort: 21_002,
  });
  assert.equal(command.bin, "ssh");
  assert.deepEqual(command.args, [
    "-N",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-L",
    "127.0.0.1:21002:10.0.0.5:445",
    "ops@jump.example.test",
  ]);
  assert.ok(command.args.includes("-N"));
  assert.ok(command.args.some((arg) => arg.includes("127.0.0.1")));
  assert.equal(command.via, "ops@jump.example.test");
  assert.equal(command.targetHost, "10.0.0.5");
  assert.equal(command.targetPort, 445);
});

test("buildTunnelCommand：ssh-socks 本地 SOCKS 监听 127.0.0.1，无固定目标", () => {
  const command = buildTunnelCommand({
    kind: "ssh-socks",
    via: "ops@jump.example.test",
    localPort: 21_003,
  });
  assert.equal(command.bin, "ssh");
  assert.deepEqual(command.args, [
    "-N",
    "-D",
    "127.0.0.1:21003",
    "-o",
    "BatchMode=yes",
    "ops@jump.example.test",
  ]);
  assert.equal(command.via, "ops@jump.example.test");
  assert.equal(command.targetHost, "");
  assert.equal(command.targetPort, null);
});

test("buildTunnelCommand：chisel-socks 形状固定，默认 SOCKS 端口 1080", () => {
  const command = buildTunnelCommand({
    kind: "chisel-socks",
    via: "http://jump.example.test:8080",
  });
  assert.equal(command.bin, "chisel");
  assert.deepEqual(command.args, ["client", "http://jump.example.test:8080", "socks"]);
  assert.equal(command.localPort, 1_080);
  assert.equal(command.targetHost, "");
  assert.equal(command.targetPort, null);
  assert.equal(command.via, "http://jump.example.test:8080");
});

test("buildTunnelCommand：未指定端口落在 20000–40000，opts.localPort 可钉住，非法参数拒绝", () => {
  const command = buildTunnelCommand({ kind: "socat", targetHost: "127.0.0.1", targetPort: 8_080 });
  assert.ok(command.localPort >= 20_000 && command.localPort <= 40_000);
  assert.equal(
    command.args[0],
    `TCP-LISTEN:${command.localPort},bind=127.0.0.1,reuseaddr,fork`,
  );

  const pinned = buildTunnelCommand(
    { kind: "ssh-socks", via: "ops@jump.example.test" },
    { localPort: 23_456 },
  );
  assert.equal(pinned.localPort, 23_456);
  assert.deepEqual(pinned.args, [
    "-N",
    "-D",
    "127.0.0.1:23456",
    "-o",
    "BatchMode=yes",
    "ops@jump.example.test",
  ]);

  assert.throws(
    () => buildTunnelCommand({ kind: "socat", targetHost: "10.0.0.5", targetPort: 0 }),
    /targetPort/,
  );
  // `via` 以 - 开头会被 ssh 当成选项：必须在构造阶段拒绝（防参数注入）。
  assert.throws(
    () =>
      buildTunnelCommand({
        kind: "ssh-local",
        via: "-oProxyCommand=evil",
        targetHost: "10.0.0.5",
        targetPort: 443,
      }),
    /via/,
  );
});

test("authorizeHost 拒绝：open 抛错，不 spawn、不落 meta", async () => {
  const baseDir = tempBase();
  try {
    const seen: string[] = [];
    const manager = new TunnelManager({
      baseDir,
      authorizeHost: (host) => {
        seen.push(host);
        return false;
      },
    });
    await assert.rejects(
      manager.open({ kind: "socat", targetHost: "203.0.113.9", targetPort: 80, localPort: 21_010 }),
      /未授权/,
    );
    assert.deepEqual(seen, ["203.0.113.9"]);
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(findMetaFiles(baseDir), []);

    // ssh-local 的跳板（via）同样必须授权：目标放行、via 拒绝时不产生任何副作用。
    const viaSeen: string[] = [];
    const viaDenied = new TunnelManager({
      baseDir,
      authorizeHost: (host) => {
        viaSeen.push(host);
        return host !== "jump.example.test";
      },
    });
    await assert.rejects(
      viaDenied.open({
        kind: "ssh-local",
        via: "ops@jump.example.test",
        targetHost: "10.0.0.5",
        targetPort: 445,
        localPort: 21_011,
      }),
      /未授权/,
    );
    assert.deepEqual(viaSeen, ["10.0.0.5", "jump.example.test"]);
    assert.deepEqual(findMetaFiles(baseDir), []);
  } finally {
    clean(baseDir);
  }
});

test("命令不存在：open reject，meta 标 error（含命令与日志），close 幂等", async () => {
  const baseDir = tempBase();
  const savedPath = process.env.PATH;
  const emptyPath = mkdtempSync(join(tmpdir(), "gy-empty-path-"));
  try {
    // 用只含空目录的 PATH 确定性模拟“socat 不存在”，不依赖本机是否装了 socat。
    process.env.PATH = emptyPath;
    const manager = new TunnelManager({ baseDir, authorizeHost: () => true });

    let rejected: Error | null = null;
    try {
      await manager.open({ kind: "socat", targetHost: "127.0.0.1", targetPort: 9 });
    } catch (error) {
      rejected = error as Error;
    }
    assert.ok(rejected, "PATH 中没有 socat 时 open 必须 reject");
    assert.match(rejected.message, /隧道启动失败/);
    assert.match(rejected.message, /socat/);
    assert.match(rejected.message, /TCP-LISTEN:/);
    assert.match(rejected.message, /日志/);

    const metas = manager.list();
    assert.equal(metas.length, 1);
    const meta = metas[0]!;
    assert.equal(meta.status, "error");
    assert.equal(meta.pid, null);
    assert.ok(meta.error && meta.error.includes("socat"));
    assert.equal(meta.logPath, join(baseDir, "tunnels", meta.id, "socat.log"));
    assert.ok(existsSync(meta.logPath));
    assert.equal(manager.get(meta.id)?.status, "error");

    const closed = await manager.close(meta.id);
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.error, meta.error, "显式 close 只结束生命周期，不清空失败原因");
    const again = await manager.close(meta.id);
    assert.equal(again?.status, "closed");
    assert.equal(again?.updatedAt, closed?.updatedAt, "close 幂等：已 closed 不再改时间戳");

    await manager.closeAll();
    assert.ok(manager.list().every((entry) => entry.status === "closed"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(emptyPath, { recursive: true, force: true });
    clean(baseDir);
  }
});

test("list/get：pid 不存活标 closed，error 不被覆盖；未知 id 返回 null", async () => {
  const baseDir = tempBase();
  try {
    const manager = new TunnelManager({ baseDir, authorizeHost: () => true });
    const stale = fixtureMeta(baseDir, "tn-stale", { status: "running", pid: 2_000_000_000 });
    const failed = fixtureMeta(baseDir, "tn-failed", {
      status: "error",
      pid: null,
      error: "隧道启动失败：ENOENT",
    });
    writeFixture(baseDir, stale);
    writeFixture(baseDir, failed);

    const listed = manager.list();
    assert.equal(listed.length, 2);
    assert.equal(listed.find((meta) => meta.id === "tn-stale")?.status, "closed");
    assert.equal(listed.find((meta) => meta.id === "tn-failed")?.status, "error");

    // 磁盘上的终态也要落下去，重启后不会“复活”。
    assert.equal(manager.get("tn-stale")?.status, "closed");
    assert.equal(manager.get("tn-failed")?.status, "error");
    assert.equal(manager.get("tn-missing"), null);
    assert.equal(manager.get("../../etc"), null);
    assert.equal(await manager.close("tn-missing"), null);
  } finally {
    clean(baseDir);
  }
});

test("运行时：端口被占用时 socat 立即退出，meta 标 error 且错误里带日志尾部", async (t) => {
  if (!commandExists("socat")) {
    t.skip("socat 不在 PATH，跳过立即退出/日志尾部用例");
    return;
  }
  const baseDir = tempBase();
  // 占住一个本地端口，让 socat 的 TCP-LISTEN 必然 bind 失败并立即退出。
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const occupiedPort = (blocker.address() as AddressInfo).port;
  try {
    const manager = new TunnelManager({ baseDir, authorizeHost: () => true });
    let rejected: Error | null = null;
    try {
      await manager.open({
        kind: "socat",
        targetHost: "127.0.0.1",
        targetPort: 9,
        localPort: occupiedPort,
      });
    } catch (error) {
      rejected = error as Error;
    }
    assert.ok(rejected, "端口被占用时 open 必须 reject");
    assert.match(rejected.message, /隧道启动失败/);
    assert.match(rejected.message, /TCP-LISTEN:/);
    assert.match(rejected.message, /日志尾部/);

    const meta = manager.list()[0]!;
    assert.equal(meta.status, "error");
    assert.equal(meta.localPort, occupiedPort);
    assert.ok(meta.error && meta.error.includes("日志尾部"));
    const log = readFileSync(meta.logPath, "utf8");
    assert.ok(log.trim().length > 0, "socat 的 bind 失败原因应落在 stderr 日志里");
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    clean(baseDir);
  }
});

test("运行时：socat 隧道转发本地 TCP；并发 open 端口不重复；close/closeAll 清理", async (t) => {
  if (!commandExists("socat")) {
    t.skip("socat 不在 PATH，跳过运行时隧道用例");
    return;
  }
  const baseDir = tempBase();
  const echo = await startEchoServer();
  const manager = new TunnelManager({ baseDir, authorizeHost: () => true });
  try {
    const [first, second] = await Promise.all([
      manager.open({ kind: "socat", targetHost: "127.0.0.1", targetPort: echo.port }),
      manager.open({ kind: "socat", targetHost: "127.0.0.1", targetPort: echo.port }),
    ]);
    assert.ok(first.localPort >= 20_000 && first.localPort <= 40_000);
    assert.ok(second.localPort >= 20_000 && second.localPort <= 40_000);
    assert.notEqual(first.localPort, second.localPort, "并发 open 不得复用本地端口");
    assert.equal(first.status, "running");
    assert.equal(typeof first.pid, "number");
    assert.ok(existsSync(first.logPath));
    assert.equal(manager.get(first.id)?.status, "running");
    assert.equal(manager.list().length, 2);

    assert.equal(await echoWithRetry(first.localPort, "gy-tunnel-ping\n"), "gy-tunnel-ping\n");
    assert.equal(await echoWithRetry(second.localPort, "second-tunnel\n"), "second-tunnel\n");

    const pid = first.pid!;
    const closed = await manager.close(first.id);
    assert.equal(closed?.status, "closed");
    assert.ok(await waitFor(() => !pidAlive(pid)), "close 应杀掉整个 detached 进程组");
    const again = await manager.close(first.id);
    assert.equal(again?.status, "closed");
    assert.equal(again?.updatedAt, closed?.updatedAt);

    await manager.closeAll();
    assert.ok(manager.list().every((meta) => meta.status === "closed"));
    assert.ok(await waitFor(() => !pidAlive(second.pid)), "closeAll 应清理剩余隧道");
  } finally {
    await manager.closeAll();
    await echo.close();
    clean(baseDir);
  }
});
