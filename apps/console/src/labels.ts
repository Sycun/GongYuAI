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
  pending: "未完成",
  proposed: "已提出",
  claimed: "已认领",
  succeeded: "成功",
  expired: "已过期",
  title: "标题",
  summary: "摘要",
  evidence: "证据",
};

export const ACTIVE_STATUSES = new Set([
  "queued",
  "initializing",
  "running",
  "recovering",
]);

export const STARTABLE_STATUSES = new Set([
  "stopped",
  "failed",
  "completed",
  "budget_exhausted",
]);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isStartableStatus(status: string): boolean {
  return STARTABLE_STATUSES.has(status);
}

export function formatWorkerStatus(ws: unknown): Array<{ key: string; value: string }> {
  if (!ws || typeof ws !== "object") {
    return [{ key: "状态", value: "暂无" }];
  }
  const o = ws as Record<string, unknown>;
  const usage = (o.usage ?? {}) as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status : "";
  return [
    { key: "节点状态", value: (STATUS_LABEL[status] ?? status) || "—" },
    {
      key: "Token",
      value: String(usage.tokens ?? 0),
    },
    {
      key: "工具调用",
      value: String(usage.toolCalls ?? 0),
    },
    {
      key: "安装次数",
      value: String(usage.installs ?? 0),
    },
    {
      key: "更新时间",
      value: typeof o.updatedAt === "string" ? o.updatedAt : "—",
    },
    ...(typeof o.error === "string" && o.error
      ? [{ key: "错误", value: o.error }]
      : []),
  ];
}

export const ROUTE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "总览", subtitle: "系统态势 · 活跃任务与恢复" },
  tasks: { title: "任务", subtitle: "任务列表 · 点选进入深潜" },
  live: { title: "运行态", subtitle: "租约 / 检查点 / 预算" },
  assets: { title: "资产", subtitle: "授权靶标 · 运行中发现 · 与 AI 同表" },
  goals: { title: "目标", subtitle: "证据闸门 · Fact–Intent DAG" },
  history: { title: "历史", subtitle: "Fact–Intent DAG · 分层事实" },
  evidence: { title: "证据", subtitle: "证据文件" },
  report: { title: "报告", subtitle: "任务报告" },
  logs: { title: "日志", subtitle: "执行节点日志" },
  settings: { title: "设置", subtitle: "模型 · Token · 静默更新" },
  "settings-model": { title: "模型配置", subtitle: "OpenAI 兼容 API · 视觉能力" },
  "settings-assets": {
    title: "资产收集",
    subtitle: "FOFA · 鹰图 · 自定义 API · AI 自动发现写入清单",
  },
  "settings-tools": { title: "工具增强", subtitle: "MCP · Skill" },
  "settings-mcp": {
    title: "MCP",
    subtitle: "按工具拆分的 Kali 渗透 MCP · 开关控制模型可见性",
  },
  "settings-skills": {
    title: "Skill",
    subtitle: "独立渗透方法论包 · 开关控制是否注入",
  },
  "settings-usage": { title: "Token 统计", subtitle: "累计用量 · 按任务明细" },
  "settings-update": { title: "一键更新", subtitle: "GitHub 静默拉取 · 保留本机数据" },
  "settings-runtime": { title: "运行时", subtitle: "监听地址 · 控制台能力" },
};

export const DETAIL_TABS = [
  { key: "live", label: "运行态" },
  { key: "assets", label: "资产" },
  { key: "goals", label: "目标" },
  { key: "history", label: "历史" },
  { key: "evidence", label: "证据" },
  { key: "report", label: "报告" },
  { key: "logs", label: "日志" },
] as const;

export const ASSET_KIND_LABEL: Record<string, string> = {
  seed: "种子",
  candidate: "候选",
  admitted: "已准入",
  live: "存活",
  oos: "范围外",
};

export type DetailTab = (typeof DETAIL_TABS)[number]["key"];

export const SETTINGS_SECTIONS = [
  { key: "settings-model", label: "模型配置", section: "model" },
  { key: "settings-assets", label: "资产收集", section: "assets" },
  { key: "settings-mcp", label: "MCP", section: "mcp" },
  { key: "settings-skills", label: "Skill", section: "skills" },
  { key: "settings-usage", label: "Token 统计", section: "usage" },
  { key: "settings-update", label: "一键更新", section: "update" },
  { key: "settings-runtime", label: "运行时", section: "runtime" },
] as const;

export type SettingsRoute = (typeof SETTINGS_SECTIONS)[number]["key"];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["section"];

export function isSettingsRoute(
  route: string,
): route is SettingsRoute | "settings" | "settings-tools" {
  return (
    route === "settings" ||
    route === "settings-tools" ||
    SETTINGS_SECTIONS.some((s) => s.key === route)
  );
}

export function settingsSectionOf(route: string): SettingsSection {
  const hit = SETTINGS_SECTIONS.find((s) => s.key === route);
  return hit?.section ?? "model";
}

export function statusColor(status: string): "green" | "orange" | "red" | "grey" | "blue" {
  if (["completed", "ok", "succeeded"].includes(status)) return "green";
  if (["running", "initializing", "recovering", "queued", "claimed", "proposed"].includes(status)) {
    return "orange";
  }
  if (["failed", "budget_exhausted", "stopped", "expired"].includes(status)) return "red";
  if (["title", "summary", "evidence"].includes(status)) return "blue";
  if (status === "pending") return "grey";
  return "grey";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
