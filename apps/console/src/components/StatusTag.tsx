import { Tag } from "@douyinfe/semi-ui";
import { STATUS_LABEL, statusColor } from "../labels";

export function StatusTag({ status }: { status: string }) {
  return (
    <Tag color={statusColor(status)} size="large">
      {STATUS_LABEL[status] ?? status}
    </Tag>
  );
}
