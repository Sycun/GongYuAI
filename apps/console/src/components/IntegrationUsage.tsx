import { useState } from "react";
import { Button, Card, Table, Typography } from "@douyinfe/semi-ui";
import {
  integrationSuccessRate, totalIntegrationCalls,
  type IntegrationCounts, type ProjectIntegrationUsage, type TaskIntegrationUsage,
} from "@gongyuai/contracts/integration-usage";
import { formatDateTime } from "../time";

type Usage = ProjectIntegrationUsage | TaskIntegrationUsage;
type DisplayRow = IntegrationCounts & { id: string; label: string };

export function IntegrationUsage({ usage }: { usage?: Usage }) {
  const [expanded, setExpanded] = useState(false);
  const rows: DisplayRow[] = [];
  let coverage = "尚未取得调用统计";
  if (usage) {
    const project = "tracked" in usage;
    coverage = project
      ? `已采集 ${usage.tracked} / ${usage.tasks} 个任务，按各任务采集期间累计${usage.unreadable ? ` · ${usage.unreadable} 个任务读取失败` : ""}`
      : usage.since ? `自 ${formatDateTime(usage.since, true)} 起采集` : "此任务没有逐次调用统计";
    if (project ? usage.tracked > 0 : usage.since !== null) {
      for (const kind of ["skill", "mcp"] as const) {
        const items = usage.rows.filter((item) => item.kind === kind);
        rows.push({ id: kind, label: kind === "skill" ? "Skill 合计" : "MCP 合计", ...totalIntegrationCalls(items) });
        if (expanded) {
          for (const item of items) {
            rows.push({ ...item, id: JSON.stringify([kind, item.name, item.method]),
              label: [item.name || "未提供名称", item.method].filter(Boolean).join(" / ") });
          }
        }
      }
    }
  }
  return (
    <Card title="Skill 与 MCP 调用" headerExtraContent={usage?.rows.length ? (
      <Button size="small" theme="borderless" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "收起明细" : "展开明细"}
      </Button>
    ) : undefined}>
      <Typography.Text type="tertiary" size="small">{coverage}</Typography.Text>
      {rows.length > 0 && <>
        <Table<DisplayRow> size="small" rowKey="id" pagination={false} scroll={{ x: 590 }}
          style={{ margin: "10px 0" }} dataSource={rows} columns={[
            { title: "名称", dataIndex: "label" },
            { title: "调用", dataIndex: "calls", width: 66 },
            { title: "成功", dataIndex: "succeeded", width: 66 },
            { title: "失败", dataIndex: "failed", width: 66 },
            { title: "待定", width: 66, render: (_, r) => r.calls - r.succeeded - r.failed },
            { title: "成功率", width: 84, render: (_, r) => integrationSuccessRate(r) },
          ]} />
        <Typography.Text type="tertiary" size="small">
          Skill 按正文加载计次，MCP 按进入工具调用入口计次。成功率 = 成功 ÷（成功 + 失败）。待定表示尚无结果。
        </Typography.Text>
      </>}
    </Card>
  );
}
