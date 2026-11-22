import { useEffect, useState } from "react";
import { Card, Col, Descriptions, Row, Table, Tag, Typography } from "@douyinfe/semi-ui";
import { api, type ScorecardPayload } from "../api";
import { formatDateTime } from "../time";

const VERDICT_LABEL: Record<string, string> = {
  supported: "当前证据支持",
  "unsupported-no-evidence": "无有效证据",
  "supported-by-retracted-only": "唯一依据已撤回",
  "unknown-attribution": "原依据归属未知",
  "not-passed": "未通过",
};

const COVERAGE_LABEL: Record<string, string> = {
  tested: "已测",
  partial: "部分覆盖",
  blocked: "受阻",
  untested: "未测",
  unregistered: "未登记",
};

/**
 * 交付记分卡（验收项 3）：历史通过 / 当前证据支持 / 原依据归属未知 三个
 * 分子共用同一个分母；人工覆盖单独一栏（六类互斥）。统计时点与快照
 * SHA-256 一起显示，便于区分“实时读数”和“不可变凭据”。
 */
export function DeliveryScorecard({ taskId, refreshKey }: { taskId: string; refreshKey?: number }) {
  const [card, setCard] = useState<ScorecardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { json } = await api.scorecard(taskId);
        if (cancelled) return;
        setCard(json.scorecard);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, refreshKey]);

  if (error) {
    return (
      <Card title="交付记分卡" style={{ background: "var(--semi-color-bg-1)" }}>
        <Typography.Text type="danger">{error}</Typography.Text>
      </Card>
    );
  }
  if (!card) {
    return (
      <Card title="交付记分卡" style={{ background: "var(--semi-color-bg-1)" }}>
        加载中…
      </Card>
    );
  }

  return (
    <Card title="交付记分卡" style={{ background: "var(--semi-color-bg-1)" }}>
      <Row gutter={16}>
        <Col span={12}>
          <Descriptions
            align="left"
            data={[
              { key: "分母（本次约定目标总数）", value: card.applicable ? String(card.denominator) : "不适用" },
              {
                key: "历史通过",
                value: `${card.historicallyPassed} / ${card.denominator}`,
              },
              {
                key: "当前证据足以支持",
                value: `${card.currentlySupported} / ${card.denominator}`,
              },
              {
                key: "原依据归属未知",
                value: `${card.unknownAttribution} / ${card.denominator}`,
              },
              { key: "已撤回依据引用", value: `${card.retractedReferences} 条（非目标数）` },
            ]}
          />
        </Col>
        <Col span={12}>
          <Descriptions
            align="left"
            data={[
              {
                key: "人工覆盖（五类互斥，合计 = 分母）",
                value: [
                  `已测 ${card.coverage.tested}`,
                  `部分覆盖 ${card.coverage.partial}`,
                  `受阻 ${card.coverage.blocked}`,
                  `未测 ${card.coverage.untested}`,
                  `未登记 ${card.coverage.unregistered}`,
                ].join(" · "),
              },
              {
                key: "发现",
                value: `已验证 ${card.findings.verified} · 线索 ${card.findings.tentative} · 已撤回 ${card.findings.retracted}`,
              },
              { key: "统计时点", value: formatDateTime(card.capturedAt, true) },
              {
                key: "快照 SHA-256",
                value: (
                  <Typography.Text
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", wordBreak: "break-all" }}
                    size="small"
                  >
                    {card.snapshotSha256}
                  </Typography.Text>
                ),
              },
            ]}
          />
        </Col>
      </Row>
      <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 8 }}>
        统计时点是实时读数，每次刷新都会变；不可变凭据以快照文件的 SHA-256 为准。
        当前证据支持与人工覆盖是两个维度：覆盖充分不代表有发现，零发现也不证明覆盖。
      </Typography.Paragraph>
      <Table
        size="small"
        pagination={false}
        dataSource={card.goals.map((goal) => ({ ...goal, key: goal.goalId }))}
        columns={[
          { title: "目标", dataIndex: "goalId" },
          {
            title: "历史通过",
            dataIndex: "historicalPass",
            render: (value: boolean) => (value ? <Tag color="green" size="small">是</Tag> : <Tag size="small">否</Tag>),
          },
          {
            title: "当前证据支持",
            dataIndex: "currentSupported",
            render: (value: boolean) => (value ? <Tag color="green" size="small">是</Tag> : <Tag color="orange" size="small">否</Tag>),
          },
          {
            title: "判定",
            dataIndex: "verdict",
            render: (value: string) => VERDICT_LABEL[value] ?? value,
          },
          {
            title: "人工覆盖",
            dataIndex: "coverage",
            render: (value: string) => COVERAGE_LABEL[value] ?? value,
          },
        ]}
      />
    </Card>
  );
}
