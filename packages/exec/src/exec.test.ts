import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, type Socket } from "node:net";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeCommand, authorizePeer, capabilityAtLeast, classifyCommand, extractHosts, hostAdmitAddress, hostScopeAllows } from "./scope.js";
import { runCommand } from "./proc.js";
import { JobStore } from "./jobs.js";
import { ShellSessionManager } from "./sessions.js";
import { C2Manager } from "./c2.js";

const AUTH = { targets: ["127.0.0.1", "10.10.0.0/16", "*.example.test"], outOfScope: ["10.10.9.9"], capability: "active-lab" as const };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gy-exec-"));
}

test("extractHosts 抽 URL/IP/CIDR 内主机，忽略 loopback 与路径/载荷/版本号误报", () => {
  assert.deepEqual(extractHosts("curl -s http://10.10.1.5:8080/a?b=1").sort(), ["10.10.1.5"]);
  assert.deepEqual(extractHosts("nmap -sV 10.10.2.3").sort(), ["10.10.2.3"]);
  assert.deepEqual(extractHosts("ffuf -u https://api.example.test/FUZZ -w w.txt").sort(), ["api.example.test"]);
  assert.deepEqual(extractHosts("curl http://127.0.0.1:8080/").sort(), []);
  // Path segments (/socket.io), query params (email=admin@evil.com), POST -d payloads, and version numbers must NOT be mistaken for target hosts.
  assert.deepEqual(
    extractHosts(`curl -s "http://10.10.1.5:8080/socket.io/?email=admin@evil.com&v=2.4.49.1" -d '{"user":"a@outside.org"}'`),
    ["10.10.1.5"],
  );
  assert.equal(authorizeCommand(AUTH, "nxc smb 10.10.1.5 -u guest -p ''").allowed, true);
  assert.equal(authorizeCommand(AUTH, "chisel client 10.10.1.5:8000 R:socks").allowed, true);
  // Shell variables ($h, 10.10.1.5$p) and RFC2606 placeholder domains alongside real targets must not false-block.
  assert.deepEqual(extractHosts("curl -s http://10.10.1.5$p/api"), ["10.10.1.5"]);
  assert.deepEqual(extractHosts("curl -s -h $h http://10.10.1.5/test"), ["10.10.1.5"]);
  assert.deepEqual(extractHosts("curl -s http://10.10.1.5/register -F email=u@example.com"), ["10.10.1.5"]);
  // Standalone out-of-scope example.com without any in-scope target is still caught.
  assert.deepEqual(extractHosts("curl -s https://example.com/"), ["example.com"]);
});

test("authorizeCommand：坐标内放行、越界拒绝、能力档位不足拒绝", () => {
  const ok = authorizeCommand(AUTH, "curl -s http://10.10.1.5:8080/");
  assert.equal(ok.allowed, true, ok.reason);
  assert.equal(ok.need, "scan");

  const oos = authorizeCommand(AUTH, "curl -s http://10.10.9.9/");
  assert.equal(oos.allowed, false);
  assert.match(oos.reason, /越界/);

  const low = authorizeCommand({ ...AUTH, capability: "scan" }, "sqlmap -u http://10.10.1.5/x?id=1");
  assert.equal(low.allowed, false);
  assert.match(low.reason, /能力档位不足/);

  const local = authorizeCommand({ ...AUTH, capability: "scan" }, "uname -a");
  assert.equal(local.allowed, true, local.reason);
});

