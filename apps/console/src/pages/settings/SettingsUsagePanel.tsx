import { Button, Card, Col, Row, Table, Toast, Typography } from "@douyinfe/semi-ui";
import { IconRefresh } from "@douyinfe/semi-icons";
import type { UsageStats } from "../../api";
import { IntegrationUsage } from "../../components/IntegrationUsage";

const cardStyle = { background: "var(--semi-color-bg-1)", maxWidth: 720 } as const;

function formatNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

export function SettingsUsagePanel({
  usage,
  loading,
  reload,
}: {
  usage: UsageStats;
  loading: boolean;
  reload: () => Promise<unknown>;
}) {
  const totals = usage.totals ?? { tokens: 0, toolCalls: 0, installs: 0, tasks: 0 };

        return (
      <div style={{ display: "grid", gap: 16 }}>
        <IntegrationUsage usage={usage.integrations} />
        <Card title="Token 统计" style={cardStyle}>
          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={12}>
              <Typography.Text type="tertiary" size="small">
                累计 Token
              </Typography.Text>
              <div style={{ fontSize: 26, fontWeight: 650 }}>{formatNum(totals.tokens)}</div>
            </Col>
            <Col span={12}>
              <Typography.Text type="tertiary" size="small">
                工具调用 / 安装
              </Typography.Text>
              <div style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>
                {formatNum(totals.toolCalls)} / {formatNum(totals.installs)}
              </div>
            </Col>
          </Row>
          <Typography.Text type="tertiary" size="small">
            任务数 {totals.tasks}
          </Typography.Text>
          <Table
            style={{ marginTop: 12 }}
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={usage.byTask ?? []}
            empty="暂无用量"
            columns={[
              { title: "任务", dataIndex: "name", ellipsis: true },
              { title: "Token", dataIndex: "tokens", width: 90, render: (v: number) => formatNum(v) },
              { title: "工具", dataIndex: "toolCalls", width: 70 },
            ]}
          />
          <Button
            icon={<IconRefresh />}
            theme="borderless"
            style={{ marginTop: 8 }}
            loading={loading}
            onClick={() => void reload().catch((e) => Toast.error(e instanceof Error ? e.message : String(e)))}
          >
            刷新用量
          </Button>
        </Card>
      </div>
    );
}
