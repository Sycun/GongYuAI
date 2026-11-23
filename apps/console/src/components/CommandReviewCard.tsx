import { useState } from "react";
import { Button } from "@douyinfe/semi-ui";
import type { CommandReviewView } from "@gongyuai/contracts/chat-input";
import { api } from "../api";
import { formatDateTime } from "../time";

const decisionLabels: Record<CommandReviewView["decision"], string> = {
  block: "已拦截",
  unavailable: "审批未完成",
  waiting: "等待你确认",
  executed: "已执行",
  failed: "执行失败",
  rejected: "已拒绝",
  cancelled: "已取消",
  expired: "已过期",
};

type Props = {
  taskId: string;
  review: CommandReviewView;
  /** 决定后由父级重读任务，卡片随之刷新。 */
  onDecided?: () => void;
};

/** 会话内命令审批卡：待确认时「允许本次 / 拒绝本次」，决定只绑定当前任务这一次调用。 */
export function CommandReviewCard({ taskId, review, onDecided }: Props) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  async function act(action: "approve" | "reject" | "retry") {
    if (busy) return;
    setBusy(action); setNote("");
    try {
      await api.commandReview(taskId, action);
    } catch (e) {
      // 重复点击或状态已变化：只回读结果，不重复执行。
      setNote(e instanceof Error ? e.message : "操作未完成，已回读最新状态。");
    } finally {
      setBusy("");
      onDecided?.();
    }
  }

  const subject = review.summary || review.tool;
  const detail = review.outcome || review.reason;
  return <section className={"gy-command-card gy-command-" + review.decision} aria-label="命令审批卡">
    <div className="gy-command-head">
      <strong>{decisionLabels[review.decision]}</strong>
      <small>{formatDateTime(review.at)}{review.model
        ? " · " + (review.model === "用户" ? "你的决定" : review.model)
        : " · 本地策略"}</small>
    </div>
    <p className="gy-command-subject">{review.tool === "shell" ? "命令" : "操作"}：{subject}</p>
    <p className="gy-command-reason">{detail}</p>
    {review.decision === "waiting" && <div className="gy-command-actions">
      <Button size="small" theme="solid" type="primary" loading={busy === "approve"}
        disabled={Boolean(busy)} onClick={() => void act("approve")}>允许本次</Button>
      <Button size="small" theme="light" type="danger" loading={busy === "reject"}
        disabled={Boolean(busy)} onClick={() => void act("reject")}>拒绝本次</Button>
      <small>只对当前任务的这一次调用生效。</small>
    </div>}
    {review.decision === "unavailable" && <div className="gy-command-actions">
      <Button size="small" theme="light" loading={busy === "retry"}
        disabled={Boolean(busy)} onClick={() => void act("retry")}>重试审批</Button>
      <small>审批模型不可用时命令已拦截，可稍后重试。</small>
    </div>}
    {note && <p role="status" className="gy-command-note">{note}</p>}
  </section>;
}
