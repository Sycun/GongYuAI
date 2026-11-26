import { formatDateTime } from "./time";

export const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  initializing: "初始化",
  running: "运行中",
  recovering: "恢复中",
  pause_requested: "正在暂停（收尾中）",
  paused: "已暂停",
  stopping: "正在停止（收尾中）",
  completed: "运行完成",
  failed: "失败",
  budget_exhausted: "预算耗尽",
  incomplete: "未完成退出",
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
  "pause_requested",
  "stopping",
]);

export const PAUSED_STATUSES = new Set(["paused"]);

export const STARTABLE_STATUSES = new Set([
  "stopped",
  "failed",
  "completed",
  "budget_exhausted",
  "incomplete",
]);

export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "budget_exhausted",
  "incomplete",
  "stopped",
]);

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isStartableStatus(status: string): boolean {
  return STARTABLE_STATUSES.has(status);
}

export function isPausedStatus(status: string): boolean {
  return PAUSED_STATUSES.has(status);
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 可归档条件单独定义：已暂停或已进入终态；归档只改标记，暂停任务仍可继续执行。 */
export function isArchivableStatus(status: string): boolean {
  return isPausedStatus(status) || isTerminalStatus(status);
}

export function isArchivedTask(task: { archivedAt?: string | null }): boolean {
  return Boolean(task.archivedAt);
}

export function formatWorkerStatus(ws: unknown): Array<{ key: string; value: string }> {
  if (!ws || typeof ws !== "object") {
    return [{ key: "状态", value: "暂无" }];
  }
  const o = ws as Record<string, unknown>;
  const usage = (o.usage ?? {}) as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status : "";
  const phase = typeof o.phase === "string" ? o.phase : "";
  const activeIntent =
    typeof o.activeIntentId === "string"
      ? o.activeIntentId
      : o.activeIntentId === null
        ? "—"
        : "";
  return [
    { key: "节点状态", value: (STATUS_LABEL[status] ?? status) || "—" },
    { key: "图相位", value: phase || "—" },
    {
      key: "活跃 Intent",
      value: activeIntent ? (activeIntent === "—" ? "—" : shortId(activeIntent)) : "—",
    },
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
      value: typeof o.updatedAt === "string" ? formatDateTime(o.updatedAt, true) : "—",
    },
    ...(typeof o.error === "string" && o.error
      ? [{ key: "错误", value: o.error }]
      : []),
  ];
}

export const ROUTE_META: Record<string, { title: string; subtitle: string }> = {
  overview: { title: "总览", subtitle: "系统态势 · 活跃任务与守护恢复" },
  tasks: { title: "任务工作台", subtitle: "单兵红队任务台账 · Fact–Intent–Goal 真相核 · 点选进入深潜" },
  live: { title: "运行态", subtitle: "相位 · 租约 · 预算 · 战术提示 · 待审批命令" },
  assets: { title: "资产与战场", subtitle: "授权靶标 · 主机画像 · 凭据 · 驻留会话 · 隧道 · 带外回调" },
  graph: { title: "意图图谱", subtitle: "目标契约 · 资产 → 事实 → 意图 → 漏洞 因果联动" },
  traffic: { title: "流量记录", subtitle: "HTTP/HTTPS 请求审计 · Raw 报文 · 复现 cURL" },
  findings: { title: "漏洞与报告", subtitle: "漏洞台账 · 独立复核 · 证据原件 · 交付报告" },
  logs: { title: "执行与日志", subtitle: "结构化步骤流 · 实时原始日志" },
  settings: { title: "设置", subtitle: "模型 · 资产 · MCP · Skill · Token · 更新" },
  "settings-model": { title: "模型配置", subtitle: "OpenAI 兼容 API · 视觉能力" },
  "settings-approval": { title: "命令审批", subtitle: "审批模型与风险范围" },
  graphs: { title: "图谱中心", subtitle: "跨视图投影（资产 · 攻击面 · 执行）" },
  demo: { title: "演示场景", subtitle: "离线标注演示（辅助视图，不调用控制面）" },
  knowledge: { title: "知识库", subtitle: "全局文档 · 导入与向量化 · 混合检索" },
  "settings-assets": {
    title: "资产收集",
    subtitle: "FOFA · 鹰图 · 自定义 API · AI 自动发现写入清单",
  },
  "settings-mcp": {
    title: "MCP",
    subtitle: "连接器目录 · 按需或启动时加载",
  },
  "settings-skills": {
    title: "Skill",
    subtitle: "独立渗透方法论包 · 开关控制是否注入",
  },
  "settings-usage": { title: "用量统计", subtitle: "Skill 与 MCP 调用 · Token 用量" },
  "settings-update": { title: "一键更新", subtitle: "GitHub 静默拉取 · 保留本机数据" },
  "settings-runtime": { title: "运行时", subtitle: "监听地址 · 控制台能力" },
};

