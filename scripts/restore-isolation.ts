/**
 * 恢复隔离演练（第七轮，验收项 2）。
 *
 * 上一轮的反例：旧备份里 11 个任务的 dataDir 全指向 Kali 正式目录，直接读备份
 * 时恢复服务返回的是正式实例的事实/事件计数与报告，而不是备份里的那一份。
 *
 * 本脚本用**同一份判定逻辑**做三件事：
 *   node --import tsx scripts/restore-isolation.ts selftest
 *       合成双胞胎：源目录与副本的同一份报告写不同标记、两边历史计数不同；
 *       用副本启动，API 必须返回副本特有的标记/计数/哈希；随后让源目录不可访问
 *       再验一次。这是自动化反例。
 *   node --import tsx scripts/restore-isolation.ts backup <archive.tar.gz>
 *       从真实备份做隔离恢复：独立数据根 + 回环端口，逐项比对任务 ID、kali-demo
 *       历史数、证据与报告字节哈希，并与正式实例读数对照。
 *   node --import tsx scripts/restore-isolation.ts sealed <archive.tar.gz>
 *       对含封存原件（evidence_versions / goal_proofs）的工程备份验证
 *       “恢复 → 读取封存版本 → 离线复算”。
 *
 * 全部演练都用 isolated 启动：不导入 ~/.gongyuai、不起 watchdog、不自动续跑。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootControlPlane } from "@gongyuai/control-plane";
import { openHistory, scorecardFromSnapshot, snapshotSha256, type DeliverySnapshot } from "@gongyuai/history";

type Check = { id: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(id: string, ok: boolean, detail: string): boolean {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${detail}`);
  return ok;
}
function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

type TaskCounts = { facts: number; events: number; goals: number; findings: number };

function countsFromSqlite(taskDir: string): TaskCounts {
  const dbPath = join(taskDir, "history.sqlite");
  if (!existsSync(dbPath)) return { facts: 0, events: 0, goals: 0, findings: 0 };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const n = (table: string): number => {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    };
    return { facts: n("facts"), events: n("events"), goals: n("goals"), findings: n("findings") };
  } finally {
    db.close();
  }
}

function taskIdsFromRoot(root: string): string[] {
  const dir = join(root, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory()).sort();
}

/** 直接读副本的 control.sqlite，看记录里的 dataDir 指向哪里。 */
function recordedDataDirs(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dbPath = join(root, "control.sqlite");
  if (!existsSync(dbPath)) return out;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`SELECT id, json FROM tasks`).all() as Array<{ id: string; json: string }>;
    for (const row of rows) {
      try {
        out.set(row.id, String((JSON.parse(row.json) as { dataDir?: string }).dataDir ?? ""));
      } catch {
        out.set(row.id, "");
      }
    }
  } finally {
    db.close();
  }
  return out;
}

async function apiGet<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return (await res.json()) as T;
}
async function apiText(base: string, path: string): Promise<string> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return await res.text();
}

