import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ApprovalReceipt } from "@gongyuai/contracts";

export type CommandProposal = {
  tool: string; summary: string; digest: string;
  /** Only a fixed, local argv can be dispatched after a positive opinion. */
  localProbe?: string;
};
export type CommandTicket = {
  id: string; task: string; fence: number; at: number; action: CommandProposal; receipt?: ApprovalReceipt;
};
/** 执行回执：用户允许后 worker 实际执行的结果。 */
export type CommandOutcome = { ok: boolean; snippet: string; at: string };
export const localProbes = ["uname -m", "uname -s", "uname -r", "date -u"] as const;
const filename = "command-reviews.sqlite";

export function hasCommandLedger(dir: string) { return existsSync(join(dir, filename)); }

export class CommandLedger {
  private db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, filename));
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS review_epoch (task TEXT PRIMARY KEY, fence INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, fence INTEGER NOT NULL, at INTEGER NOT NULL,
        action TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);
      CREATE INDEX IF NOT EXISTS request_epoch ON requests(task,fence,state,at)`);
    // 旧库补 outcome 列（执行回执，允许后由 worker 写入）。
    const columns = this.db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "outcome")) {
      this.db.exec("ALTER TABLE requests ADD COLUMN outcome TEXT");
    }
  }
  close() { this.db.close(); }
  activate(task: string, fence: number) {
    this.db.prepare("INSERT INTO review_epoch VALUES (?,?,1) ON CONFLICT(task) DO UPDATE SET fence=excluded.fence,active=1 WHERE excluded.fence>review_epoch.fence").run(task, fence);
  }
  deactivate(task: string, fence: number) {
    this.db.prepare("UPDATE review_epoch SET active=0 WHERE task=? AND fence=?").run(task, fence);
  }
  active(task: string, fence: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM review_epoch WHERE task=? AND fence=? AND active=1").get(task, fence);
  }
  request(task: string, fence: number, action: CommandProposal): CommandTicket {
    const ticket = { id: randomUUID(), task, fence, at: Date.now(), action };
    this.db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,'pending',NULL,NULL)").run(ticket.id, task, fence, ticket.at, JSON.stringify(action));
    return ticket;
  }
  private decode(row: Record<string, unknown> | undefined): CommandTicket | undefined {
    if (!row) return;
    return { id: String(row.id), task: String(row.task), fence: Number(row.fence), at: Number(row.at),
      action: JSON.parse(String(row.action)), receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined };
  }
  next(task: string, fence: number, state: "held" | "pending" | "awaiting_user") {
    return this.decode(this.db.prepare("SELECT * FROM requests WHERE task=? AND fence=? AND state=? ORDER BY at,rowid LIMIT 1").get(task, fence, state));
  }
  get(id: string) { return this.decode(this.db.prepare("SELECT * FROM requests WHERE id=?").get(id)); }
  /** 手动确认：pending → awaiting_user，等待用户在会话内允许或拒绝。 */
  awaitUser(ticket: CommandTicket) {
    return this.db.prepare("UPDATE requests SET state='awaiting_user' WHERE id=? AND task=? AND fence=? AND state='pending'")
      .run(ticket.id, ticket.task, ticket.fence).changes === 1;
  }
  settle(ticket: CommandTicket, receipt: ApprovalReceipt) {
    return this.db.prepare("UPDATE requests SET state=?,receipt=? WHERE id=? AND task=? AND fence=? AND state IN ('pending','awaiting_user')")
      .run(receipt.decision === "allow" ? "allowed" : "held", JSON.stringify(receipt), ticket.id, ticket.task, ticket.fence).changes === 1;
  }
  outcome(id: string): CommandOutcome | undefined {
    const row = this.db.prepare("SELECT outcome FROM requests WHERE id=?").get(id) as { outcome?: string | null } | undefined;
    return row?.outcome ? JSON.parse(row.outcome) as CommandOutcome : undefined;
  }
  /** 任务最近一条已执行的命令（后台重试后回填任务记录用）。 */
  latestResolved(task: string): { id: string; at: number; outcome: CommandOutcome } | undefined {
    const row = this.db.prepare("SELECT id, at, outcome FROM requests WHERE task=? AND state='allowed' AND outcome IS NOT NULL ORDER BY at DESC, rowid DESC LIMIT 1").get(task) as
      | { id: string; at: number; outcome: string } | undefined;
    return row ? { id: row.id, at: Number(row.at), outcome: JSON.parse(row.outcome) as CommandOutcome } : undefined;
  }
  /** worker 执行后回写结果；仅允许态票据可写，回写一次后不再覆盖。 */
  complete(id: string, outcome: CommandOutcome) {
    return this.db.prepare("UPDATE requests SET outcome=? WHERE id=? AND state='allowed' AND outcome IS NULL")
      .run(JSON.stringify(outcome), id).changes === 1;
  }
}
