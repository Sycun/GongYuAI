import { useEffect, useState } from "react";
import { Button } from "@douyinfe/semi-ui";
import type { AssignmentView, CommandReviewView } from "@gongyuai/contracts/chat-input";
import type { Turn } from "../chat/useConversations";
import { STATUS_LABEL } from "../labels";
import { CommandReviewCard } from "./CommandReviewCard";

type Props = { turn: Turn; submitting: boolean; onTask: (t: Turn, view: AssignmentView) => void; onRetry?: (t: Turn) => void };
const active = new Set(["queued", "running", "initializing"]);
export function AssignmentCard({ turn, submitting, onTask, onRetry }: Props) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<CommandReviewView | undefined>();
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
        setMessage(""); setReview(view.commandReview); onTask(turn, view);
        if (!active.has(view.status) && view.status !== "paused" && view.status !== "failed" && view.status !== "stopped") return;
        timer = window.setTimeout(refresh, active.has(view.status) ? 1000 : 12000);
      } catch {
        if (!controller.signal.aborted) { setMessage("任务状态暂不可用"); timer = window.setTimeout(refresh, 3000); }
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [turn, submitting, onTask, attempt]);
  async function control(action: "pause" | "resume") {
    const path = "/tasks/" + turn.taskId + "/" + action;
    setBusy(action);
    setMessage("实际请求：POST " + path);
    try {
      const res = await fetch(path, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "任务操作失败");
      const again = await fetch("/tasks/" + turn.taskId);
      const read = await again.json().catch(() => ({}));
      setMessage(`实际请求：POST ${path}。回读状态：${read.task?.status ?? body.task?.status ?? "未记录"}`);
      setAttempt(n => n + 1);
    } catch (e) { setMessage(`实际请求：POST ${path}。${e instanceof Error ? e.message : "任务操作失败"}`); }
    finally { setBusy(""); }
  }
  const status = turn.taskStatus;
  const pauseLabel = busy === "pause" ? "正在请求" : "暂停";
  const resumeLabel = busy === "resume" ? "正在请求" : "继续";
  const waitingApproval = review?.decision === "waiting";
  return <section className="gy-assignment-card" aria-label="任务回执">
    <header><strong>任务回执</strong>
      <span>{status ? STATUS_LABEL[status] ?? status : submitting ? "正在提交" : waitingApproval ? "等待你确认" : turn.taskId ? "已接收" : "尚未收到回执"}</span>
    </header>
    <p className="gy-receipt-summary">{turn.taskId
      ? <>任务已提交 · <a href={"#/live/" + turn.taskId} title={turn.taskId}>查看任务 {turn.taskId.slice(0, 8)}</a></>
      : "本轮内容已保存在会话中。"}</p>
    {review && turn.taskId && <CommandReviewCard taskId={turn.taskId} review={review} onDecided={() => setAttempt(n => n + 1)} />}
    {(turn.error || message) && !waitingApproval && <p role="status">{[turn.error, message].filter(Boolean).join(" · ")}</p>}
    {turn.taskId && status && active.has(status) && <Button size="small" title={`暂停任务 ${turn.taskId}`} loading={busy === "pause"} onClick={() => void control("pause")}>{pauseLabel}</Button>}
    {turn.taskId && status && ["paused","failed","stopped"].includes(status) && !waitingApproval && <Button size="small" title={`继续任务 ${turn.taskId}`} loading={busy === "resume"} onClick={() => void control("resume")}>{resumeLabel}</Button>}
    {!turn.taskId && !submitting && onRetry && <Button size="small" onClick={() => onRetry(turn)}>重新提交</Button>}
  </section>;
}