/** 在独立数据根上做一次隔离恢复，并用 API 逐项读回。 */
async function drillCopy(
  copyRoot: string,
  options: { firstBoot?: boolean },
) {
  const plane = await bootControlPlane({
    dataRoot: copyRoot,
    host: "127.0.0.1",
    port: 0,
    isolated: true,
  });
  try {
    const base = plane.url;
    const tasks = await apiGet<{ tasks: Array<{ id: string; name: string; status: string; dataDir: string }> }>(base, "/tasks");
    const apiIds = tasks.tasks.map((task) => task.id).sort();
    const copyIds = taskIdsFromRoot(copyRoot);
    check(
      "tasks.ids",
      JSON.stringify(apiIds) === JSON.stringify(copyIds),
      `${apiIds.length} 项，与副本目录一致（${copyIds.length} 项）`,
    );
    // 首次启动必须改写全部越界记录；再次启动时副本数据库已被改写，改写 0 条才是对的。
    const rehomeOk = options.firstBoot
      ? plane.rehomed.length === tasks.tasks.length
      : plane.rehomed.length === 0;
    check(
      "restore.rehomed",
      rehomeOk,
      options.firstBoot
        ? `首次启动改写目录归属 ${plane.rehomed.length}/${tasks.tasks.length} 条` +
            (plane.rehomed[0] ? `（如 ${plane.rehomed[0].taskId}: ${plane.rehomed[0].from} → ${plane.rehomed[0].to}）` : "")
        : `再次启动改写 ${plane.rehomed.length} 条（副本记录已在上次启动时收回到副本内）`,
    );
    const outsideRoot = tasks.tasks.filter((task) => !resolve(task.dataDir).startsWith(resolve(copyRoot)));
    check(
      "tasks.dataDir-in-copy",
      outsideRoot.length === 0,
      outsideRoot.length ? `越界：${outsideRoot.map((t) => t.dataDir).join(", ")}` : "全部任务 dataDir 在副本内",
    );
    check("port.loopback", /^http:\/\/127\.0\.0\.1:\d+$/.test(base), `隔离实例地址 ${base}`);
    check("isolated.no-watchdog", plane.isolated === true, "isolated=true（不自动续跑、不导入旧数据根）");

    return { base, plane, tasks: tasks.tasks, summary: [] as string[] };
  } catch (err) {
    await plane.close();
    throw err;
  }
}

// ── 一、合成双胞胎反例 ────────────────────────────────────────────────────

function buildTwin(root: string, marker: string) {
  const taskId = "0f0f0f0f-1111-4111-8111-0f0f0f0f0f0f";
  const taskDir = join(root, "tasks", taskId);
  mkdirSync(join(taskDir, "evidence"), { recursive: true });
  mkdirSync(join(taskDir, "workspace"), { recursive: true });
  writeFileSync(join(taskDir, "report.md"), `# 恢复演练报告\n\n标记 ${marker}\n`);
  writeFileSync(join(taskDir, "evidence", "marker.txt"), `evidence ${marker}\n`);
  writeFileSync(join(taskDir, "manifest.json"), JSON.stringify({ taskId, dataDir: taskDir, evidenceDir: join(taskDir, "evidence") }, null, 2) + "\n");
  const history = openHistory({ dbPath: join(taskDir, "history.sqlite"), evidenceDir: join(taskDir, "evidence") });
  try {
    history.seedGoals(taskId, [{
      id: "g1", title: "演练目标", description: "恢复演练用", evidencePatterns: ["marker.txt"],
      passes: false, evidencePaths: [], assertedAt: null,
    }]);
    history.appendFact({ taskId, layer: "title", title: `事实 ${marker}`, summary: "恢复演练", tags: [] });
  } finally {
    history.close();
  }
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "control.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL)`);
  db.prepare(`INSERT OR REPLACE INTO tasks (id, json) VALUES (?, ?)`).run(taskId, JSON.stringify({
    id: taskId,
    tenantId: "default",
    name: "restore-twin",
    engagementId: taskId,
    status: "completed",
    auth: { authorizationNote: "合成夹具", targets: ["fixture.example"], outOfScope: [] },
    goals: [],
    budget: { maxTokens: 0, maxWallMs: 0, maxToolCalls: 0, maxInstalls: 0 },
    mock: true,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-11-22T00:01:00.000Z",
    leaseOwner: null,
    leaseUntil: null,
    fence: 0,
    containerId: null,
    workerPid: 9999,
    workerPids: [9999],
    containerIds: [],
    dataDir: taskDir,
    error: null,
    usage: { tokens: 0, toolCalls: 0, installs: 0 },
  }));
  db.close();
  return { taskId, taskDir };
}

