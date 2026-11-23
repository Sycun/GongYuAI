/**
 * 当前任务操作的回执归属。
 *
 * 一次操作从点击到回读都带着发起时的 taskId 和 requestId。
 * 切走任务不会取消已经发出的请求；回执写入发起任务。
 * 只有当前展示的任务、而且这次请求仍是该任务的最新请求时，才更新当前控件。
 */

export type TaskAction = "pause" | "resume";

export type TaskControlSnapshot = {
  taskId: string | null;
  taskName: string;
  status: string;
  reason: string;
  note: string;
  busy: "" | TaskAction;
};

export type ControlButton = { shown: true; busy: boolean; label: string };

export type TaskControlFace = {
  taskName: string;
  subject: string;
  statusText: string;
  pauseReason: string;
  note: string;
  pause: ControlButton | null;
  resume: ControlButton | null;
};

type Receipt = { status: string; reason: string; note: string; requestId: string };
type Outcome =
  | { ok: true; status: string; reason: string; confirmed: boolean }
  | { ok: false; message: string };

const ACTIVE = new Set(["queued", "running", "initializing"]);
const RESUMABLE = new Set(["paused", "failed", "stopped"]);

export function controlFace(
  snapshot: TaskControlSnapshot,
  statusLabel: (status: string) => string,
): TaskControlFace {
  const statusText = snapshot.status
    ? statusLabel(snapshot.status)
    : snapshot.taskId
      ? "读取中"
      : "等待任务回执";
  return {
    taskName: snapshot.taskName,
    subject: snapshot.taskId ? `任务 ${snapshot.taskId}` : "尚未选择",
    statusText,
    pauseReason: snapshot.status === "paused" ? snapshot.reason : "",
    note: snapshot.note,
    pause: snapshot.taskId && ACTIVE.has(snapshot.status)
      ? { shown: true, busy: snapshot.busy === "pause", label: snapshot.busy === "pause" ? "正在请求" : "暂停" }
      : null,
    resume: snapshot.taskId && RESUMABLE.has(snapshot.status)
      ? { shown: true, busy: snapshot.busy === "resume", label: snapshot.busy === "resume" ? "正在请求" : "继续" }
      : null,
  };
}

export class ViewedTaskControlsController {
  private taskId: string | null = null;
  private taskName = "等待任务回执";
  private seq = 0;
  private readonly receipts = new Map<string, Receipt>();
  private readonly latest = new Map<string, string>();
  private readonly busy = new Map<string, TaskAction>();
  private readonly epochs = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  snapshot(): TaskControlSnapshot {
    const saved = this.taskId ? this.receipts.get(this.taskId) : undefined;
    return {
      taskId: this.taskId,
      taskName: this.taskName,
      status: saved?.status ?? "",
      reason: saved?.reason ?? "",
      note: saved?.note ?? "",
      busy: this.taskId ? this.busy.get(this.taskId) ?? "" : "",
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  show(nextId: string | null, nextName: string, notify = true): void {
    this.taskId = nextId;
    this.taskName = nextName;
    if (notify) this.emit();
  }

  pollEpoch(taskId: string): number {
    return this.epochs.get(taskId) ?? 0;
  }

  /** 状态轮询只更新自己请求的任务，且不能盖过仍在飞行或更新的操作。 */
  applyPolledStatus(requested: string, status: string, responseTaskId: string, epoch: number, reason = ""): void {
    if (responseTaskId !== requested) return;
    if ((this.epochs.get(requested) ?? 0) !== epoch) return;
    if (this.busy.has(requested)) return;
    const current = this.receipts.get(requested);
    this.receipts.set(requested, {
      status,
      reason,
      note: current?.note ?? "",
      requestId: current?.requestId ?? "",
    });
    if (this.taskId === requested) this.emit();
  }

  async act(action: TaskAction): Promise<void> {
    const requested = this.taskId;
    if (!requested) return;
    const requestId = `${requested}:${++this.seq}`;
    this.latest.set(requested, requestId);
    this.busy.set(requested, action);
    this.epochs.set(requested, (this.epochs.get(requested) ?? 0) + 1);
    const path = `/tasks/${encodeURIComponent(requested)}/${action}`;
    const previous = this.receipts.get(requested);
    this.receipts.set(requested, {
      status: previous?.status ?? "",
      reason: previous?.reason ?? "",
      note: `实际请求：POST ${path}`,
      requestId,
    });
    if (this.taskId === requested) this.emit();
    let outcome: Outcome | undefined;
    try {
      const res = await this.fetchImpl(path, { method: "POST" });
      const body = await res.json().catch(() => ({})) as { task?: { status?: string }; error?: string };
      if (!res.ok) throw new Error(body.error || "任务操作失败");
      const again = await this.fetchImpl(`/tasks/${encodeURIComponent(requested)}`);
      const read = await again.json().catch(() => ({})) as { task?: { id?: string; status?: string; error?: string | null } };
      const next = String(read?.task?.status ?? body?.task?.status ?? "");
      outcome = { ok: true, status: next, reason: read?.task?.error ?? "", confirmed: again.ok && read?.task?.id === requested };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : "任务操作失败" };
    } finally {
      if (this.latest.get(requested) === requestId && outcome) {
        this.receipts.set(requested, outcome.ok
          ? {
            status: outcome.confirmed ? outcome.status : (previous?.status ?? ""),
            reason: outcome.confirmed ? outcome.reason : (previous?.reason ?? ""),
            note: `实际请求：POST ${path}。回读 ${requested} 的状态：${outcome.status || "未记录"}`,
            requestId,
          }
          : {
            status: previous?.status ?? "",
            reason: previous?.reason ?? "",
            note: `实际请求：POST ${path}。${outcome.message}`,
            requestId,
          });
        this.busy.delete(requested);
        if (this.taskId === requested) this.emit();
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
