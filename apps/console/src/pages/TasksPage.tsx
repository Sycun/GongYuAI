import { useState } from "react";
import {
  Button,
  Card,
  Form,
  SideSheet,
  Space,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { IconPlus } from "@douyinfe/semi-icons";
import { api, type TaskRecord } from "../api";
import { TaskTable } from "../components/TaskTable";

type Props = {
  tasks: TaskRecord[];
  onSelect: (taskId: string) => void;
  onCreated: (taskId: string) => void;
};

type FormValues = {
  target: string;
  objective: string;
};

function hostHint(target: string): string {
  try {
    return new URL(target).hostname || target;
  } catch {
    return target.replace(/^https?:\/\//, "").split("/")[0] || target;
  }
}

/** 把自然语言目标拆成 GoalSpec；多行则一行一个 */
function goalsFromObjective(objective: string) {
  const lines = objective
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const items = lines.length ? lines : [objective.trim() || "完成授权范围内的安全评估"];
  return items.map((line, i) => ({
    id: items.length === 1 ? "main" : `g${i + 1}`,
    title: items.length === 1 ? "主目标" : `目标 ${i + 1}`,
    description: line,
    evidencePatterns: ["**/*"],
  }));
}

export function TasksPage({ tasks, onSelect, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: FormValues) => {
    const target = values.target.trim();
    const objective = values.objective.trim();
    if (!target || !objective) {
      Toast.error("请填写靶标和目标");
      return;
    }

    const hint = hostHint(target);
    setSubmitting(true);
    try {
      const r = await api.createTask({
        name: hint,
        mock: false,
        auth: {
          authorizationNote: `已授权评估：${hint}（操作者自有/书面授权）`,
          targets: [target],
          outOfScope: [],
        },
        goals: goalsFromObjective(objective),
        budget: {
          maxTokens: 2_000_000,
          maxWallMs: 600_000,
          maxToolCalls: 200,
          maxInstalls: 20,
        },
      });
      Toast.success(`已创建并启动 · ${r.json.task.name}`);
      setOpen(false);
      onCreated(r.json.task.id);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          marginBottom: 16,
        }}
      >
        <Button theme="solid" icon={<IconPlus />} onClick={() => setOpen(true)}>
          新建任务
        </Button>
      </div>

      <Card style={{ background: "var(--semi-color-bg-1)" }} bodyStyle={{ paddingTop: 8 }}>
        <TaskTable tasks={[...tasks].reverse()} onSelect={onSelect} />
      </Card>

      <SideSheet
        title="新建任务"
        visible={open}
        onCancel={() => setOpen(false)}
        width={420}
        footer={
          <Space style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button theme="solid" loading={submitting} htmlType="submit" form="create-task-form">
              开始
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="tertiary" style={{ marginTop: 0, marginBottom: 20 }}>
          填靶标和要达成的目标即可；授权说明、预算等用默认配置自动启动。
        </Typography.Paragraph>
        <Form
          id="create-task-form"
          labelPosition="top"
          initValues={{
            target: "",
            objective: "",
          }}
          onSubmit={(v) => void submit(v as FormValues)}
        >
          <Form.Input
            field="target"
            label="靶标"
            placeholder="https://example.com 或 host / CIDR"
            rules={[{ required: true, message: "必填" }]}
            extraText="作业范围，仅允许在此目标内执行"
          />
          <Form.TextArea
            field="objective"
            label="目标"
            placeholder={"例如：完成站点基础信息收集，并输出简要发现说明\n多行则按行拆成多个目标"}
            autosize={{ minRows: 5, maxRows: 10 }}
            rules={[{ required: true, message: "必填" }]}
          />
        </Form>
      </SideSheet>
    </div>
  );
}
