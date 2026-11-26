import { Button, Space, Table, Typography } from "@douyinfe/semi-ui";
import { IconArchive, IconUndo } from "@douyinfe/semi-icons";
import type { TaskRecord } from "../api";
import { isArchivedTask, isArchivableStatus, shortId } from "../labels";
import { StatusTag } from "./StatusTag";
import { useClientPagination } from "./useClientPagination";

type Props = {
  tasks: TaskRecord[];
  onSelect: (taskId: string) => void;
  onArchive?: (task: TaskRecord) => void;
  onUnarchive?: (task: TaskRecord) => void;
  actionBusyId?: string | null;
  resetKey?: string | number | boolean;
};

export function TaskTable({
  tasks,
  onSelect,
  onArchive,
  onUnarchive,
  actionBusyId,
  resetKey,
}: Props) {
  const pager = useClientPagination(tasks, 12, resetKey);
  return (
    <Table
      rowKey="id"
      dataSource={pager.dataSource}
      pagination={pager.pagination}
      empty="暂无任务"
      onRow={(record) => ({
        onClick: () => record && onSelect(record.id),
        style: { cursor: "pointer" },
      })}
      columns={[
        {
          title: "名称",
          dataIndex: "name",
          render: (name: string, record: TaskRecord) => (
            <Space spacing={8}>
              <Typography.Text strong>{name}</Typography.Text>
              {isArchivedTask(record) ? (
                <Typography.Text type="tertiary" size="small">
                  已归档
                </Typography.Text>
              ) : null}
            </Space>
          ),
        },
        {
          title: "状态",
          dataIndex: "status",
          width: 120,
          render: (status: string, record: TaskRecord) => (
            <Space wrap>
              <StatusTag status={status} />
              {status === "completed" && (!record.goals.length || record.goals.some((g) => !g.passes)) && (
                <Typography.Text type="warning" size="small">目标待核对</Typography.Text>
              )}
            </Space>
          ),
        },
        {
          title: "模式",
          dataIndex: "mock",
          width: 100,
          render: (mock: boolean) => (mock ? "模拟" : "大模型"),
        },
        {
          title: "编号",
          dataIndex: "id",
          width: 110,
          render: (id: string) => (
            <Typography.Text type="tertiary" code>
              {shortId(id)}
            </Typography.Text>
          ),
        },
        {
          title: "操作",
          dataIndex: "id",
          width: 100,
          render: (_id: string, record: TaskRecord) => {
            const busy = actionBusyId === record.id;
            const archived = isArchivedTask(record);
            if (archived) {
              return (
                <Button
                  size="small"
                  theme="borderless"
                  type="tertiary"
                  icon={<IconUndo />}
                  loading={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnarchive?.(record);
                  }}
                >
                  取消归档
                </Button>
              );
            }
            if (!isArchivableStatus(record.status)) return null;
            return (
              <Button
                size="small"
                theme="borderless"
                type="tertiary"
                icon={<IconArchive />}
                loading={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive?.(record);
                }}
              >
                归档
              </Button>
            );
          },
        },
      ]}
    />
  );
}