test("authorizeCommand：主机网络变更与破坏命令始终拒绝；只读状态查询放行", () => {
  assert.equal(classifyCommand("iptables -A INPUT -j DROP"), "host-network");
  assert.equal(authorizeCommand({ ...AUTH, capability: "full" }, "iptables -A INPUT -j DROP").allowed, false);
  assert.equal(classifyCommand("rm -rf / --no-preserve-root"), "destructive");
  assert.equal(authorizeCommand({ ...AUTH, capability: "full" }, "rm -rf / --no-preserve-root").allowed, false);
  assert.equal(classifyCommand("networksetup -setwebproxy Wi-Fi 127.0.0.1 8080"), "host-network");
  assert.equal(classifyCommand("scutil --nc start ViscosityLab"), "host-network");
  assert.equal(authorizeCommand(AUTH, "scutil --nc list").allowed, true);
  assert.equal(authorizeCommand(AUTH, "scutil --nc status ViscosityLab").allowed, true);
  assert.equal(authorizeCommand(AUTH, "networksetup -getinfo Wi-Fi").allowed, true);
  // 工具存在性枚举（which/command -v/for 循环列表）里的网络工具名不是主机变更，放行；
  // 真实调用（带 flag / -restore / nft 变更子命令 / 解释器 payload）仍拒。
  assert.notEqual(classifyCommand("for b in curl wget nc iptables ssh; do which $b; done"), "host-network");
  assert.notEqual(classifyCommand("which iptables ip6tables nft"), "host-network");
  assert.notEqual(classifyCommand("command -v iptables"), "host-network");
  assert.notEqual(classifyCommand("for b in nft; do which $b; done"), "host-network");
  assert.equal(classifyCommand("iptables-restore < rules.v4"), "host-network");
  assert.equal(classifyCommand("ip6tables -F"), "host-network");
  assert.equal(classifyCommand("nft add rule ip filter input drop"), "host-network");
  assert.equal(classifyCommand("bash -c 'iptables -A INPUT -j DROP'"), "host-network");
  // 用户态代理包装器（proxychains / tsocks）与 /tmp 工作目录清理不属宿主机破坏，支持内网横向与日常测试产物清理。
  assert.notEqual(classifyCommand("proxychains4 -q curl -s http://172.19.0.4:8080/"), "host-network");
  assert.notEqual(classifyCommand("proxychains nmap -sT -Pn 172.19.0.3"), "host-network");
  assert.notEqual(classifyCommand("rm -rf /tmp/evil-node && rm -f /tmp/cj.txt"), "destructive");
  assert.equal(classifyCommand("rm -rf /*"), "destructive");
  assert.equal(classifyCommand("rm -rf /etc"), "destructive");
  // 虚拟主机头（-H 'Host: oa.deeptech.com'）与短参数（sort -u / ls -t）不误报为越界直连主机；foothold-private 放行 RFC1918 私网但仍拦截排除项。
  assert.deepEqual(extractHosts(`curl -s http://10.10.1.5/ -H "Host: oa.deeptech.com"`), ["10.10.1.5"]);
  assert.deepEqual(extractHosts("sort -u /tmp/words.txt | head -n 20"), []);
  const pivotAuth = {
    targets: ["10.10.1.5"],
    outOfScope: ["172.19.0.99"],
    capability: "active-lab" as const,
    pivotPolicy: { mode: "foothold-private" as const, cidrs: [] },
  };
  assert.equal(authorizeCommand(pivotAuth, "proxychains curl -s http://172.19.0.4:8080/").allowed, true);
  assert.equal(authorizeCommand(pivotAuth, "proxychains curl -s http://172.19.0.99:8080/").allowed, false);
  assert.equal(authorizeCommand(pivotAuth, "curl -s http://203.0.113.50/").allowed, false);
});

test("capabilityAtLeast 阶梯", () => {
  assert.equal(capabilityAtLeast("observe", "scan"), false);
  assert.equal(capabilityAtLeast("active-lab", "scan"), true);
  assert.equal(capabilityAtLeast(undefined, "observe"), true);
});

test("authorizePeer：loopback 允许、范围外拒绝", () => {
  assert.equal(authorizePeer(AUTH, "127.0.0.1").allowed, true);
  assert.equal(authorizePeer(AUTH, "203.0.113.9").allowed, false);
  assert.equal(authorizePeer({ targets: ["203.0.113.0/24"] }, "203.0.113.9").allowed, true);
});

