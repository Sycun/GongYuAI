import { useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Form,
  SideSheet,
  Space,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form/interface";
import { IconPlus } from "@douyinfe/semi-icons";
import { api, type TaskRecord } from "../api";
import { TaskTable } from "../components/TaskTable";
import { isArchivedTask } from "../labels";

type Props = {
  tasks: TaskRecord[];
  onSelect: (taskId: string) => void;
  onCreated: (taskId: string) => void;
  onRefresh: () => Promise<void>;
};

type FormValues = {
  targets: string;
  objective: string;
  authorizationNote: string;
  outOfScope?: string;
  maxConcurrentExplores: number;
};

function parseTargets(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 靶标 ≤2 推荐靶标数；更多则推荐 3–10。运行中还会按发现资产自动扩容。 */
function recommendedConcurrency(targetCount: number): number {
  if (targetCount <= 2) return Math.max(1, targetCount);
  return Math.min(10, Math.max(3, targetCount));
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
  return items.map((line, i) => {
    const id = items.length === 1 ? "main" : `g${i + 1}`;
    return {
      id,
      title: items.length === 1 ? "主目标" : `目标 ${i + 1}`,
      description: line,
      evidencePatterns: [`goals/${id}.md`],
    };
  });
}

export function TasksPage({ tasks, onSelect, onCreated, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const formApiRef = useRef<FormApi | null>(null);
  const concurrencyTouched = useRef(false);
  const autoSettingConcurrency = useRef(false);

  const archivedCount = useMemo(
    () => tasks.filter((t) => isArchivedTask(t)).length,
    [tasks],
  );

  const visibleTasks = useMemo(() => {
    const filtered = showArchived
      ? tasks.filter((t) => isArchivedTask(t))
      : tasks.filter((t) => !isArchivedTask(t));
    return [...filtered].reverse();
  }, [tasks, showArchived]);

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
          authorizationNote: values.authorizationNote.trim(),
          targets: targetList,
          outOfScope: parseTargets(values.outOfScope ?? ""),
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

  const archiveTask = async (task: TaskRecord) => {
    setActionBusyId(task.id);
    try {
      await api.archive(task.id);
      Toast.success("已归档");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusyId(null);
    }
  };

  const unarchiveTask = async (task: TaskRecord) => {
    setActionBusyId(task.id);
    try {
      await api.unarchive(task.id);
      Toast.success("已恢复到列表");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusyId(null);
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
          gap: 12,
        }}
      >
        <Space>
          <Button
            theme={!showArchived ? "solid" : "light"}
            type={!showArchived ? "primary" : "tertiary"}
            onClick={() => setShowArchived(false)}
          >
            进行中
          </Button>
          <Button
            theme={showArchived ? "solid" : "light"}
            type={showArchived ? "primary" : "tertiary"}
            onClick={() => setShowArchived(true)}
            disabled={archivedCount === 0 && !showArchived}
          >
            已归档{archivedCount > 0 ? ` · ${archivedCount}` : ""}
          </Button>
        </Space>
        <Button
          theme="solid"
          icon={<IconPlus />}
          onClick={() => {
            concurrencyTouched.current = false;
            setOpen(true);
          }}
        >
          新建任务
        </Button>
      </div>

      <Card style={{ background: "var(--semi-color-bg-1)" }} bodyStyle={{ paddingTop: 8 }}>
        <TaskTable
          tasks={visibleTasks}
          onSelect={onSelect}
          onArchive={(t) => void archiveTask(t)}
          onUnarchive={(t) => void unarchiveTask(t)}
          actionBusyId={actionBusyId}
        />
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
          本次任务上限为 10 分钟、200 万 Token、200 次工具调用和 20 次安装。
        </Typography.Paragraph>
        <Form
          id="create-task-form"
          labelPosition="top"
          getFormApi={(api) => {
            formApiRef.current = api;
          }}
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
            onChange={(v) => {
              if (concurrencyTouched.current) return;
              const rec = recommendedConcurrency(parseTargets(String(v ?? "")).length);
              autoSettingConcurrency.current = true;
              formApiRef.current?.setValue("maxConcurrentExplores", rec);
              autoSettingConcurrency.current = false;
            }}
          />
          <Form.TextArea
            field="authorizationNote"
            label="授权依据"
            placeholder="填写授权单号或委托范围说明"
            rules={[{ required: true, validator: (_rule, value) => typeof value === "string" && value.trim().length >= 8, message: "请填写至少 8 个字符的授权依据" }]}
          />
          <Form.TextArea field="outOfScope" label="排除范围（可选）" placeholder="每行一个排除项" />
          <Form.TextArea
            field="objective"
            label="目标"
            extraText="每项目标单独留存一份材料。材料提交后，结论仍可由操作员复核。"
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
            extraText="按靶标数自动推荐 3–10，可手动改。有效并发 = min(此值, max(靶标数, 发现的可用资产数))，运行中自动扩容（只扩不缩）；越高 Token/工具消耗越快"
            onChange={() => {
              if (!autoSettingConcurrency.current) concurrencyTouched.current = true;
            }}
          />
        </Form>
      </SideSheet>
    </div>
  );
}
