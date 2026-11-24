import { useEffect, useState } from "react";
import { Card, Empty, Table, Tag, Typography } from "@douyinfe/semi-ui";
import type { EngagementAudit, FindingValidation } from "@gongyuai/contracts";
import { api } from "../api";
import { formatDateTime } from "../time";

const VERDICT_LABEL: Record<string, string> = {
  confirmed: "独立确认",
  refuted: "已推翻",
  inconclusive: "无法判定",
  "out-of-scope": "超出授权",
};

const VERDICT_COLOR: Record<string, "green" | "red" | "grey" | "orange"> = {
  confirmed: "green",
  refuted: "red",
  inconclusive: "grey",
  "out-of-scope": "orange",
};

/** P15 — 观察员记分卡 + 独立确认台账（只读）。 */
export function P15Panel({ taskId }: { taskId: string }) {
  const [audit, setAudit] = useState<EngagementAudit | null>(null);
  const [validations, setValidations] = useState<FindingValidation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api.getAudit(taskId, controller.signal),
      api.getValidations(taskId, undefined, controller.signal),
    ])
      .then(([nextAudit, nextValidations]) => {
        setAudit(nextAudit.json);
        setValidations(nextValidations.json.validations);
        setError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => controller.abort();
  }, [taskId]);

  if (error) {
    return <Card title="观察与复核">读取失败：{error}</Card>;
  }
  if (!audit) {
    return <Card title="观察与复核">正在读取…</Card>;
  }

  const { scorecard } = audit;
  const rate = scorecard.findings.confirmationRate;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="作业记分卡">
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Typography.Text>
            资产 <strong>{scorecard.assets.total}</strong>（高权重 {scorecard.assets.highWeight} / 未触碰 {scorecard.assets.untouched}）
          </Typography.Text>
          <Typography.Text>
            Intent <strong>{scorecard.intents.total}</strong>（open {scorecard.intents.open} / failed {scorecard.intents.failed}）
          </Typography.Text>
          <Typography.Text>
            Finding <strong>{scorecard.findings.total}</strong>（确认 {scorecard.findings.confirmed} / 待验 {scorecard.findings.tentative} / 撤回 {scorecard.findings.contradicted}）
          </Typography.Text>
          <Typography.Text>
            确认率 <strong>{rate == null ? "—" : `${Math.round(rate * 100)}%`}</strong>
            （独立 {scorecard.findings.independentlyConfirmed} 条）
          </Typography.Text>
        </div>
        {scorecard.findings.gaps.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {scorecard.findings.gaps.map((gap) => (
              <Tag key={gap} color="orange" style={{ marginRight: 8 }}>{gap}</Tag>
            ))}
          </div>
        )}
      </Card>

      <Card title="观察员（建议层，不派单）">
        {audit.observations.length === 0 ? (
          <Empty description="无重复失败 / 重复派单 / 停滞 / 未经营高权重资产" />
        ) : (
          <Table
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={audit.observations}
            columns={[
              { title: "级别", dataIndex: "severity", width: 80, render: (value: string) => <Tag color={value === "warn" ? "red" : "blue"}>{value}</Tag> },
              { title: "规则", dataIndex: "code", width: 170 },
              { title: "建议", dataIndex: "text" },
            ]}
          />
        )}
      </Card>

      <Card title={`独立确认台账（${validations.length}）`}>
        {validations.length === 0 ? (
          <Empty description="尚无独立确认；high/critical 交付前应由另一 worker 或操作员 finding_validate" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={validations}
            columns={[
              { title: "结论", dataIndex: "verdict", width: 100, render: (value: string) => <Tag color={VERDICT_COLOR[value] ?? "grey"}>{VERDICT_LABEL[value] ?? value}</Tag> },
              { title: "方法", dataIndex: "method", width: 130 },
              { title: "复核者", dataIndex: "validator", width: 160 },
              { title: "独立", dataIndex: "independent", width: 70, render: (value: boolean) => (value ? "是" : "否") },
              { title: "时间", dataIndex: "createdAt", width: 180, render: (value: string) => formatDateTime(value, true) },
              { title: "说明", dataIndex: "note" },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
