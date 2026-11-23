import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellSessionManager } from "./sessions.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "gy-exec-persist-"));
}

/**
 * 验收重点：会话进程不依附 worker 生命周期。第一个 manager 打开会话后，
 * 第二个 manager 指向同一目录（模拟 worker 重启）必须能 list / read / write，
 * close 之后两边都只能看到 closed。
 *
 * 不断言底层是 python3 pty 还是 script(1)，只依赖 FIFO + transcript + pid 语义。
 */
test("ShellSessionManager：会话跨 manager 实例驻留（模拟 worker 重启）", async () => {
  const dir = tempDir();
  const first = new ShellSessionManager(dir);
  try {
    const session = first.open({ cwd: dir });
    assert.equal(session.status, "open");
    assert.equal(session.fifoPath, join(dir, "sessions", session.id, "input.fifo"));
    assert.equal(statSync(session.fifoPath).isFIFO(), true);

    // 等宿主 shell 起来（拿到首屏输出），再模拟 worker 重启。
    const boot = await first.wait(session.id, { idleMs: 400, timeoutMs: 10_000 });
    assert.equal(boot.status, "open");
    assert.ok(boot.data.length > 0, "首次输出为空");

    const second = new ShellSessionManager(dir);
    try {
      const listed = second.list();
      assert.equal(listed.length, 1, JSON.stringify(listed));
      assert.equal(listed[0]?.id, session.id);
      assert.equal(listed[0]?.status, "open", JSON.stringify(listed[0]));
      assert.equal(second.get(session.id)?.status, "open");

      // 历史输出：新 manager 只靠 transcript 就能读到。
      const history = second.read(session.id, 0);
      assert.ok((history?.size ?? 0) > 0, `history=${JSON.stringify(history)}`);
      assert.equal(history?.status, "open");

      // 新 manager 通过 FIFO 续写；arithmetic 展开证明命令真的被执行，
      // 而不是只命中 tty 回显。
      const wrote = second.write(session.id, "echo persisted-$((40+2))");
      assert.equal(wrote.ok, true, JSON.stringify(wrote));
      const got = await second.wait(session.id, { pattern: "persisted-42", timeoutMs: 10_000 });
      assert.equal(got.matched, true, `tail=${got.data.slice(-300)}`);

      assert.equal(second.get(session.id)?.status, "open");

      const closed = second.close(session.id);
      assert.equal(closed?.status, "closed");
      assert.equal(second.get(session.id)?.status, "closed");

      // close 必须真的收掉会话进程组（SIGKILL 后 pid 不再存活）。
      const pid = closed?.pid ?? session.pid;
      assert.equal(typeof pid, "number");
      const killDeadline = Date.now() + 3_000;
      let alive = true;
      while (alive && Date.now() < killDeadline) {
        try {
          process.kill(pid as number, 0);
        } catch {
          alive = false;
        }
        if (alive) await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(alive, false, `会话进程仍存活 pid=${String(pid)}`);
      assert.deepEqual(
        second.list().filter((item) => item.status === "open"),
        [],
        JSON.stringify(second.list()),
      );

      // close 只收进程，不动 transcript。
      const after = second.read(session.id, 0);
      assert.equal(after?.status, "closed");
      assert.match(after?.data ?? "", /persisted-42/);

      const rejected = second.write(session.id, "echo should-not-run");
      assert.equal(rejected.ok, false);
      assert.equal(rejected.status, "closed");
    } finally {
      second.closeAll();
    }
  } finally {
    first.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }
});
