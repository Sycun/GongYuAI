import { Banner, Card } from "@douyinfe/semi-ui";
import type { TaskRecord } from "../api";
import { TaskTable } from "../components/TaskTable";

type Props = {
  tasks: TaskRecord[];
  onSelect: (taskId: string) => void;
};

export function TasksPage({ tasks, onSelect }: Props) {
  return (
    <div>
      <Banner
        type="info"
        closeIcon={null}
        description="新建任务目前走命令行：pnpm gy run --goals … --target … --auth …"
        style={{ marginBottom: 16 }}
      />
      <Card style={{ background: "var(--semi-color-bg-1)" }} bodyStyle={{ paddingTop: 8 }}>
        <TaskTable tasks={[...tasks].reverse()} onSelect={onSelect} />
      </Card>
    </div>
  );
}
