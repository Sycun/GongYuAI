import { Card, Space, Typography } from "@douyinfe/semi-ui";

const cardStyle = { background: "var(--semi-color-bg-1)", maxWidth: 720 } as const;

export function SettingsRuntimePanel() {

    return (
      <Card title="运行时" style={cardStyle}>
        <Space vertical align="start">
          <Typography.Text>监听 {window.location.host || "0.0.0.0:8877"}</Typography.Text>
          <Typography.Text type="tertiary">
            长程任务控制台 · 检查点 + 租约/栅栏 · 证据闸门 · Semi Design
          </Typography.Text>
        </Space>
      </Card>
    );
}