async function selftest(outDir: string) {
  const work = mkdtempSync(join(tmpdir(), "gy-restore-selftest-"));
  const sourceRoot = join(work, "source");
  const copyRoot = join(work, "copy");
  const record: Record<string, unknown> = { kind: "restore-isolation-selftest", at: new Date().toISOString() };
  try {
    const twin = buildTwin(sourceRoot, "SOURCE-ONLY-MARKER");
    cpSync(join(sourceRoot, "tasks"), join(copyRoot, "tasks"), { recursive: true });
    cpSync(join(sourceRoot, "control.sqlite"), join(copyRoot, "control.sqlite"));

    // 让副本与源目录不同：报告写唯一标记，历史多记 3 条事实 + 2 条事件。
    const copyTaskDir = join(copyRoot, "tasks", twin.taskId);
    writeFileSync(join(copyTaskDir, "report.md"), `# 恢复演练报告\n\n标记 COPY-ONLY-MARKER\n`);
    writeFileSync(join(copyTaskDir, "evidence", "marker.txt"), "evidence COPY-ONLY-MARKER\n");
    const copyHistory = openHistory({
      dbPath: join(copyTaskDir, "history.sqlite"),
      evidenceDir: join(copyTaskDir, "evidence"),
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        copyHistory.appendFact({ taskId: twin.taskId, layer: "summary", title: `副本追加事实 ${i}`, summary: "copy-only", tags: ["copy"] });
      }
      copyHistory.recordEvent(twin.taskId, "hint_appended", { note: "copy-only-event-1" });
      copyHistory.recordEvent(twin.taskId, "hint_appended", { note: "copy-only-event-2" });
    } finally {
      copyHistory.close();
    }
    const sourceCounts = countsFromSqlite(twin.taskDir);
    const copyCounts = countsFromSqlite(copyTaskDir);
    const sourceReportSha = sha256File(join(twin.taskDir, "report.md"));
    const copyReportSha = sha256File(join(copyTaskDir, "report.md"));
    record.source = { counts: sourceCounts, reportSha: sourceReportSha };
    record.copy = { counts: copyCounts, reportSha: copyReportSha };

    check("fixture.counts-differ", JSON.stringify(sourceCounts) !== JSON.stringify(copyCounts),
      `源 ${sourceCounts.facts} 事实/${sourceCounts.events} 事件 · 副本 ${copyCounts.facts} 事实/${copyCounts.events} 事件`);
    check("fixture.report-differs", sourceReportSha !== copyReportSha, `源 ${sourceReportSha.slice(0, 12)}… · 副本 ${copyReportSha.slice(0, 12)}…`);

    // 复制后记录仍指向源目录：这就是上一轮反例的形状。
    const before = recordedDataDirs(copyRoot).get(twin.taskId) ?? "";
    check("fixture.copy-points-at-source", resolve(before) === resolve(twin.taskDir),
      `副本 control.sqlite 记录 dataDir=${before}（旧备份的真实形状）`);

    // 第一次：源目录可访问。
    const first = await drillCopy(copyRoot, { firstBoot: true });
    try {
      const report = await apiText(first.base, `/tasks/${twin.taskId}/report`);
      check("api.report-copy-marker", report.includes("COPY-ONLY-MARKER") && !report.includes("SOURCE-ONLY-MARKER"),
        `报告标记来自副本（${sha256(report).slice(0, 12)}…）`);
      check("api.report-hash", sha256(report) === copyReportSha, `报告字节哈希 ${sha256(report).slice(0, 12)}… = 副本文件`);
      const history = await apiGet<{ facts: unknown[]; events: unknown[]; goals: unknown[] }>(first.base, `/tasks/${twin.taskId}/history`);
      check("api.history-counts",
        history.facts.length === copyCounts.facts && history.events.length === copyCounts.events,
        `API 事实 ${history.facts.length}（副本 ${copyCounts.facts}、源 ${sourceCounts.facts}）· 事件 ${history.events.length}（副本 ${copyCounts.events}、源 ${sourceCounts.events}）`);
      const evidence = await apiText(first.base, `/tasks/${twin.taskId}/evidence/file?path=${encodeURIComponent("marker.txt")}`);
      check("api.evidence-bytes", sha256(evidence) === sha256File(join(copyTaskDir, "evidence", "marker.txt")),
        `证据字节哈希 ${sha256(evidence).slice(0, 12)}… = 副本文件`);
      record.firstRun = { reportSha: sha256(report), facts: history.facts.length, events: history.events.length };
    } finally {
      await first.plane.close();
    }

    // 第二次：让源目录不可访问后重复验证。
    chmodSync(sourceRoot, 0o000);
    let sourceInaccessible = false;
    try {
      readFileSync(join(twin.taskDir, "report.md"));
    } catch {
      sourceInaccessible = true;
    }
    check("negative.source-inaccessible", sourceInaccessible, "源目录已 chmod 000，读取被拒");
    try {
      const second = await drillCopy(copyRoot, {});
      try {
        const report = await apiText(second.base, `/tasks/${twin.taskId}/report`);
        check("negative.report-copy-marker", report.includes("COPY-ONLY-MARKER") && !report.includes("SOURCE-ONLY-MARKER"),
          "源目录不可访问时，报告仍来自副本");
        const history = await apiGet<{ facts: unknown[]; events: unknown[] }>(second.base, `/tasks/${twin.taskId}/history`);
        check("negative.history-counts",
          history.facts.length === copyCounts.facts && history.events.length === copyCounts.events,
          `事实 ${history.facts.length}、事件 ${history.events.length} 仍等于副本读数`);
        record.secondRun = { reportSha: sha256(report), facts: history.facts.length, events: history.events.length };
      } finally {
        await second.plane.close();
      }
    } finally {
      chmodSync(sourceRoot, 0o755);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return record;
}

// ── 二、真实备份的隔离恢复 ────────────────────────────────────────────────

function extractArchive(archive: string, into: string): string {
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: ["ignore", "pipe", "pipe"] });
  // 备份的顶层是 `.gongyuai/`
  const candidates = [join(into, ".gongyuai"), into];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "control.sqlite"))) return candidate;
  }
  throw new Error(`归档里找不到 control.sqlite：${archive}`);
}

