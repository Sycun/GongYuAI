import { useEffect, useState } from "react";
import { Button, Card, Form, Table, Tag, Toast, Typography } from "@douyinfe/semi-ui";
import { api, type ReconcileResultPayload } from "../api";

const STATUS_LABEL: Record<string, string> = {
  added: "新增",
  removed: "移除",
  changed: "变更",
  unchanged: "未变",
  missing: "缺件",
  unknown: "未知",
};

const STATUS_COLOR: Record<string, "blue" | "orange" | "red" | "green" | "violet" | "grey"> = {
  added: "blue",
  removed: "orange",
  changed: "red",
  unchanged: "green",
  missing: "violet",
  unknown: "grey",
};

type FormValues = {
  baselinePath: string;
  currentPath: string;
  keyField: string;
  requiredKeys?: string;
};

/**
 * 原始材料差异核算（验收项 2 的正常用户入口）：操作员在控制台里选两份
 * 已导入的材料、写主键字段，平台从原始记录算新增/移除/变更/未变/缺件，
 * 结果定位到来源行与字段，并落成一份带 SHA-256 的证据。
 */
export function ReconcilePanel({ taskId, onDone }: { taskId: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReconcileResultPayload | null>(null);
  const [recent, setRecent] = useState<Array<{ factId: string; title: string; summary: string; evidencePath: string | null }>>([]);

  const loadRecent = async () => {
    try {
      const { json } = await api.reconcileResults(taskId);
      setRecent(json.results ?? []);
    } catch {
      /* 结果清单只是辅助信息 */
    }
  };

  useEffect(() => {
    void loadRecent();
  }, [taskId]);

  async function run(values: FormValues) {
    setBusy(true);
    try {
      const requiredKeys = (values.requiredKeys ?? "")
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const { json } = await api.reconcile(taskId, {
        name: "baseline-diff",
        baseline: { path: values.baselinePath.trim() },
        current: { path: values.currentPath.trim() },
        keyField: values.keyField.trim(),
        ...(requiredKeys.length ? { requiredKeys } : {}),
      });
      setOutcome(json);
      await loadRecent();
      onDone?.();
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="原始材料差异核算" style={{ background: "var(--semi-color-bg-1)" }}>
      <Form
        initValues={{ keyField: "host" }}
        onSubmit={(values) => void run(values as FormValues)}
      >
        <Form.Input field="baselinePath" label="基线材料（evidence/ 下相对路径）" rules={[{ required: true, message: "请填写基线材料路径" }]} />
        <Form.Input field="currentPath" label="当前材料（evidence/ 下相对路径）" rules={[{ required: true, message: "请填写当前材料路径" }]} />
        <Form.Input field="keyField" label="主键字段" rules={[{ required: true, message: "请填写主键字段" }]} />
        <Form.Input field="requiredKeys" label="约定检查项（逗号或换行分隔，可空）" />
        <Button htmlType="submit" loading={busy}>计算差异</Button>
      </Form>
      {outcome && (
        <div style={{ marginTop: 16 }}>
          <Typography.Paragraph>
            共 {outcome.result.counts.totalKeys} 项：新增 {outcome.result.counts.added}、移除{" "}
            {outcome.result.counts.removed}、变更 {outcome.result.counts.changed}、未变{" "}
            {outcome.result.counts.unchanged}、缺件 {outcome.result.counts.missing}、未知{" "}
            {outcome.result.counts.unknown}
            {outcome.result.missingMaterials.length
              ? ` · 缺失材料 ${outcome.result.missingMaterials.join("、")}`
              : ""}
          </Typography.Paragraph>
          <Typography.Paragraph type="tertiary" size="small">
            结果证据　{outcome.evidencePath} · SHA-256 {outcome.evidenceSha256}
          </Typography.Paragraph>
          <Table
            size="small"
            pagination={outcome.result.items.length > 20 ? { pageSize: 20 } : false}
            dataSource={outcome.result.items.map((item) => ({ ...item, key: item.key }))}
            columns={[
              { title: "主键", dataIndex: "key" },
              {
                title: "结论",
                dataIndex: "status",
                render: (value: string) => (
                  <Tag color={STATUS_COLOR[value] ?? "grey"} size="small">
                    {STATUS_LABEL[value] ?? value}
                  </Tag>
                ),
              },
              {
                title: "来源行（基线 / 当前）",
                dataIndex: "baselineLine",
                render: (_: unknown, record: { baselineLine: number | null; currentLine: number | null }) =>
                  `${record.baselineLine ?? "—"} / ${record.currentLine ?? "—"}`,
              },
              {
                title: "字段变化",
                dataIndex: "changes",
                render: (changes: Array<{ field: string; before: string | null; after: string | null }>) =>
                  changes.length
                    ? changes.map((change) => `${change.field}: ${change.before ?? "∅"} → ${change.after ?? "∅"}`).join("；")
                    : "—",
              },
            ]}
          />
        </div>
      )}
      {recent.length > 0 && (
        <Typography.Paragraph type="tertiary" size="small" style={{ marginTop: 12 }}>
          历次核算：{recent.map((entry) => `${entry.title}（${entry.evidencePath ?? "无证据"}）`).join(" · ")}
        </Typography.Paragraph>
      )}
    </Card>
  );
}
