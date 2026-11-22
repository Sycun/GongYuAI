import { useEffect, useState } from "react";
import { Button } from "@douyinfe/semi-ui";
import type { AssignmentView } from "@gongyuai/contracts/chat-input";
import type { Turn } from "../chat/useConversations";
import { STATUS_LABEL } from "../labels";

type Props = { turn: Turn; submitting: boolean; onTask: (t: Turn, view: AssignmentView) => void; onRetry: (t: Turn) => void };
const active = new Set(["queued", "running", "initializing"]);
export function AssignmentCard({ turn, submitting, onTask, onRetry }: Props) {
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (submitting) return;
    const controller = new AbortController();
    let timer: number | undefined;
    async function refresh() {
      try {
        const endpoint = turn.taskId ? "/tasks/" + turn.taskId + "/assignment" : "/tasks/submissions/" + turn.submissionKey;
        const res = await fetch(endpoint, { signal: controller.signal });
        if (!res.ok) {
          if (res.status === 404 && !turn.taskId) { setMessage("服务器尚无该提交记录"); return; }
          throw new Error("无法读取任务状态");
        }
        const view: AssignmentView = await res.json();
        if (controller.signal.aborted) return;
        setMessage(""); onTask(turn, view);
        if (!active.has(view.status) && view.status !== "paused" && view.status !== "failed" && view.status !== "stopped") return;
        timer = window.setTimeout(refresh, active.has(view.status) ? 1000 : 12000);
      } catch {
        if (!controller.signal.aborted) { setMessage("任务状态暂不可用"); timer = window.setTimeout(refresh, 3000); }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [turn, submitting, onTask, attempt]);
  async function control(action: string) {
    setBusy(true);
    try {
      const res = await fetch("/tasks/" + turn.taskId + "/" + action, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error || "任务操作失败");
      setAttempt(n => n + 1);
    } catch (e) { setMessage(e instanceof Error ? e.message : "任务操作失败"); }
    finally { setBusy(false); }
  }
  const status = turn.taskStatus;
  return <section className="gy-assignment-card" aria-label="任务回执">
    <div><strong>{status ? STATUS_LABEL[status] ?? status : submitting ? "正在提交任务" : "等待回执"}</strong>
      {turn.taskId && <a href={"#/live/" + turn.taskId}>任务 {turn.taskId.slice(0,8)}</a>}
    </div>
    {(turn.error || message) && <p role="status">{[turn.error, message].filter(Boolean).join(" · ")}</p>}
    {turn.taskId && status && active.has(status) && <Button size="small" loading={busy} onClick={() => void control("pause")}>暂停任务</Button>}
    {turn.taskId && status && ["paused","failed","stopped"].includes(status) && <Button size="small" loading={busy} onClick={() => void control("resume")}>继续任务</Button>}
    {!turn.taskId && !submitting && <Button size="small" onClick={() => onRetry(turn)}>重新提交</Button>}
  </section>;
}