test("runCommand：正常退出码与输出", async () => {
  const dir = tempDir();
  try {
    const r = await runCommand({ command: "printf 'a'; printf 'b' >&2; exit 3", cwd: dir, timeoutMs: 5_000 });
    assert.equal(r.exitCode, 3);
    assert.equal(r.stdout, "a");
    assert.equal(r.stderr, "b");
    assert.equal(r.timedOut, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand：超时按进程组杀死并标记 timedOut", async () => {
  const dir = tempDir();
  try {
    const r = await runCommand({ command: "sleep 5", cwd: dir, timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(r.durationMs < 4_000, `duration=${r.durationMs}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JobStore：后台作业活过一次工具调用，增量读输出", async () => {
  const dir = tempDir();
  try {
    const store = new JobStore(dir);
    const job = store.start({ command: "printf 'one\\n'; sleep 0.4; printf 'two\\n'", cwd: dir, label: "test job" });
    assert.equal(job.status, "running");
    const waited = await store.wait(job.id, { untilOutput: "two", timeoutMs: 10_000 });
    assert.equal(waited.matched, true, JSON.stringify(waited.meta));
    let meta = store.get(job.id);
    const deadline = Date.now() + 5_000;
    while (meta?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      meta = store.get(job.id);
    }
    assert.equal(meta?.status, "exited", JSON.stringify(meta));
    assert.equal(meta?.exitCode, 0);
    const chunk = store.read(job.id, "stdout", 0);
    assert.equal(chunk?.data.includes("one"), true);
    assert.equal(chunk?.data.includes("two"), true);
    const next = store.read(job.id, "stdout", chunk!.nextOffset);
    assert.equal(next?.data, "");
    assert.equal(store.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JobStore：kill 之后状态为 killed 且不再变更", async () => {
  const dir = tempDir();
  try {
    const store = new JobStore(dir);
    const job = store.start({ command: "sleep 30", cwd: dir });
    const killed = store.kill(job.id);
    assert.equal(killed?.status, "killed");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(store.get(job.id)?.status, "killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ShellSessionManager：PTY 会话可持续输入输出", async () => {
  const dir = tempDir();
  const mgr = new ShellSessionManager(dir);
  try {
    const session = mgr.open({ cwd: dir });
    assert.equal(session.status, "open");
    const first = await mgr.wait(session.id, { idleMs: 400, timeoutMs: 8_000 });
    assert.equal(first.status, "open");
    assert.ok(mgr.write(session.id, "echo gy-hello").ok);
    const got = await mgr.wait(session.id, { pattern: "gy-hello", timeoutMs: 8_000 });
    assert.equal(got.matched, true, `tail=${got.data.slice(-300)}`);
    assert.ok(mgr.write(session.id, "pwd").ok);
    const pwd = await mgr.wait(session.id, { pattern: dir.split("/").pop()!, timeoutMs: 8_000 });
    assert.equal(pwd.matched, true, `tail=${pwd.data.slice(-300)}`);
    assert.equal(mgr.list().length, 1);
  } finally {
    mgr.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 合成 raw implant：把收到的整行交给本地 bash 执行，模拟反弹 shell。 */
function fakeRawImplant(port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => resolve(() => socket.destroy()));
    socket.on("error", reject);
    socket.write("ready\n");
    socket.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const out = execSync(line, { encoding: "utf8", timeout: 5_000 });
          socket.write(out);
        } catch (err) {
          socket.write(`ERR ${(err as Error).message}\n`);
        }
      }
    });
  });
}

test("C2Manager(raw)：监听、会话、执行、输出回收、越界命令拒绝", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 300 });
  let closeClient: (() => void) | null = null;
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    assert.equal(listener.status, "running");
    closeClient = await fakeRawImplant(listener.bindPort);
    await new Promise((r) => setTimeout(r, 400));
    const sessions = c2.sessionList();
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.allowed, true, session.reason);

    const task = await c2.task(session.id, { kind: "exec", command: "echo gy-c2-ok", waitMs: 5_000 });
    assert.equal(task.status, "success", `${task.error} / ${task.result}`);
    assert.match(task.result, /gy-c2-ok/);

    await assert.rejects(
      () => c2.task(session.id, { kind: "exec", command: "curl http://evil.outside.test/", waitMs: 2_000 }),
      /C2 任务被拒绝/,
    );
    assert.equal(c2.taskList(session.id).length >= 2, true);
  } finally {
    closeClient?.();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2Manager(raw)：无输出且到等待上限的任务标记 failed，不伪装成功", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 300 });
  let closeClient: (() => void) | null = null;
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    closeClient = await fakeRawImplant(listener.bindPort);
    await new Promise((r) => setTimeout(r, 400));
    const session = c2.sessionList()[0]!;
    const task = await c2.task(session.id, { kind: "exec", command: "sleep 3", waitMs: 300, marker: "__NEVER__" });
    assert.equal(task.status, "failed", JSON.stringify(task));
    assert.match(task.error, /超时/);
  } finally {
    closeClient?.();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2Manager(raw)：文件上传/下载按 sha256 落盘并可分段读", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 300 });
  let closeClient: (() => void) | null = null;
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    closeClient = await fakeRawImplant(listener.bindPort);
    await new Promise((r) => setTimeout(r, 400));
    const session = c2.sessionList()[0]!;
    const payload = randomBytes(3_000);
    const remote = join(dir, "remote.bin");
    const put = await c2.putFile(session.id, remote, payload);
    assert.ok(put.tasks.length >= 2, `chunks=${put.tasks.length}`);
    assert.ok(put.tasks.every((t) => t.status === "success"), JSON.stringify(put.tasks.map((t) => [t.status, t.error])));
    assert.equal(put.file.sha256, createHash("sha256").update(payload).digest("hex"));
    const got = await c2.getFile(session.id, remote, { waitMs: 10_000 });
    assert.equal(got.file.sha256, put.file.sha256);
    assert.deepEqual(got.content, payload);
    const head = c2.readBlob(got.file.sha256, 0, 512);
    assert.deepEqual(Buffer.from(head.data, "base64"), payload.subarray(0, 512));
    assert.equal(head.size, payload.length);
  } finally {
    closeClient?.();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2Manager：看门狗关闭半开会话并让在途任务失败", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 200, sessionIdleMs: 400, sweepMs: 100 });
  const ref: { socket: Socket | null } = { socket: null };
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    await new Promise<void>((resolve, reject) => {
      ref.socket = connect({ host: "127.0.0.1", port: listener.bindPort }, () => resolve());
      ref.socket.on("error", reject);
      ref.socket.write("ready\n");
    });
    await new Promise((r) => setTimeout(r, 300));
    const session = c2.sessionList()[0]!;
    const pending = c2.task(session.id, { kind: "exec", command: "echo never", waitMs: 5_000, marker: "__NEVER__" });
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal(c2.session(session.id)?.status, "closed", JSON.stringify(c2.session(session.id)));
    const task = await pending;
    assert.equal(task.status, "failed", JSON.stringify(task));
  } finally {
    ref.socket?.destroy();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2Manager：agent token 不匹配直接断开，不登记会话", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 300, token: "s3cret" });
  const ref: { socket: Socket | null } = { socket: null };
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    await new Promise<void>((resolve) => {
      ref.socket = connect({ host: "127.0.0.1", port: listener.bindPort }, () => {
        ref.socket!.write(`${JSON.stringify({ t: "hello", host: "intruder", user: "x", token: "wrong" })}\n`);
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 500));
    const live = c2.sessionList().filter((item) => item.kind === "agent" && item.status !== "closed");
    assert.equal(live.length, 0, JSON.stringify(c2.sessionList()));
  } finally {
    ref.socket?.destroy();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2Manager(agent)：hello 握手后按任务派发并回收结果", async () => {
  const dir = tempDir();
  const c2 = new C2Manager({ baseDir: dir, auth: AUTH, handshakeMs: 500 });
  const ref: { socket: Socket | null } = { socket: null };
  try {
    const listener = await c2.listen({ bindHost: "127.0.0.1", bindPort: 0 });
    await new Promise<void>((resolve, reject) => {
      ref.socket = connect({ host: "127.0.0.1", port: listener.bindPort }, () => {
        ref.socket!.write(`${JSON.stringify({ t: "hello", host: "lab-host", user: "tester", os: "linux", arch: "x64", pid: 42 })}\n`);
        resolve();
      });
      ref.socket.on("error", reject);
      ref.socket.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { t?: string; id?: string; command?: string };
          if (msg.t === "task" && msg.id) {
            let stdout = "";
            try {
              stdout = execSync(msg.command ?? "", { encoding: "utf8", timeout: 5_000 });
            } catch {
              stdout = "";
            }
            ref.socket!.write(`${JSON.stringify({ t: "result", id: msg.id, ok: true, stdout })}\n`);
          }
        }
      });
    });
    await new Promise((r) => setTimeout(r, 600));
    const session = c2.sessionList()[0]!;
    assert.equal(session.kind, "agent");
    assert.equal(session.host, "lab-host");
    assert.equal(session.user, "tester");
    const task = await c2.task(session.id, { kind: "exec", command: "echo agent-ok", waitMs: 5_000 });
    assert.equal(task.status, "success", task.error);
    assert.match(task.result, /agent-ok/);
  } finally {
    ref.socket?.destroy();
    c2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P14-B7 参数级判类：引号内的危险动词不再被首词掩盖", async () => {
  const { shellTokens } = await import("./scope.js");
  assert.deepEqual(
    shellTokens("bash -c 'mimikatz.exe sekurlsa'"),
    ["bash", "-c", "mimikatz.exe", "sekurlsa"],
  );
  // Highest-risk verb inside an interpreter payload still demands full.
  assert.equal(authorizeCommand(AUTH, "bash -c 'mimikatz.exe sekurlsa'").need, "full");
  assert.equal(authorizeCommand(AUTH, "python3 -c 'import socket'").need, "scan");
  assert.equal(authorizeCommand(AUTH, "sh -c 'msfconsole -q'").need, "active-lab");
  // Destructive payload inside quotes is destructive, not exec.
  assert.equal(classifyCommand("bash -c \"rm -rf /\""), "destructive");
  assert.equal(classifyCommand("echo hi"), "exec");
});

test("破坏性判定：目标 URL 路径串非本机命令；裸动词与路径二进制仍拒", () => {
  const probe = [
    "cd /tmp/evidence && python3 -u - <<'PYEOF' 2>&1 | tail -40",
    "import http.client",
    'cands=["/api/manager/reboot","/api/manager/queue/update_all"]',
    "for p in cands: print(p)",
    "PYEOF",
  ].join("\n");
  assert.notEqual(classifyCommand(probe), "destructive");
  assert.notEqual(classifyCommand(probe), "host-network");
  assert.equal(classifyCommand("reboot"), "destructive");
  assert.equal(classifyCommand("sudo shutdown -h now"), "destructive");
  assert.equal(classifyCommand("/sbin/reboot"), "destructive");
  assert.equal(classifyCommand("sudo /usr/sbin/halt"), "destructive");
  assert.equal(classifyCommand("python3 -c 'import os; os.system(\"killall openvpn\")'"), "destructive");
  // Real HTTP probe to an in-scope target whose URL path contains /reboot is allowed, not a host action.
  const urlProbe = "curl -s http://10.10.1.5/api/manager/reboot";
  assert.notEqual(classifyCommand(urlProbe), "destructive");
  assert.equal(authorizeCommand(AUTH, urlProbe).allowed, true);
  assert.equal(authorizeCommand(AUTH, "httpx -u http://10.10.1.5/api/manager/reboot").allowed, true);
  // Bare host verbs / no-sudo shutdown / path binaries remain denied even at full capability.
  assert.equal(classifyCommand("halt"), "destructive");
  assert.equal(classifyCommand("shutdown -h now"), "destructive");
  assert.equal(authorizeCommand({ ...AUTH, capability: "full" }, "reboot").allowed, false);
  assert.equal(authorizeCommand({ ...AUTH, capability: "full" }, "/sbin/reboot").allowed, false);
});

test("P14-B4 已声明的 pivot CIDR 才放行内网主机", () => {
  const base = { targets: ["127.0.0.1"], outOfScope: [], capability: "active-lab" as const };
  assert.equal(authorizeCommand(base, "curl http://10.20.0.5/").allowed, false);
  const declared = {
    ...base,
    pivotPolicy: { mode: "declared" as const, cidrs: ["10.20.0.0/24"] },
  };
  assert.equal(authorizeCommand(declared, "curl http://10.20.0.5/").allowed, true);
  assert.equal(authorizeCommand(declared, "curl http://10.20.9.5/").allowed, false);
  const off = { ...base, pivotPolicy: { mode: "off" as const, cidrs: ["10.20.0.0/24"] } };
  assert.equal(authorizeCommand(off, "curl http://10.20.0.5/").allowed, false);

  // Per-task dataDir sidecar + NIC guard without global state:
  const dir = tempDir();
  const prevManifest = process.env.GY_MANIFEST;
  const nic = "192.168.77.7";
  const fpAuth = {
    targets: ["203.0.113.10"],
    outOfScope: [],
    capability: "active-lab" as const,
    pivotPolicy: { mode: "foothold-private" as const, cidrs: [] },
  };
  try {
    delete process.env.GY_MANIFEST;
    assert.equal(hostScopeAllows(fpAuth, nic, { dataDir: dir, nics: [nic] }), false);
    assert.equal(hostAdmitAddress(fpAuth, nic, { dataDir: dir, nics: [nic] }).kind, "oos");
    assert.equal(authorizeCommand(fpAuth, `curl http://${nic}/`, { dataDir: dir, nics: [nic] }).allowed, false);
    writeFileSync(join(dir, "admitted-targets.json"), JSON.stringify([nic]));
    assert.equal(hostScopeAllows(fpAuth, nic, { dataDir: dir, nics: [nic] }), true);
    assert.equal(authorizeCommand(fpAuth, `curl http://${nic}/`, { dataDir: dir, nics: [nic] }).allowed, true);
  } finally {
    if (prevManifest === undefined) delete process.env.GY_MANIFEST;
    else process.env.GY_MANIFEST = prevManifest;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P14-B4 陈旧会话：pid 已死 → closed 落盘，transcript 仍可读", () => {
  const dir = tempDir();
  try {
    const sessionsDir = join(dir, "sessions", "sh-stale-1");
    execSync(`mkdir -p ${JSON.stringify(sessionsDir)}`);
    execSync(`printf 'hello from dead pty\\n' > ${JSON.stringify(join(sessionsDir, "transcript.log"))}`);
    execSync(
      `cat > ${JSON.stringify(join(sessionsDir, "meta.json"))} <<'JSON'
{"id":"sh-stale-1","shell":"/bin/bash","cwd":"/tmp","pid":999999,"status":"open","createdAt":"2026-01-01T00:00:00.000Z","lastActivityAt":"2026-01-01T00:00:00.000Z","bufferPath":"${join(sessionsDir, "transcript.log")}","exitCode":null}
JSON`,
    );
    const mgr = new ShellSessionManager(dir);
    const meta = mgr.get("sh-stale-1");
    assert.equal(meta?.status, "closed");
    // 结论必须落盘，而不是只留在内存里。
    const persisted = JSON.parse(readFileSync(join(sessionsDir, "meta.json"), "utf8")) as { status?: string };
    assert.equal(persisted.status, "closed");
    assert.deepEqual(mgr.list().map((item) => item.id), ["sh-stale-1"]);
    const chunk = mgr.read("sh-stale-1", 0);
    assert.match(chunk?.data ?? "", /hello from dead pty/);
    assert.equal(chunk?.status, "closed");
    const write = mgr.write("sh-stale-1", "id");
    assert.equal(write.ok, false);
    assert.equal(write.status, "closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子进程非交互环境与 Linux OOM/虚拟内存护栏", async () => {
  const { buildNonInteractiveEnv, resolveLinuxSubprocessMaxVmemKb, wrapSubprocessCommand } = await import("./proc.js");
  const env = buildNonInteractiveEnv({ CUSTOM_KEY: "ok" });
  assert.equal(env.DEBIAN_FRONTEND, "noninteractive");
  assert.equal(env.SUDO_ASKPASS, "/bin/false");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.CUSTOM_KEY, "ok");

  // 8 GiB host → ~5.76 GiB cap (leaves headroom for V8/QEMU while stopping runaway 11 GiB Python scripts)
  const cap8g = resolveLinuxSubprocessMaxVmemKb({}, 8 * 1024 * 1024 * 1024);
  assert.ok(cap8g >= 5_242_880 && cap8g <= 8_388_608, `unexpected cap8g=${cap8g}`);
  assert.equal(resolveLinuxSubprocessMaxVmemKb({ GY_SUBPROCESS_MAX_VMEM_KB: "0" }), 0);

  const linuxWrapped = wrapSubprocessCommand("python3 solve.py", {}, "linux");
  assert.match(linuxWrapped, /oom_score_adj/);
  assert.match(linuxWrapped, /ulimit -v \d+/);
  assert.equal(wrapSubprocessCommand("python3 solve.py", {}, "darwin"), "python3 solve.py");
});
