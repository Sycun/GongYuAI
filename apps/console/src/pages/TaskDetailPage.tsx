import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  List,
  Row,
  Space,
  Tabs,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { IconRefresh, IconStop } from "@douyinfe/semi-icons";
import {
  api,
  type HistoryPayload,
  type RuntimePayload,
  type TaskRecord,
} from "../api";
import { DETAIL_TABS, type DetailTab, STATUS_LABEL, shortId } from "../labels";
import { StatusTag } from "../components/StatusTag";

type Props = {
  task: TaskRecord | null;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onRefresh: () => Promise<void>;
};

export function TaskDetailPage({ task, tab, onTabChange, onRefresh }: Props) {
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [evidenceFiles, setEvidenceFiles] = useState<
    Array<{ path: string; size: number; mtime: string }>
  >([]);
  const [evidencePath, setEvidencePath] = useState<string | null>(null);
  const [evidenceBody, setEvidenceBody] = useState("请选择左侧文件");
  const [paneText, setPaneText] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (tab === "live" || tab === "goals" || tab === "history") {
          const [h, r] = await Promise.all([api.history(task!.id), api.runtime(task!.id)]);
          if (cancelled) return;
          setHistory(h.json);
          setRuntime(r.json);
        }
        if (tab === "evidence") {
          const ev = await api.evidence(task!.id);
          if (cancelled) return;
          setEvidenceFiles(ev.json.files ?? []);
        }
        if (tab === "report" || tab === "logs") {
          const r = tab === "report" ? await api.report(task!.id) : await api.logs(task!.id);
          if (cancelled) return;
          setPaneText(r.text || "（空）");
        }
      } catch (e) {
        if (!cancelled) {
          Toast.error(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [task?.id, tab]);

  if (!task) {
    return (
      <Empty
        title="未选择任务"
        description="请先在「任务」里选择一个任务。"
        style={{ padding: 48 }}
      />
    );
  }

  const stopTask = async () => {
    try {
      await api.stop(task.id);
      Toast.success("已发送停止");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const openEvidence = async (path: string) => {
    setEvidencePath(path);
    try {
      const r = await api.evidenceFile(task.id, path);
      setEvidenceBody(r.text);
    } catch (e) {
      setEvidenceBody(e instanceof Error ? e.message : String(e));
    }
  };

  const goals = history?.goals?.length ? history.goals : task.goals;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "flex-start",
          marginBottom: 12,
        }}
      >
        <div>
          <Space align="center" spacing={12}>
            <Typography.Title heading={4} style={{ margin: 0 }}>
              {task.name}
            </Typography.Title>
            <StatusTag status={task.status} />
          </Space>
          <Typography.Text type="tertiary" style={{ display: "block", marginTop: 6 }}>
            编号 {shortId(task.id)} · 目标 {(task.auth.targets || []).join(", ") || "—"}
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void onRefresh()} loading={loading}>
            刷新
          </Button>
          <Button type="danger" theme="solid" icon={<IconStop />} onClick={() => void stopTask()}>
            停止
          </Button>
        </Space>
      </div>

      <Tabs
        type="line"
        activeKey={tab}
        onChange={(key) => onTabChange(key as DetailTab)}
        tabList={DETAIL_TABS.map((t) => ({ itemKey: t.key, tab: t.label }))}
      />

      <div style={{ marginTop: 16 }}>
        {tab === "live" && (
          <Row gutter={16}>
            <Col span={12}>
              <Card title="持久运行" style={{ background: "var(--semi-color-bg-1)" }}>
                <Descriptions
                  align="left"
                  data={[
                    { key: "租约持有者", value: runtime?.leaseOwner || "—" },
                    { key: "租约到期", value: runtime?.leaseUntil || "—" },
                    { key: "栅栏号", value: String(runtime?.fence ?? task.fence) },
                    { key: "检查点", value: runtime?.hasCheckpoint ? "有" : "无" },
                    { key: "工作进程", value: String(runtime?.workerPid ?? "—") },
                  ]}
                />
              </Card>
            </Col>
            <Col span={12}>
              <Card title="预算" style={{ background: "var(--semi-color-bg-1)" }}>
                <Descriptions
                  align="left"
                  data={[
                    {
                      key: "工具调用",
                      value: `${task.usage.toolCalls} / ${task.budget.maxToolCalls}`,
                    },
                    {
                      key: "安装次数",
                      value: `${task.usage.installs} / ${task.budget.maxInstalls}`,
                    },
                    {
                      key: "Token",
                      value: `${task.usage.tokens} / ${task.budget.maxTokens}`,
                    },
                    { key: "授权说明", value: task.auth.authorizationNote || "—" },
                  ]}
                />
              </Card>
            </Col>
            <Col span={24} style={{ marginTop: 16 }}>
              <Card title="执行节点状态" style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{JSON.stringify(runtime?.workerStatus ?? {}, null, 2)}</pre>
              </Card>
            </Col>
          </Row>
        )}

        {tab === "goals" && (
          <Card style={{ background: "var(--semi-color-bg-1)" }} bodyStyle={{ paddingTop: 8 }}>
            <List
              dataSource={goals}
              emptyContent="无目标"
              renderItem={(g) => (
                <List.Item
                  main={
                    <div>
                      <Space>
                        <Typography.Text strong>{g.title}</Typography.Text>
                        <StatusTag status={g.passes ? "ok" : "running"} />
                      </Space>
                      <Typography.Paragraph type="tertiary" style={{ margin: "4px 0 0" }}>
                        {g.description}
                      </Typography.Paragraph>
                      <Typography.Text type="quaternary" size="small">
                        证据：
                        {(g.evidencePaths?.length
                          ? g.evidencePaths
                          : g.evidencePatterns
                        ).join(", ") || "—"}
                      </Typography.Text>
                    </div>
                  }
                />
              )}
            />
          </Card>
        )}

        {tab === "history" && (
          <Row gutter={16}>
            <Col span={12}>
              <Card title="总览" style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{history?.overview || "—"}</pre>
              </Card>
            </Col>
            <Col span={12}>
              <Card title="意图" style={{ background: "var(--semi-color-bg-1)" }}>
                <List
                  dataSource={[...(history?.intents ?? [])].reverse().slice(0, 20)}
                  emptyContent="—"
                  size="small"
                  renderItem={(i) => (
                    <List.Item
                      main={
                        <Space>
                          <StatusTag status={i.status} />
                          <span>{i.title}</span>
                        </Space>
                      }
                    />
                  )}
                />
              </Card>
            </Col>
            <Col span={24} style={{ marginTop: 16 }}>
              <Card title="事实" style={{ background: "var(--semi-color-bg-1)" }}>
                <List
                  dataSource={[...(history?.facts ?? [])].reverse().slice(0, 40)}
                  emptyContent="—"
                  size="small"
                  renderItem={(f) => (
                    <List.Item
                      main={
                        <div>
                          <Typography.Text type="tertiary" size="small">
                            {STATUS_LABEL[f.layer] ?? f.layer}
                          </Typography.Text>{" "}
                          <Typography.Text>{f.title}</Typography.Text>
                          {f.summary ? (
                            <Typography.Text type="quaternary">
                              {" "}
                              — {f.summary.slice(0, 120)}
                            </Typography.Text>
                          ) : null}
                        </div>
                      }
                    />
                  )}
                />
              </Card>
            </Col>
          </Row>
        )}

        {tab === "evidence" && (
          <Row gutter={16}>
            <Col span={8}>
              <Card title="文件" style={{ background: "var(--semi-color-bg-1)", maxHeight: 520, overflow: "auto" }}>
                <List
                  dataSource={evidenceFiles}
                  emptyContent="无证据文件"
                  size="small"
                  renderItem={(f) => (
                    <List.Item
                      className={evidencePath === f.path ? "gy-list-active" : undefined}
                      onClick={() => void openEvidence(f.path)}
                      style={{ cursor: "pointer" }}
                      main={
                        <div>
                          <Typography.Text>{f.path}</Typography.Text>
                          <br />
                          <Typography.Text type="tertiary" size="small">
                            {f.size} 字节
                          </Typography.Text>
                        </div>
                      }
                    />
                  )}
                />
              </Card>
            </Col>
            <Col span={16}>
              <Card title="内容" style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{evidenceBody}</pre>
              </Card>
            </Col>
          </Row>
        )}

        {(tab === "report" || tab === "logs") && (
          <Card style={{ background: "var(--semi-color-bg-1)" }}>
            <pre className="gy-mono">{paneText || "加载中…"}</pre>
          </Card>
        )}
      </div>
    </div>
  );
}
