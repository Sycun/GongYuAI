import { Card, Col, Row, Typography } from "@douyinfe/semi-ui";
import type { Overview } from "../api";
import { TaskTable } from "../components/TaskTable";

type Props = {
  overview: Overview | null;
  onSelect: (taskId: string) => void;
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card
      shadows="hover"
      bodyStyle={{ padding: "16px 20px" }}
      style={{ background: "var(--semi-color-bg-1)" }}
    >
      <Typography.Text type="tertiary" size="small">
        {label}
      </Typography.Text>
      <div style={{ fontSize: 28, fontWeight: 650, marginTop: 4, lineHeight: 1.2 }}>{value}</div>
    </Card>
  );
}

export function OverviewPage({ overview, onSelect }: Props) {
  const o = overview ?? { total: 0, active: 0, byStatus: {}, recent: [] };
  const s = o.byStatus;

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Stat label="进行中" value={o.active} />
        </Col>
        <Col span={6}>
          <Stat label="已完成" value={s.completed ?? 0} />
        </Col>
        <Col span={6}>
          <Stat label="恢复中" value={s.recovering ?? 0} />
        </Col>
        <Col span={6}>
          <Stat label="全部任务" value={o.total} />
        </Col>
      </Row>
      <Card
        title="最近任务"
        style={{ background: "var(--semi-color-bg-1)" }}
        bodyStyle={{ paddingTop: 8 }}
      >
        <TaskTable tasks={o.recent} onSelect={onSelect} />
      </Card>
    </div>
  );
}
