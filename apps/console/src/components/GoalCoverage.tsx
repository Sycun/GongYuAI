import { useState } from "react";
import { Button, Form, Toast, Typography } from "@douyinfe/semi-ui";
import { coverageLabels } from "@gongyuai/contracts/coverage";
import type { CoverageReview, CoverageReviewInput } from "@gongyuai/contracts";
import { api } from "../api";
import { formatDateTime } from "../time";

type Props = {
  taskId: string;
  goalId: string;
  record?: CoverageReview;
  onSaved: (record: CoverageReview) => void;
};

export function GoalCoverage({ taskId, goalId, record, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save(values: Omit<CoverageReviewInput, "goalId">) {
    setSaving(true);
    try {
      const { json } = await api.recordCoverage(taskId, {
        goalId, status: values.status, reviewer: values.reviewer, reason: values.reason,
        evidencePath: values.evidencePath?.trim() || undefined,
      });
      onSaved(json.coverage);
      setEditing(false);
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Typography.Paragraph>
        人工覆盖　{record ? coverageLabels[record.status] : "未知"}
        {record && <> · {record.reviewer} · {formatDateTime(record.createdAt)}<br />{record.reason}</>}
      </Typography.Paragraph>
      {record?.sha256 && (
        <a href={`/tasks/${encodeURIComponent(taskId)}/report-evidence/${record.sha256}`} download>
          下载复核时的证据
        </a>
      )}
      {editing ? (
        <Form initValues={{ status: record?.status, reviewer: record?.reviewer }} onSubmit={(v) => void save(v as Omit<CoverageReviewInput, "goalId">)}>
          <Form.Select field="status" label="覆盖状态" rules={[{ required: true, message: "请选择覆盖状态" }]}
            optionList={Object.entries(coverageLabels).map(([value, label]) => ({ value, label }))} />
          <Form.Input field="reviewer" label="复核人" rules={[{ required: true, message: "请填写署名" }]} />
          <Form.TextArea field="reason" label="覆盖范围、依据或受阻原因" rules={[{ required: true, message: "请填写依据" }]} />
          <Form.Input field="evidencePath" label="证据相对路径" extraText="已测和部分覆盖须提供 evidence/ 下的文件。" />
          <Button htmlType="submit" loading={saving}>保存记录</Button>
          <Button disabled={saving} onClick={() => setEditing(false)}>取消</Button>
        </Form>
      ) : <Button size="small" onClick={() => setEditing(true)}>记录覆盖</Button>}
    </div>
  );
}
