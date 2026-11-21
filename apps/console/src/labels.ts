export const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  initializing: "初始化",
  running: "运行中",
  recovering: "恢复中",
  completed: "已完成",
  failed: "失败",
  budget_exhausted: "预算耗尽",
  stopped: "已停止",
  ok: "通过",
  proposed: "已提出",
  claimed: "已认领",
  succeeded: "成功",
  expired: "已过期",
  title: "标题",
  summary: "摘要",
  evidence: "证据",
};

export const ROUTE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "总览", subtitle: "系统态势 · 活跃任务与恢复" },
  tasks: { title: "任务", subtitle: "任务列表 · 点选进入深潜" },
  live: { title: "运行态", subtitle: "租约 / 检查点 / 预算" },
  goals: { title: "目标", subtitle: "证据闸门清单" },
  history: { title: "历史", subtitle: "分层事实 / 意图" },
  evidence: { title: "证据", subtitle: "证据文件" },
  report: { title: "报告", subtitle: "任务报告" },
  logs: { title: "日志", subtitle: "执行节点日志" },
  settings: { title: "设置", subtitle: "模型 · Token · 静默更新" },
};

export const DETAIL_TABS = [
  { key: "live", label: "运行态" },
  { key: "goals", label: "目标" },
  { key: "history", label: "历史" },
  { key: "evidence", label: "证据" },
  { key: "report", label: "报告" },
  { key: "logs", label: "日志" },
] as const;

export type DetailTab = (typeof DETAIL_TABS)[number]["key"];

export function statusColor(status: string): "green" | "orange" | "red" | "grey" | "blue" {
  if (["completed", "ok", "succeeded"].includes(status)) return "green";
  if (["running", "initializing", "recovering", "queued", "claimed", "proposed"].includes(status)) {
    return "orange";
  }
  if (["failed", "budget_exhausted", "stopped", "expired"].includes(status)) return "red";
  if (["title", "summary", "evidence"].includes(status)) return "blue";
  return "grey";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
