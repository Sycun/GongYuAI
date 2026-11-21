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
  targets: string;
  objective: string;
  maxConcurrentExplores: number;
};

function parseTargets(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostHint(targets: string[]): string {
  const first = targets[0] ?? "task";
  try {
    return new URL(first).hostname || first;
  } catch {
    return first.replace(/^https?:\/\//, "").split("/")[0] || first;
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
    const targetList = parseTargets(values.targets ?? "");
    const objective = values.objective.trim();
    const concurrency = Math.min(
      16,
      Math.max(1, Math.floor(Number(values.maxConcurrentExplores) || 1)),
    );
    if (!targetList.length || !objective) {
      Toast.error("请填写靶标和目标");
      return;
    }

    const hint =
      targetList.length === 1 ? hostHint(targetList) : `${hostHint(targetList)}+${targetList.length - 1}`;
    setSubmitting(true);
    try {
      const r = await api.createTask({
        name: hint,
        mock: false,
        auth: {
          authorizationNote: `已授权评估：${targetList.join("、")}（操作者自有/书面授权）`,
          targets: targetList,
          outOfScope: [],
        },
        goals: goalsFromObjective(objective),
        budget: {
          maxTokens: 2_000_000,
          maxWallMs: 600_000,
          maxToolCalls: 200,
          maxInstalls: 20,
        },
        execution: {
          maxConcurrentExplores: concurrency,
        },
      });
      const effective = Math.min(concurrency, targetList.length);
      Toast.success(
        `已创建并启动 · ${r.json.task.name}${effective > 1 ? ` · Explore×${effective}` : ""}`,
      );
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
          可填多个靶标并设置 Explore 并发；授权说明、预算等用默认配置自动启动。
        </Typography.Paragraph>
        <Form
          id="create-task-form"
          labelPosition="top"
          initValues={{
            targets: "",
            objective: "",
            maxConcurrentExplores: 1,
          }}
          onSubmit={(v) => void submit(v as FormValues)}
        >
          <Form.TextArea
            field="targets"
            label="靶标"
            placeholder={"https://a.example.com\nhttps://b.example.com\n或 CIDR / host，一行一个"}
            autosize={{ minRows: 3, maxRows: 8 }}
            rules={[{ required: true, message: "必填" }]}
            extraText="多行或多个逗号分隔；作业范围仅允许在这些目标内执行"
          />
          <Form.TextArea
            field="objective"
            label="目标"
            placeholder={"例如：完成站点基础信息收集，并输出简要发现说明\n多行则按行拆成多个目标"}
            autosize={{ minRows: 5, maxRows: 10 }}
            rules={[{ required: true, message: "必填" }]}
          />
          <Form.InputNumber
            field="maxConcurrentExplores"
            label="Explore 并发"
            min={1}
            max={16}
            step={1}
            style={{ width: "100%" }}
            extraText="同时推进的 Explore 数（默认 1=串行）。有效并发不超过靶标数；越高 Token/工具消耗越快"
          />
        </Form>
      </SideSheet>
    </div>
  );
}
