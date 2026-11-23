import { Card } from "@douyinfe/semi-ui";
import { probeMessage, useProbe } from "../workspace/useProbe";

export function CapabilityCard({ title, path, note }: { title: string; path: string | null; note?: string }) {
  const state = useProbe<unknown>(path);
  return (
    <Card title={title} style={{ background: "var(--semi-color-bg-1)", marginTop: 12 }}>
      {note && <p>{note}</p>}
      {!path && <p role="status">还没有可读取的记录编号。</p>}
      {path && !state?.ok && <p role="status">{probeMessage(state, "")}</p>}
      {path && state?.ok && <pre className="gy-mono">{JSON.stringify(state.json, null, 2).slice(0, 5000)}</pre>}
    </Card>
  );
}