export const DETAIL_TABS = [
  { key: "live", label: "运行态" },
  { key: "assets", label: "资产与战场" },
  { key: "graph", label: "意图图谱" },
  { key: "traffic", label: "流量记录" },
  { key: "findings", label: "漏洞与报告" },
  { key: "logs", label: "执行与日志" },
] as const;

export type DetailTab = (typeof DETAIL_TABS)[number]["key"];

/**
 * 旧版 10 Tab 的 hash 路由收敛到 6 Tab，避免历史链接断链。
 * 目标/历史 → 意图图谱；证据/报告/观察复核 → 漏洞与报告；执行记录 → 资产与战场。
 */
export const LEGACY_TAB_REDIRECTS: Record<string, DetailTab> = {
  goals: "graph",
  history: "graph",
  evidence: "findings",
  report: "findings",
  p14: "assets",
  p15: "findings",
};

export function resolveDetailTab(route: string): DetailTab | null {
  if (DETAIL_TABS.some((tab) => tab.key === route)) return route as DetailTab;
  return LEGACY_TAB_REDIRECTS[route] ?? null;
}

export const FINDING_STATUS_LABEL: Record<string, string> = {
  tentative: "线索",
  verified: "已复现",
  retested: "修复后复测",
  accepted: "接受风险",
  retracted: "已撤回",
};

export const FINDING_SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
};

export function findingSeverityColor(
  severity: string,
): "red" | "orange" | "yellow" | "blue" | "grey" {
  if (severity === "critical") return "red";
  if (severity === "high") return "orange";
  if (severity === "medium") return "yellow";
  if (severity === "low") return "blue";
  return "grey";
}

export function findingStatusColor(
  status: string,
): "green" | "orange" | "grey" | "red" | "blue" {
  if (status === "verified" || status === "retested") return "green";
  if (status === "tentative") return "orange";
  if (status === "accepted") return "blue";
  if (status === "retracted") return "red";
  return "grey";
}

export const ASSET_KIND_LABEL: Record<string, string> = {
  seed: "种子",
  candidate: "候选",
  admitted: "已准入",
  live: "存活",
  oos: "范围外",
};

/** 三档定级徽章：实战利用 > 主动确认 > 未确认线索。 */
export const FINDING_QUALIFICATION_LABEL: Record<string, string> = {
  exploited: "已实战利用",
  confirmed: "已主动确认",
  unconfirmed: "未确认线索",
};

export function findingQualificationColor(
  qualification: string,
): "red" | "green" | "orange" | "grey" {
  if (qualification === "exploited") return "red";
  if (qualification === "confirmed") return "green";
  if (qualification === "unconfirmed") return "orange";
  return "grey";
}

/** 缺 qualification 时按生命周期保守推导：已复现/复测/接受视为主动确认，其余为线索。 */
export function effectiveQualification(finding: {
  qualification?: string | null;
  status?: string;
}): "exploited" | "confirmed" | "unconfirmed" {
  if (finding.qualification === "exploited" || finding.qualification === "confirmed" || finding.qualification === "unconfirmed") {
    return finding.qualification;
  }
  if (finding.status === "verified" || finding.status === "retested" || finding.status === "accepted") {
    return "confirmed";
  }
  return "unconfirmed";
}

export const SETTINGS_SECTIONS = [
  { key: "settings-model", label: "模型配置", section: "model" },
  { key: "settings-approval", label: "命令审批", section: "approval" },
  { key: "settings-assets", label: "资产收集", section: "assets" },
  { key: "settings-mcp", label: "MCP", section: "mcp" },
  { key: "settings-skills", label: "Skill", section: "skills" },
  { key: "settings-usage", label: "用量统计", section: "usage" },
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
  if (status === "incomplete") return "orange";
  if (["title", "summary", "evidence"].includes(status)) return "blue";
  if (status === "pending") return "grey";
  return "grey";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