async function backupDrill(archive: string, outDir: string) {
  const work = mkdtempSync(join(tmpdir(), "gy-restore-backup-"));
  const extracted = join(work, "extract");
  const record: Record<string, unknown> = {
    kind: "restore-isolation-backup",
    at: new Date().toISOString(),
    archive,
    archiveSha256: sha256File(archive),
    archiveBytes: statSync(archive).size,
  };
  try {
    const copyRoot = extractArchive(archive, extracted);
    const copyIds = taskIdsFromRoot(copyRoot);
    check("archive.tasks", copyIds.length > 0, `归档内 ${copyIds.length} 个任务`);
    record.taskIds = copyIds;

    // 归档里的记录仍指向正式目录（旧备份的真实形状）。
    const recorded = recordedDataDirs(copyRoot);
    const pointingAtFormal = [...recorded.values()].filter((dir) => dir.startsWith("/home/parallels/GongYuAI/.gongyuai/tasks/"));
    check("archive.records-point-at-formal", pointingAtFormal.length === recorded.size,
      `${pointingAtFormal.length}/${recorded.size} 条记录的 dataDir 指向正式目录`);

    const demoId = copyIds.find((id) => {
      const db = new DatabaseSync(join(copyRoot, "tasks", id, "history.sqlite"), { readOnly: true });
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number };
        return Number(row.n) === 4;
      } catch {
        return false;
      } finally {
        db.close();
      }
    }) ?? copyIds[0]!;
    const demoDir = join(copyRoot, "tasks", demoId);
    const demoCounts = countsFromSqlite(demoDir);
    const demoReport = existsSync(join(demoDir, "report.md")) ? readFileSync(join(demoDir, "report.md")) : Buffer.from("");
    record.kaliDemo = { taskId: demoId, counts: demoCounts, reportSha: sha256(demoReport) };
    check("archive.demo-counts", demoCounts.facts > 0, `kali-demo 归档读数：事实 ${demoCounts.facts}、事件 ${demoCounts.events}`);

    // 逐份文件哈希（归档字节 vs 恢复后 API 返回字节）。
    const evidenceFiles = existsSync(join(demoDir, "evidence")) ? readdirSync(join(demoDir, "evidence"), { recursive: true })
      .map(String)
      .filter((rel) => existsSync(join(demoDir, "evidence", rel)) && statSync(join(demoDir, "evidence", rel)).isFile())
      .slice(0, 8) : [];
    const evidenceHashes = new Map<string, string>();
    for (const rel of evidenceFiles) {
      evidenceHashes.set(rel, sha256File(join(demoDir, "evidence", rel)));
    }
    record.evidenceHashes = Object.fromEntries(evidenceHashes);

    const run = await drillCopy(copyRoot, { firstBoot: true });
    try {
      const history = await apiGet<{ facts: unknown[]; events: unknown[] }>(run.base, `/tasks/${demoId}/history`);
      check("api.demo-counts-match-archive",
        history.facts.length === demoCounts.facts && history.events.length === demoCounts.events,
        `API 事实 ${history.facts.length}、事件 ${history.events.length}；归档 ${demoCounts.facts}/${demoCounts.events}`);
      const report = await apiText(run.base, `/tasks/${demoId}/report`);
      check("api.demo-report-bytes", sha256(report) === sha256(demoReport),
        `报告字节哈希 ${sha256(report).slice(0, 12)}… = 归档文件 ${sha256(demoReport).slice(0, 12)}…`);
      let evidenceOk = 0;
      const evidenceProblems: string[] = [];
      for (const [rel, hash] of evidenceHashes) {
        try {
          const body = await apiText(run.base, `/tasks/${demoId}/evidence/file?path=${encodeURIComponent(rel)}`);
          if (sha256(body) === hash) evidenceOk += 1;
          else evidenceProblems.push(`${rel}: 字节不同`);
        } catch (err) {
          evidenceProblems.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      check("api.evidence-bytes-match-archive", evidenceProblems.length === 0,
        `${evidenceOk}/${evidenceHashes.size} 份证据字节一致` + (evidenceProblems.length ? `；${evidenceProblems.join("；")}` : ""));

      // 与正式实例对照：正式实例的 kali-demo 是 5/15，备份是 4/14。
      const formalBase = process.env.GY_FORMAL_BASE ?? "http://127.0.0.1:8877";
      try {
        const formal = await apiGet<{ facts: unknown[]; events: unknown[] }>(`${formalBase}`, `/tasks/${demoId}/history`);
        record.formal = { facts: formal.facts.length, events: formal.events.length };
        check("formal.differs-from-backup",
          formal.facts.length !== demoCounts.facts || formal.events.length !== demoCounts.events,
          `正式实例 ${formal.facts.length}/${formal.events.length} vs 备份 ${demoCounts.facts}/${demoCounts.events}（隔离实例返回的是备份读数）`);
        check("api.returns-backup-not-formal",
          history.facts.length === demoCounts.facts && history.facts.length !== formal.facts.length,
          `隔离实例事实 ${history.facts.length}，既不等于正式 ${formal.facts.length}，也等于归档 ${demoCounts.facts}`);
      } catch (err) {
        record.formal = { error: err instanceof Error ? err.message : String(err) };
        check("formal.differs-from-backup", false, `正式实例不可读：${String((record.formal as { error: string }).error)}`);
      }

      // 封存链：旧备份没有这些表/记录，这里给出可复核的上限。
      const seal = (() => {
        const db = new DatabaseSync(join(demoDir, "history.sqlite"), { readOnly: true });
        try {
          const count = (table: string): number => {
            try {
              const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
              return Number(row.n);
            } catch {
              return -1;
            }
          };
          return { evidenceVersions: count("evidence_versions"), goalProofs: count("goal_proofs"), goalFindings: count("goal_findings") };
        } finally {
          db.close();
        }
      })();
      record.sealChain = seal;
      check("seal.chain-absent",
        seal.evidenceVersions === 0 && seal.goalProofs === 0,
        `evidence_versions=${seal.evidenceVersions}、goal_proofs=${seal.goalProofs}、goal_findings=${seal.goalFindings}：` +
          "旧备份没有封存原件，封存链无法验证（结论保留，不用新备份冒充）");

      // 快照仍可离线复算（能复算 ≠ 有封存原件）。
      const snapshot = await apiGet<{ snapshot: DeliverySnapshot }>(run.base, `/tasks/${demoId}/snapshot`);
      const recomputed = scorecardFromSnapshot(snapshot.snapshot);
      check("snapshot.recompute", recomputed.ok, recomputed.ok
        ? `快照可复算：历史 ${recomputed.scorecard.historicallyPassed}/${recomputed.scorecard.denominator}、当前 ${recomputed.scorecard.currentlySupported}/${recomputed.scorecard.denominator}、归属未知 ${recomputed.scorecard.unknownAttribution}`
        : recomputed.reason);
      record.snapshot = {
        seal: snapshot.sha256 ?? snapshotSha256(snapshot.snapshot),
        recomputed: recomputed.ok ? recomputed.scorecard : null,
      };
    } finally {
      await run.plane.close();
    }

    // 负例：把副本记录改指到一个可访问的诱饵目录，验证读取仍留在副本。
    const decoy = join(work, "decoy");
    mkdirSync(join(decoy, "tasks", demoId), { recursive: true });
    writeFileSync(join(decoy, "tasks", demoId, "report.md"), "# DECOY-FORMAL-REPORT\n\n这不是副本\n");
    const decoyDb = new DatabaseSync(join(copyRoot, "control.sqlite"));
    try {
      const row = decoyDb.prepare(`SELECT json FROM tasks WHERE id = ?`).get(demoId) as { json: string };
      const rec = JSON.parse(row.json) as { dataDir: string };
      rec.dataDir = join(decoy, "tasks", demoId);
      decoyDb.prepare(`UPDATE tasks SET json = ? WHERE id = ?`).run(JSON.stringify(rec), demoId);
    } finally {
      decoyDb.close();
    }
    const decoyRun = await drillCopy(copyRoot, { firstBoot: false });
    try {
      const report = await apiText(decoyRun.base, `/tasks/${demoId}/report`);
      check("decoy.copy-wins",
        !report.includes("DECOY-FORMAL-REPORT") && sha256(report) === sha256(demoReport),
        `把记录改指诱饵目录后，API 仍返回副本报告（${sha256(report).slice(0, 12)}…）`);
      chmodSync(decoy, 0o000);
      const lockedRun = await drillCopy(copyRoot, {});
      try {
        const report2 = await apiText(lockedRun.base, `/tasks/${demoId}/report`);
        check("decoy.copy-wins-without-source",
          !report2.includes("DECOY-FORMAL-REPORT") && sha256(report2) === sha256(demoReport),
          "诱饵目录不可访问时同样成立");
      } finally {
        await lockedRun.plane.close();
      }
      chmodSync(decoy, 0o755);
    } finally {
      await decoyRun.plane.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return record;
}

// ── 三、含封存原件的工程备份：恢复 → 读取封存版本 → 离线复算 ──────────────

async function sealedDrill(archive: string) {
  const work = mkdtempSync(join(tmpdir(), "gy-restore-sealed-"));
  const record: Record<string, unknown> = {
    kind: "restore-isolation-sealed",
    at: new Date().toISOString(),
    archive,
    archiveSha256: sha256File(archive),
    archiveBytes: statSync(archive).size,
  };
  try {
    const copyRoot = extractArchive(archive, join(work, "extract"));
    const run = await drillCopy(copyRoot, { firstBoot: true });
    try {
      const tasks = run.tasks;
      const proofs: Array<{ taskId: string; goalId: string; path: string; sha256: string }> = [];
      for (const task of tasks) {
        try {
          const history = await apiGet<{ goalProofs: Array<{ goalId: string; path: string; sha256: string }> }>(
            run.base, `/tasks/${task.id}/history`);
          for (const proof of history.goalProofs ?? []) proofs.push({ taskId: task.id, ...proof });
        } catch {
          /* 旧任务没有 History 也不影响结论 */
        }
      }
      record.proofCount = proofs.length;
      check("sealed.proofs-present", proofs.length > 0, `恢复出 ${proofs.length} 条首次通过依据（封存原件）`);
      if (!proofs.length) return record;

      const sample = proofs[0]!;
      const res = await fetch(`${run.base}/tasks/${sample.taskId}/report-evidence/${sample.sha256}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      check("sealed.version-readable", res.ok && sha256(bytes) === sample.sha256,
        `读取封存版本 ${sample.path}（${bytes.length} 字节，哈希 ${sha256(bytes).slice(0, 12)}…）`);

      const snapshot = await apiGet<{ snapshot: DeliverySnapshot }>(run.base, `/tasks/${sample.taskId}/snapshot`);
      const seal = snapshotSha256(snapshot.snapshot);
      const recomputed = scorecardFromSnapshot(snapshot.snapshot);
      check("sealed.snapshot-offline-recompute",
        recomputed.ok && seal === String(snapshot.snapshot.sha256 ?? ""),
        recomputed.ok
          ? `离线复算通过：封印 ${seal.slice(0, 12)}…，历史 ${recomputed.scorecard.historicallyPassed}/${recomputed.scorecard.denominator}、当前 ${recomputed.scorecard.currentlySupported}/${recomputed.scorecard.denominator}`
          : recomputed.reason);
      record.sample = { ...sample, bytes: bytes.length, seal, scorecard: recomputed.ok ? recomputed.scorecard : null };
    } finally {
      await run.plane.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return record;
}

// ── 入口 ──────────────────────────────────────────────────────────────────

function writeRecord(outDir: string, name: string, record: Record<string, unknown>, ok: boolean) {
  mkdirSync(outDir, { recursive: true });
  const payload = { ...record, checks, ok, finishedAt: new Date().toISOString() };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(payload, null, 2) + "\n");
  const lines = [
    `# 恢复隔离演练 — ${name}`,
    "",
    `时间　${String(record.at ?? "")}`,
    record.archive ? `归档　${String(record.archive)}` : "",
    record.archiveSha256 ? `归档 SHA-256　${String(record.archiveSha256)}（${String(record.archiveBytes)} 字节）` : "",
    "",
    "| 检查 | 结果 | 说明 |",
    "| --- | --- | --- |",
    ...checks.map((entry) => `| ${entry.id} | ${entry.ok ? "通过" : "失败"} | ${entry.detail.replace(/\|/g, "\\|")} |`),
    "",
    ok ? "结论：隔离恢复读取全部留在副本内。" : "结论：存在失败项。",
    "",
  ].filter((line) => line !== "");
  writeFileSync(join(outDir, `${name}.md`), lines.join("\n") + "\n");
  console.log(`\n记录：${join(outDir, `${name}.json`)}`);
}

async function main() {
  const [command, target, ...rest] = process.argv.slice(2);
  const outIndex = rest.indexOf("--out");
  const outDir = outIndex >= 0 ? resolve(rest[outIndex + 1]!) : join(process.cwd(), "out", "restore-isolation");
  let record: Record<string, unknown>;
  let name: string;
  if (command === "selftest") {
    name = "selftest";
    record = await selftest(outDir);
  } else if (command === "backup") {
    if (!target) throw new Error("用法：restore-isolation backup <archive.tar.gz> [--out DIR]");
    name = `backup-${basename(target).replace(/\.tar\.gz$/, "")}`;
    record = await backupDrill(resolve(target), outDir);
  } else if (command === "sealed") {
    if (!target) throw new Error("用法：restore-isolation sealed <archive.tar.gz> [--out DIR]");
    name = `sealed-${basename(target).replace(/\.tar\.gz$/, "")}`;
    record = await sealedDrill(resolve(target));
  } else {
    console.error("用法：restore-isolation selftest | backup <archive> | sealed <archive> [--out DIR]");
    process.exit(2);
  }
  const ok = checks.every((entry) => entry.ok);
  writeRecord(outDir, name, record, ok);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
