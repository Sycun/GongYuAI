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
  Table,
  Tabs,
  Tag,
  TextArea,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { IconPlay, IconRefresh, IconStop } from "@douyinfe/semi-icons";
import {
  api,
  type AssetRecord,
  type HintRecord,
  type HistoryPayload,
  type RuntimePayload,
  type TaskRecord,
} from "../api";
import {
  ASSET_KIND_LABEL,
  DETAIL_TABS,
  type DetailTab,
  STATUS_LABEL,
  formatWorkerStatus,
  isActiveStatus,
  isStartableStatus,
  shortId,
  statusColor,
} from "../labels";
import { StatusTag } from "../components/StatusTag";
import { ExecutionTrace } from "../components/ExecutionTrace";
import { FactIntentDag } from "../components/dag/FactIntentDag";
import { formatDateTime } from "../time";

type Props = {
  task: TaskRecord | null;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onRefresh: () => Promise<void>;
};

export function TaskDetailPage({ task, tab, onTabChange, onRefresh }: Props) {
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [evidenceFiles, setEvidenceFiles] = useState<
    Array<{ path: string; size: number; mtime: string }>
  >([]);
  const [evidencePath, setEvidencePath] = useState<string | null>(null);
  const [evidenceBody, setEvidenceBody] = useState("请选择左侧文件");
  const [paneText, setPaneText] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [liveUsage, setLiveUsage] = useState<TaskRecord["usage"] | null>(null);
  const [hints, setHints] = useState<HintRecord[]>([]);
  const [hintDraft, setHintDraft] = useState("");
  const [hintBusy, setHintBusy] = useState(false);

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
          if (r.json.usage) setLiveUsage(r.json.usage);
          setHints(h.json.hints ?? []);
        }
        if (tab === "assets") {
          const a = await api.assets(task!.id);
          if (cancelled) return;
          setAssets(a.json.assets ?? []);
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

  // 运行中自动刷新运行态 / 步骤，保持与任务状态一致
  useEffect(() => {
    if (!task || !isActiveStatus(task.status)) return;
    if (
      tab !== "live" &&
      tab !== "goals" &&
      tab !== "history" &&
      tab !== "assets" &&
      tab !== "logs"
    ) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        if (tab === "live" || tab === "goals" || tab === "history") {
          const [h, r] = await Promise.all([api.history(task.id), api.runtime(task.id)]);
          if (cancelled) return;
          setHistory(h.json);
          setRuntime(r.json);
          if (r.json.usage) setLiveUsage(r.json.usage);
        }
        if (tab === "assets") {
          const a = await api.assets(task.id);
          if (cancelled) return;
          setAssets(a.json.assets ?? []);
        }
        if (tab === "logs") {
          const r = await api.logs(task.id);
          if (cancelled) return;
          setPaneText(r.text || "（空）");
        }
        await onRefresh();
      } catch {
        /* 轮询失败时静默，下一次再试 */
      }
    };
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [task?.id, task?.status, tab, onRefresh]);

  useEffect(() => {
    setLiveUsage(null);
  }, [task?.id]);

  if (!task) {
    return (
      <Empty
        title="未选择任务"
        description="请先在「任务」里选择一个任务。"
        style={{ padding: 48 }}
      />
    );
  }

  const usage = liveUsage ?? task.usage;
  const active = isActiveStatus(task.status);
  const startable = isStartableStatus(task.status);

  const stopTask = async () => {
    if (!active || actionBusy) return;
    setActionBusy(true);
    try {
      await api.stop(task.id);
      Toast.success("已发送停止");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const startTask = async () => {
    if (!startable || actionBusy) return;
    setActionBusy(true);
    try {
      await api.start(task.id);
      Toast.success("已开始运行");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
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

  const goalStatus = (passes: boolean) => {
    if (passes) return "ok";
    if (active) return "running";
    return "pending";
  };

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
          {task.error ? (
            <Typography.Text type="danger" style={{ display: "block", marginTop: 4 }}>
              {task.error}
            </Typography.Text>
          ) : null}
        </div>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void onRefresh()} loading={loading}>
            刷新
          </Button>
          {active ? (
            <Button
              type="danger"
              theme="solid"
              icon={<IconStop />}
              loading={actionBusy}
              onClick={() => void stopTask()}
            >
              停止
            </Button>
          ) : startable ? (
            <Button
              type="primary"
              theme="solid"
              icon={<IconPlay />}
              loading={actionBusy}
              onClick={() => void startTask()}
            >
              开始
            </Button>
          ) : null}
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
                    {
                      key: "Explore 并发",
                      value: String(
                        runtime?.execution?.maxConcurrentExplores ??
                          task.execution?.maxConcurrentExplores ??
                          1,
                      ),
                    },
                    {
                      key: "工作进程",
                      value: (runtime?.workerPids?.length
                        ? runtime.workerPids
                        : runtime?.workerPid
                          ? [runtime.workerPid]
                          : []
                      ).join(", ") || "—",
                    },
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
                      value: `${usage.toolCalls} / ${task.budget.maxToolCalls > 0 ? task.budget.maxToolCalls : "∞"}`,
                    },
                    {
                      key: "安装次数",
                      value: `${usage.installs} / ${task.budget.maxInstalls > 0 ? task.budget.maxInstalls : "∞"}`,
                    },
                    {
                      key: "Token",
                      value: `${usage.tokens} / ${task.budget.maxTokens > 0 ? task.budget.maxTokens : "∞"}`,
                    },
                    {
                      key: "墙钟上限",
                      value:
                        task.budget.maxWallMs > 0
                          ? `${Math.round(task.budget.maxWallMs / 3_600_000)}h`
                          : "∞",
                    },
                    { key: "授权说明", value: task.auth.authorizationNote || "—" },
                  ]}
                />
              </Card>
            </Col>
            <Col span={24} style={{ marginTop: 16 }}>
              <Card
                title="战术 Hint"
                style={{ background: "var(--semi-color-bg-1)" }}
                headerExtraContent={
                  <Typography.Text type="tertiary" size="small">
                    写入 History · 下次 Observe 吸收
                  </Typography.Text>
                }
              >
                <TextArea
                  value={hintDraft}
                  onChange={(v) => setHintDraft(v)}
                  placeholder="例如：优先测 /login 的 SQL 注入；WAF 可试 X-Forwarded-For"
                  autosize={{ minRows: 2, maxRows: 5 }}
                />
                <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
                  <Button
                    theme="solid"
                    loading={hintBusy}
                    disabled={!hintDraft.trim()}
                    onClick={() => {
                      void (async () => {
                        const text = hintDraft.trim();
                        if (!text) return;
                        setHintBusy(true);
                        try {
                          const r = await api.createHint(task.id, { text, source: "human" });
                          setHints((prev) => [r.json.hint, ...prev]);
                          setHintDraft("");
                          Toast.success("Hint 已注入");
                        } catch (e) {
                          Toast.error(e instanceof Error ? e.message : String(e));
                        } finally {
                          setHintBusy(false);
                        }
                      })();
                    }}
                  >
                    注入 Hint
                  </Button>
                </div>
                {hints.length > 0 && (
                  <List
                    style={{ marginTop: 12 }}
                    dataSource={hints.slice(0, 8)}
                    renderItem={(h) => (
                      <List.Item
                        main={
                          <div>
                            <Typography.Text type="tertiary" size="small">
                              {h.source} · {formatDateTime(h.createdAt, true)}
                            </Typography.Text>
                            <div>{h.text}</div>
                          </div>
                        }
                      />
                    )}
                  />
                )}
              </Card>
            </Col>
            <Col span={24} style={{ marginTop: 16 }}>
              <Card
                title="执行链路"
                style={{ background: "var(--semi-color-bg-1)" }}
                bodyStyle={{ maxHeight: 640, overflow: "auto" }}
              >
                <ExecutionTrace
                  resetKey={task.id}
                  progress={runtime?.progress}
                  facts={runtime?.recentFacts}
                  active={active}
                  emptyHint={active ? "等待执行节点上报步骤…" : "暂无执行步骤"}
                />
              </Card>
            </Col>
            <Col span={24} style={{ marginTop: 16 }}>
              <Card title="执行节点状态" style={{ background: "var(--semi-color-bg-1)" }}>
                <Descriptions align="left" data={formatWorkerStatus(runtime?.workerStatus)} />
              </Card>
            </Col>
          </Row>
        )}

        {tab === "assets" && (
          <Card
            title={`资产清单 · ${assets.length} 条`}
            style={{ background: "var(--semi-color-bg-1)" }}
            headerExtraContent={
              <Typography.Text type="tertiary" size="small">
                与 AI Observe 同表 · 发现经 asset_record 自动准入
              </Typography.Text>
            }
          >
            {assets.length === 0 ? (
              <Empty
                title="暂无资产"
                description="创建任务后会从 auth.targets 写入种子行；运行中发现会追加。"
              />
            ) : (
              <Table
                size="small"
                pagination={assets.length > 20 ? { pageSize: 20 } : false}
                dataSource={assets.map((a) => ({ ...a, key: a.address }))}
                columns={[
                  {
                    title: "地址 / 模式",
                    dataIndex: "address",
                    render: (v: string) => (
                      <Typography.Text
                        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                      >
                        {v}
                      </Typography.Text>
                    ),
                  },
                  {
                    title: "状态",
                    dataIndex: "kind",
                    width: 100,
                    render: (k: string) => (
                      <Tag color={statusColor(k === "oos" ? "failed" : k === "live" ? "ok" : "running")} size="small">
                        {ASSET_KIND_LABEL[k] ?? k}
                      </Tag>
                    ),
                  },
                  {
                    title: "来源",
                    dataIndex: "source",
                    width: 90,
                    render: (s: string) => (s === "auth" ? "授权" : "发现"),
                  },
                  {
                    title: "说明",
                    dataIndex: "summary",
                    ellipsis: true,
                  },
                  {
                    title: "Fact",
                    dataIndex: "factId",
                    width: 100,
                    render: (id: string) => shortId(id),
                  },
                  {
                    title: "更新",
                    dataIndex: "createdAt",
                    width: 180,
                    render: (t: string) => formatDateTime(t, true),
                  },
                ]}
              />
            )}
          </Card>
        )}

        {tab === "goals" && (
          <Row gutter={16}>
            <Col span={24}>
              <Card
                title="Fact–Intent DAG"
                style={{ background: "var(--semi-color-bg-1)" }}
                bodyStyle={{ paddingTop: 12 }}
              >
                <FactIntentDag
                  facts={history?.facts ?? []}
                  intents={history?.intents ?? []}
                  height={380}
                />
              </Card>
            </Col>
            <Col span={14} style={{ marginTop: 16 }}>
              <Card
                title="目标契约"
                style={{ background: "var(--semi-color-bg-1)" }}
                bodyStyle={{ paddingTop: 8 }}
              >
                <List
                  dataSource={goals}
                  emptyContent="无目标"
                  renderItem={(g) => (
                    <List.Item
                      main={
                        <div>
                          <Space>
                            <Typography.Text strong>{g.title}</Typography.Text>
                            <StatusTag status={goalStatus(g.passes)} />
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
            </Col>
            <Col span={10} style={{ marginTop: 16 }}>
              <Card title="图前沿 · 开放意图" style={{ background: "var(--semi-color-bg-1)" }}>
                <List
                  dataSource={(history?.intents ?? []).filter((i) =>
                    ["proposed", "claimed", "running"].includes(i.status),
                  )}
                  emptyContent="无开放 Intent"
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
              <Card
                title="图前沿 · 最近 Fact 标题"
                style={{ background: "var(--semi-color-bg-1)", marginTop: 16 }}
              >
                <List
                  dataSource={[...(history?.facts ?? [])]
                    .filter((f) => f.layer === "title")
                    .reverse()
                    .slice(0, 12)}
                  emptyContent="—"
                  size="small"
                  renderItem={(f) => (
                    <List.Item main={<Typography.Text>{f.title}</Typography.Text>} />
                  )}
                />
              </Card>
            </Col>
          </Row>
        )}

        {tab === "history" && (
          <Row gutter={16}>
            <Col span={24}>
              <Card
                title="Fact–Intent DAG"
                style={{ background: "var(--semi-color-bg-1)" }}
                bodyStyle={{ paddingTop: 12 }}
              >
                <FactIntentDag
                  facts={history?.facts ?? []}
                  intents={history?.intents ?? []}
                  height={420}
                />
              </Card>
            </Col>
            <Col span={12} style={{ marginTop: 16 }}>
              <Card title="总览" style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{history?.overview || "—"}</pre>
              </Card>
            </Col>
            <Col span={12} style={{ marginTop: 16 }}>
              <Card title="意图" style={{ background: "var(--semi-color-bg-1)" }}>
                <List
                  dataSource={
                    runtime?.recentIntents?.length
                      ? runtime.recentIntents
                      : [...(history?.intents ?? [])].reverse().slice(0, 20)
                  }
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
