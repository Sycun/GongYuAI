import { useState } from "react";
import { Button, Input } from "@douyinfe/semi-ui";
import { probeMessage, useProbe } from "../workspace/useProbe";

type TodayTask = {
  taskId?: string;
  name?: string;
  status?: string;
  scopeVersion?: number;
  runningJobs?: number;
  openQuestions?: number;
  blockedGoals?: number;
  staleFacts?: number;
  nextAction?: string;
  consultId?: string;
};

export function TodayWork({ onOpen }: { onOpen: (href: string) => void }) {
  const [tenantId, setTenantId] = useState("");
  const [engagementId, setEngagementId] = useState("");
  const [applied, setApplied] = useState({ tenantId: "", engagementId: "" });
  const [reload, setReload] = useState(0);
  const params = new URLSearchParams();
  if (applied.tenantId) params.set("tenantId", applied.tenantId);
  if (applied.engagementId) params.set("engagementId", applied.engagementId);
  const path = `/today${params.toString() ? `?${params.toString()}` : ""}`;
  const state = useProbe<{ tasks?: TodayTask[] }>(path, reload);
  const tasks = state?.ok ? state.json.tasks ?? [] : [];
  const message = state?.ok ? (tasks.length ? null : "今天没有记下的委托。") : probeMessage(state, "");

  return (
    <section className="gy-today" aria-label="今日工作">
      <header>
        <h2>今日工作</h2>
        <form onSubmit={(event) => {
          event.preventDefault();
          setApplied({ tenantId: tenantId.trim(), engagementId: engagementId.trim() });
          setReload((value) => value + 1);
        }}>
          <Input aria-label="tenantId" placeholder="tenantId" value={tenantId} onChange={setTenantId} />
          <Input aria-label="engagementId" placeholder="engagementId" value={engagementId} onChange={setEngagementId} />
          <Button htmlType="submit" size="small">筛选</Button>
        </form>
      </header>
      {message && <p role="status">{message}</p>}
      {tasks.map((task) => {
        const id = task.taskId || "";
        const href = task.consultId
          ? `#/live/${encodeURIComponent(id)}?consult=${encodeURIComponent(task.consultId)}`
          : task.openQuestions
            ? `#/live/${encodeURIComponent(id)}?section=consults`
            : `#/live/${encodeURIComponent(id)}`;
        return (
          <button type="button" key={id || task.name} className="gy-today-row" disabled={!id} onClick={() => id && onOpen(href)}>
            <b>{task.name || id}</b>
            <span>{task.status || "状态未记录"} · 范围 v{task.scopeVersion ?? "—"} · 在跑作业 {task.runningJobs ?? 0} · 待答 {task.openQuestions ?? 0} · 缺件/未通过 {task.blockedGoals ?? 0}{typeof task.staleFacts === "number" ? ` · 待复核事实 ${task.staleFacts}` : ""}</span>
            <small>{task.nextAction || "下一步未记录"}</small>
          </button>
        );
      })}
    </section>
  );
}
