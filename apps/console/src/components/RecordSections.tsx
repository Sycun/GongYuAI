import { Empty, Table, Tag, Typography } from "@douyinfe/semi-ui";
import type { FindingRetest, PlanStep } from "@gongyuai/contracts";
import { shortId } from "../labels";
import { formatDateTime } from "../time";

const PLAN_STATUS_LABEL: Record<string, string> = {
  pending: "待处理", ready: "可执行", dispatched: "已派发", done: "完成", blocked: "受阻",
};
const PLAN_STATUS_COLOR: Record<string, "grey" | "blue" | "orange" | "green" | "red"> = {
  pending: "grey", ready: "blue", dispatched: "orange", done: "green", blocked: "red",
};
const RETEST_VERDICT_LABEL: Record<string, string> = {
  reproduced: "仍可复现", fixed: "已修复", inconclusive: "无法判定",
};
const RETEST_VERDICT_COLOR: Record<string, "red" | "green" | "grey"> = {
  reproduced: "red", fixed: "green", inconclusive: "grey",
};

function planDependencyCount(step: PlanStep): number {
  return step.needsFactIds.length + step.needsIntentIds.length + step.needsFindingIds.length;
}

/** 计划步骤（只读）：ord / 状态 / 标题 / 依赖；状态由系统派生，步骤本身不派发。 */
export function PlanSection({ rows }: { rows: PlanStep[] }) {
  if (!rows.length) return <Empty description="暂无计划步骤" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small" rowKey="id" dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      expandedRowRender={(record?: PlanStep) => record ? (
        <div style={{ padding: "8px 16px" }}>
          <Typography.Paragraph size="small" style={{ margin: 0 }}>摘要：{record.summary || "—"}</Typography.Paragraph>
          <Typography.Paragraph size="small" style={{ margin: 0 }}>关联 Intent：{record.intentId ? shortId(record.intentId) : "—"}</Typography.Paragraph>
          <Typography.Paragraph type="tertiary" size="small" style={{ margin: 0 }}>更新时间：{formatDateTime(record.updatedAt, true)}</Typography.Paragraph>
        </div>
      ) : null}
      columns={[
        { title: "序号", dataIndex: "ord", width: 70 },
        { title: "状态", dataIndex: "status", width: 100, render: (s: string) => <Tag color={PLAN_STATUS_COLOR[s] ?? "grey"} size="small">{PLAN_STATUS_LABEL[s] ?? s}</Tag> },
        { title: "标题", dataIndex: "title", render: (t: string) => <Typography.Text style={{ wordBreak: "break-all" }}>{t}</Typography.Text> },
        { title: "依赖数", dataIndex: "needsFactIds", width: 220, render: (_ids: string[], record: PlanStep) => (
          <Typography.Text type="tertiary" size="small">
            {planDependencyCount(record)}（事实 {record.needsFactIds.length} · Intent {record.needsIntentIds.length} · Finding {record.needsFindingIds.length}）
          </Typography.Text>
        ) },
      ]}
    />
  );
}

/** 修复后复测（只读）：verdict 与关联 finding 对应，证据哈希在展开行。 */
export function RetestsSection({ rows }: { rows: FindingRetest[] }) {
  if (!rows.length) return <Empty description="暂无复测记录" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small" rowKey="id" dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      expandedRowRender={(record?: FindingRetest) => record ? (
        <div style={{ padding: "8px 16px" }}>
          <Typography.Paragraph size="small" style={{ margin: 0 }}>复现步骤：{record.repro || "—"}</Typography.Paragraph>
          <Typography.Paragraph size="small" style={{ margin: 0 }}>备注：{record.note || "—"}</Typography.Paragraph>
          <Typography.Paragraph size="small" style={{ margin: 0 }}>关联 Finding：<Typography.Text code>{record.findingId}</Typography.Text></Typography.Paragraph>
          <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0 4px" }}>封存证据</Typography.Paragraph>
          {record.evidence.length ? record.evidence.map((entry) => (
            <div key={`${entry.path}:${entry.sha256}`} style={{ wordBreak: "break-all" }}>
              <Typography.Text code size="small">{entry.path}</Typography.Text>
              <Typography.Text type="tertiary" size="small"> SHA-256 {entry.sha256}</Typography.Text>
            </div>
          )) : <Typography.Text type="tertiary" size="small">暂无封存证据</Typography.Text>}
        </div>
      ) : null}
      columns={[
        { title: "结论", dataIndex: "verdict", width: 110, render: (v: string) => <Tag color={RETEST_VERDICT_COLOR[v] ?? "grey"} size="small">{RETEST_VERDICT_LABEL[v] ?? v}</Tag> },
        { title: "关联 Finding", dataIndex: "findingId", width: 300, render: (id: string) => <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{id}</Typography.Text> },
        { title: "复测人", dataIndex: "reviewer", width: 130 },
        { title: "时间", dataIndex: "createdAt", width: 170, render: (at: string) => formatDateTime(at, true) },
      ]}
    />
  );
}