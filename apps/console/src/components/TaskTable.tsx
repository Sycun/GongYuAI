import { Table, Typography } from "@douyinfe/semi-ui";
import type { TaskRecord } from "../api";
import { shortId } from "../labels";
import { StatusTag } from "./StatusTag";

type Props = {
  tasks: TaskRecord[];
  onSelect: (taskId: string) => void;
};

export function TaskTable({ tasks, onSelect }: Props) {
  return (
    <Table
      rowKey="id"
      dataSource={tasks}
      pagination={tasks.length > 12 ? { pageSize: 12 } : false}
      empty="暂无任务"
      onRow={(record) => ({
        onClick: () => record && onSelect(record.id),
        style: { cursor: "pointer" },
      })}
      columns={[
        {
          title: "名称",
          dataIndex: "name",
          render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
        },
        {
          title: "状态",
          dataIndex: "status",
          width: 120,
          render: (status: string) => <StatusTag status={status} />,
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
      ]}
    />
  );
}
