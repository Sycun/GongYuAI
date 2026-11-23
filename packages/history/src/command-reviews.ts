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
    this.db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,'pending',NULL)").run(ticket.id, task, fence, ticket.at, JSON.stringify(action));
    return ticket;
  }
  private decode(row: Record<string, unknown> | undefined): CommandTicket | undefined {
    if (!row) return;
    return { id: String(row.id), task: String(row.task), fence: Number(row.fence), at: Number(row.at),
      action: JSON.parse(String(row.action)), receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined };
  }
  next(task: string, fence: number, state: "held" | "pending") {
    return this.decode(this.db.prepare("SELECT * FROM requests WHERE task=? AND fence=? AND state=? ORDER BY at,rowid LIMIT 1").get(task, fence, state));
  }
  get(id: string) { return this.decode(this.db.prepare("SELECT * FROM requests WHERE id=?").get(id)); }
  settle(ticket: CommandTicket, receipt: ApprovalReceipt) {
    return this.db.prepare("UPDATE requests SET state=?,receipt=? WHERE id=? AND task=? AND fence=? AND state='pending'")
      .run(receipt.decision === "allow" ? "allowed" : "held", JSON.stringify(receipt), ticket.id, ticket.task, ticket.fence).changes === 1;
  }
}
