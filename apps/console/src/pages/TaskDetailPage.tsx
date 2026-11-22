import { lazy, Suspense, useEffect, useState } from "react";
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
import { IconArchive, IconPlay, IconRefresh, IconStop, IconUndo } from "@douyinfe/semi-icons";
import {
  api,
  type AssetRecord,
  type FindingRecord,
  type HintRecord,
  type HistoryPayload,
  type RuntimePayload,
  type TaskRecord,
} from "../api";
import {
  ASSET_KIND_LABEL,
  DETAIL_TABS,
  type DetailTab,
  FINDING_SEVERITY_LABEL,
  FINDING_STATUS_LABEL,
  STATUS_LABEL,
  findingSeverityColor,
  findingStatusColor,
  formatWorkerStatus,
  isActiveStatus,
  isArchivedTask,
  isPausedStatus,
  isStartableStatus,
  isTerminalStatus,
  shortId,
  statusColor,
} from "../labels";
import { StatusTag } from "../components/StatusTag";
import { GoalCoverage } from "../components/GoalCoverage";
import { DeliveryScorecard } from "../components/DeliveryScorecard";
import { ReconcilePanel } from "../components/ReconcilePanel";
import { ExecutionTrace } from "../components/ExecutionTrace";
import { IntegrationUsage } from "../components/IntegrationUsage";
import { formatDateTime } from "../time";

const FactIntentDag = lazy(() => import("../components/dag/FactIntentDag"));

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
  const [findingProof, setFindingProof] = useState<{ path: string; body: string } | null>(null);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setPaneText("");
      try {
        if (tab === "live" || tab === "goals" || tab === "history" || tab === "findings") {
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
        if (tab === "report") {
          const { json } = await api.delivery(task!.id);
          const original = json.hasReport ? (await api.report(task!.id)).text : "";
          if (cancelled) return;
          setPaneText(original ? json.summary + "\n## 留存报告\n\n" + original : json.summary);
        }
        if (tab === "logs") {
          const r = await api.logs(task!.id);
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
  }, [task?.id, task?.status, tab]);

  // 运行中自动刷新运行态 / 步骤，保持与任务状态一致
  useEffect(() => {
    if (!task || !isActiveStatus(task.status)) return;
    if (
      tab !== "live" &&
      tab !== "goals" &&
      tab !== "history" &&
      tab !== "findings" &&
      tab !== "assets" &&
      tab !== "logs"
    ) {
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        if (tab === "live" || tab === "goals" || tab === "history" || tab === "findings") {
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
  const paused = isPausedStatus(task.status);
  const startable = isStartableStatus(task.status);
  const archived = isArchivedTask(task);
  const archivable = isTerminalStatus(task.status) && !archived;

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

  const pauseTask = async () => {
    if (!active || actionBusy || task.status === "pause_requested" || task.status === "stopping") return;
    setActionBusy(true);
    try {
      await api.pause(task.id);
      Toast.success("已请求暂停；确认 worker 退出后显示已暂停");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const resumeTask = async () => {
    if (!paused || actionBusy) return;
    setActionBusy(true);
    try {
      await api.resume(task.id);
      Toast.success("已继续；本次运行读取最新授权版本");
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

  const archiveTask = async () => {
    if (!archivable || actionBusy) return;
    setActionBusy(true);
    try {
      await api.archive(task.id);
      Toast.success("已归档");
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const unarchiveTask = async () => {
    if (!archived || actionBusy) return;
    setActionBusy(true);
    try {
      await api.unarchive(task.id);
      Toast.success("已恢复到列表");
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

  /**
   * 首次通过采用的核算文件与最近一次拒绝原因都来自事件台账（服务端按时间
   * 倒序返回），控制台只做展示，不自己推断结论。
   */
  const goalEvents = history?.events ?? [];
  const adoptedByGoal = new Map<string, { path: string; sha256: string; name?: string }>();
  for (const event of [...goalEvents].reverse()) {
    const payload = (event?.payload ?? {}) as {
      goalId?: string;
      adoptedReconcile?: { path: string; sha256: string; name?: string };
    };
    if (event?.kind === "goal_asserted" && payload.goalId && payload.adoptedReconcile && !adoptedByGoal.has(payload.goalId)) {
      adoptedByGoal.set(payload.goalId, payload.adoptedReconcile);
    }
  }
  const rejectionByGoal = new Map<string, string>();
  for (const event of goalEvents) {
    const payload = (event?.payload ?? {}) as { goalId?: string; reason?: string };
    if (event?.kind === "goal_assert_rejected" && payload.goalId && payload.reason) {
      rejectionByGoal.set(payload.goalId, payload.reason);
    }
  }

  const dagPanel = (
    <Suspense fallback={<div className="gy-dag-empty" role="status">正在加载关系图…</div>}>
      <FactIntentDag
        facts={history?.facts ?? []}
        intents={history?.intents ?? []}
        height={tab === "goals" ? 380 : 420}
        loading={loading}
      />
    </Suspense>
  );

  return (
    <div>
      <div className="gy-task-heading">
        <div>
          <Space align="center" spacing={12}>
            <Typography.Title heading={4} style={{ margin: 0 }}>
              {task.name}
            </Typography.Title>
            <StatusTag status={task.status} />
            {archived ? <Tag color="grey">已归档</Tag> : null}
          </Space>
          <Typography.Text type="tertiary" style={{ display: "block", marginTop: 6 }}>
            编号 {shortId(task.id)} · 目标 {(task.auth.targets || []).join(", ") || "—"} · 授权版本 v
            {runtime?.scopeVersion ?? task.scopeVersion ?? 1}
            {runtime?.externalState ? ` · 外部状态 ${runtime.externalState}` : ""}
            {runtime?.lastConfirmedAt ? ` · 最后确认 ${formatDateTime(runtime.lastConfirmedAt)}` : ""}
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
          {archivable ? (
            <Button
              icon={<IconArchive />}
              loading={actionBusy}
              onClick={() => void archiveTask()}
            >
              归档
            </Button>
          ) : null}
          {archived ? (
            <Button
              icon={<IconUndo />}
              loading={actionBusy}
              onClick={() => void unarchiveTask()}
            >
              取消归档
            </Button>
          ) : null}
          {active && task.status !== "pause_requested" && task.status !== "stopping" ? (
            <Button loading={actionBusy} onClick={() => void pauseTask()}>
              暂停
            </Button>
          ) : null}
          {paused ? (
            <Button
              type="primary"
              theme="solid"
              icon={<IconPlay />}
              loading={actionBusy}
              onClick={() => void resumeTask()}
            >
              继续
            </Button>
          ) : null}
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
        collapsible
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
                    {
                      key: "图相位",
                      value: (
                        <Tag color="blue" size="small">
                          {runtime?.phase ||
                            (runtime?.workerStatus as { phase?: string } | null)?.phase ||
                            "—"}
                        </Tag>
                      ),
                    },
                    {
                      key: "活跃 Intent",
                      value: shortId(
                        runtime?.activeIntentId ||
                          (runtime?.workerStatus as { activeIntentId?: string } | null)
                            ?.activeIntentId ||
                          "",
                      ) || "—",
                    },
                    { key: "租约持有者", value: runtime?.leaseOwner || "—" },
                    {
                      key: "租约到期",
                      value: runtime?.leaseUntil
                        ? formatDateTime(runtime.leaseUntil, true)
                        : "—",
                    },
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
                      key: "Reason 扇出硬顶",
                      value: `${runtime?.execution?.maxIntentsPerReason ?? task.execution?.maxIntentsPerReason ?? 4} / 同根 ${runtime?.execution?.maxIntentsPerAssetRoot ?? task.execution?.maxIntentsPerAssetRoot ?? 2}`,
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
              <IntegrationUsage usage={runtime?.integrations} />
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
                  taskId={task.id}
                  progress={runtime?.progress}
                  facts={runtime?.recentFacts}
                  trace={runtime?.trace}
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
              <Space>
                {active ? (
                  <Tag color="green" size="small">
                    实时同步
                  </Tag>
                ) : (
                  <Tag color="grey" size="small">
                    静止
                  </Tag>
                )}
                <Typography.Text type="tertiary" size="small">
                  与 Observe 同表 · asset_record 自动准入 · oos 不扇出利用
                </Typography.Text>
              </Space>
            }
          >
            {assets.length === 0 ? (
              <Empty
                title="暂无资产"
                description="创建任务后会从 auth.targets 写入种子行；运行中发现会追加。"
              />
            ) : (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  {(["live", "admitted", "seed", "oos", "candidate"] as const).map((k) => {
                    const n = assets.filter((a) => a.kind === k).length;
                    if (!n) return null;
                    return (
                      <Tag
                        key={k}
                        color={statusColor(
                          k === "oos" ? "failed" : k === "live" ? "ok" : "running",
                        )}
                        size="small"
                      >
                        {ASSET_KIND_LABEL[k] ?? k} {n}
                      </Tag>
                    );
                  })}
                </Space>
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
                          style={{
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          }}
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
                        <Tag
                          color={statusColor(
                            k === "oos" ? "failed" : k === "live" ? "ok" : "running",
                          )}
                          size="small"
                        >
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
              </>
            )}
          </Card>
        )}

        {tab === "goals" && (
          <Row gutter={16}>
            <Col span={24}>{dagPanel}</Col>
            <Col xs={24} sm={14} style={{ marginTop: 16 }}>
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
                            <Tag>{g.assessment ?? (g.passes ? "控制面记录已通过，待核对" : "未验证")}</Tag>
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
                          {g.reconcileGate && (
                            <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
                              核算条件：{g.reconcileGate.pattern}
                              （未知项≤{g.reconcileGate.maxUnknown}、重复主键歧义≤{g.reconcileGate.maxAmbiguous}；
                              只挂差异文件不算完成比对）
                              {!g.passes && rejectionByGoal.get(g.id)
                                ? ` · 未通过原因：${rejectionByGoal.get(g.id)}`
                                : ""}
                            </Typography.Paragraph>
                          )}
                          {g.passes && adoptedByGoal.get(g.id) && (
                            <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
                              首次通过采用的核算文件：{adoptedByGoal.get(g.id)!.path}
                              {" · SHA-256 "}
                              {adoptedByGoal.get(g.id)!.sha256}
                            </Typography.Paragraph>
                          )}
                          {history && <GoalCoverage
                            key={task.id + "/" + g.id}
                            taskId={task.id}
                            goalId={g.id}
                            record={history.coverage?.filter((row) => row.goalId === g.id).at(-1)}
                            onSaved={(row) => setHistory((prev) => prev && ({
                              ...prev, coverage: [...(prev.coverage ?? []).filter((r) => r.id !== row.id), row],
                            }))}
                          />}
                        </div>
                      }
                    />
                  )}
                />
              </Card>
            </Col>
            <Col xs={24} sm={10} style={{ marginTop: 16 }}>
              <Card
                title={`图前沿 · 开放意图 (${
                  (history?.intents ?? []).filter((i) =>
                    ["proposed", "claimed", "running"].includes(i.status),
                  ).length
                })`}
                style={{ background: "var(--semi-color-bg-1)" }}
                headerExtraContent={
                  <Typography.Text type="tertiary" size="small">
                    相位 {runtime?.phase || "—"}
                  </Typography.Text>
                }
              >
                <List
                  dataSource={(history?.intents ?? []).filter((i) =>
                    ["proposed", "claimed", "running"].includes(i.status),
                  )}
                  emptyContent="无开放 Intent — Reason 可扇出"
                  size="small"
                  renderItem={(i) => (
                    <List.Item
                      main={
                        <div>
                          <Space>
                            <StatusTag status={i.status} />
                            <Typography.Text
                              strong={
                                Boolean(
                                  runtime?.activeIntentId &&
                                    i.id === runtime.activeIntentId,
                                )
                              }
                            >
                              {i.title}
                            </Typography.Text>
                          </Space>
                          {i.sourceFactIds?.length ? (
                            <Typography.Text type="quaternary" size="small">
                              ← {i.sourceFactIds.map(shortId).join(", ")}
                              {i.claimedBy ? ` · ${i.claimedBy}` : ""}
                            </Typography.Text>
                          ) : null}
                        </div>
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
                    <List.Item
                      main={
                        <div>
                          <Typography.Text>{f.title}</Typography.Text>
                          <Typography.Text type="quaternary" size="small">
                            {shortId(f.id)}
                            {f.intentId ? ` ← ${shortId(f.intentId)}` : ""}
                          </Typography.Text>
                        </div>
                      }
                    />
                  )}
                />
              </Card>
            </Col>
          </Row>
        )}

        {tab === "findings" && (
          <Card
            title={`Finding 台账 · ${(history?.findings ?? []).length} 条`}
            style={{ background: "var(--semi-color-bg-1)" }}
            headerExtraContent={
              <Typography.Text type="tertiary" size="small">
                只读 History 投影 · tentative 不进交付 · verified 附封存证据
              </Typography.Text>
            }
          >
            {(history?.findings ?? []).length === 0 ? (
              <Empty
                title="暂无 Finding"
                description="Worker 发现线索会 finding_record；复现并封存证据后 finding_verify。"
              />
            ) : (
              <>
                <Space style={{ marginBottom: 12 }} wrap>
                  {(["critical", "high", "medium", "low", "info"] as const).map((s) => {
                    const n = (history?.findings ?? []).filter(
                      (f) => f.severity === s && f.status !== "retracted",
                    ).length;
                    if (!n) return null;
                    return (
                      <Tag key={s} color={findingSeverityColor(s)} size="small">
                        {FINDING_SEVERITY_LABEL[s]} {n}
                      </Tag>
                    );
                  })}
                </Space>
                <Table
                  size="small"
                  pagination={
                    (history?.findings ?? []).length > 20 ? { pageSize: 20 } : false
                  }
                  dataSource={(history?.findings ?? []).map((f) => ({ ...f, key: f.id }))}
                  expandedRowRender={(record?: FindingRecord) =>
                    record ? (
                    <div style={{ padding: "8px 16px" }}>
                      {record.cvss && (
                        <Typography.Paragraph size="small">
                          CVSS vector：{record.cvss}
                        </Typography.Paragraph>
                      )}
                      {record.repro && (
                        <Typography.Paragraph size="small">
                          复现：{record.repro}
                        </Typography.Paragraph>
                      )}
                      {record.impact && (
                        <Typography.Paragraph size="small">
                          影响：{record.impact}
                        </Typography.Paragraph>
                      )}
                      {record.fix && (
                        <Typography.Paragraph size="small">
                          修复建议：{record.fix}
                        </Typography.Paragraph>
                      )}
                      {record.evidence.length === 0 ? (
                        <Typography.Text type="tertiary" size="small">
                          暂无封存证据（tentative 线索）
                        </Typography.Text>
                      ) : (
                        record.evidence.map((e) => (
                          <div key={e.path}>
                            <Button
                              size="small"
                              theme="borderless"
                              onClick={async () => {
                                try {
                                  const r = await api.evidenceFile(task!.id, e.path);
                                  setFindingProof({ path: e.path, body: r.text });
                                } catch (err) {
                                  Toast.error(
                                    err instanceof Error ? err.message : String(err),
                                  );
                                }
                              }}
                            >
                              {e.path}
                            </Button>
                            <Typography.Text type="tertiary" size="small">
                              SHA-256 {e.sha256.slice(0, 16)}…
                            </Typography.Text>
                          </div>
                        ))
                      )}
                    </div>
                    ) : null
                  }
                  columns={[
                    {
                      title: "严重性",
                      dataIndex: "severity",
                      width: 90,
                      render: (s: string) => (
                        <Tag color={findingSeverityColor(s)} size="small">
                          {FINDING_SEVERITY_LABEL[s] ?? s}
                        </Tag>
                      ),
                    },
                    {
                      title: "标题",
                      dataIndex: "title",
                      width: 240,
                      ellipsis: true,
                    },
                    {
                      title: "资产 / 端点",
                      dataIndex: "asset",
                      width: 280,
                      render: (v: string, record: FindingRecord) => (
                        <Typography.Text
                          style={{
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          }}
                        >
                          {v}
                          {record.endpoint ? ` · ${record.endpoint}` : ""}
                        </Typography.Text>
                      ),
                    },
                    {
                      title: "类别",
                      dataIndex: "vulnClass",
                      width: 120,
                    },
                    {
                      title: "状态",
                      dataIndex: "status",
                      width: 110,
                      render: (s: string) => (
                        <Tag color={findingStatusColor(s)} size="small">
                          {FINDING_STATUS_LABEL[s] ?? s}
                        </Tag>
                      ),
                    },
                    {
                      title: "证据",
                      dataIndex: "evidence",
                      width: 70,
                      render: (e: FindingRecord["evidence"]) => e.length,
                    },
                    {
                      title: "记录时间",
                      dataIndex: "createdAt",
                      width: 180,
                      render: (t: string) => formatDateTime(t, true),
                    },
                  ]}
                />
                {findingProof && (
                  <Card
                    title={`证据 · ${findingProof.path}`}
                    style={{ marginTop: 12 }}
                    headerExtraContent={
                      <Button size="small" onClick={() => setFindingProof(null)}>
                        关闭
                      </Button>
                    }
                  >
                    <pre className="gy-mono">{findingProof.body}</pre>
                  </Card>
                )}
              </>
            )}
          </Card>
        )}

        {tab === "history" && (
          <Row gutter={16}>
            <Col span={24}>{dagPanel}</Col>
            <Col xs={24} sm={12} style={{ marginTop: 16 }}>
              <Card title="总览" style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{history?.overview || "—"}</pre>
              </Card>
            </Col>
            <Col xs={24} sm={12} style={{ marginTop: 16 }}>
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

        {tab === "report" && (
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <DeliveryScorecard taskId={task.id} refreshKey={history ? 1 : 0} />
            </Col>
            <Col span={24}>
              <ReconcilePanel taskId={task.id} onDone={() => void onRefresh()} />
            </Col>
            <Col span={24}>
              <Card style={{ background: "var(--semi-color-bg-1)" }}>
                <pre className="gy-mono">{paneText || "加载中…"}</pre>
              </Card>
            </Col>
          </Row>
        )}

        {tab === "logs" && (
          <Card style={{ background: "var(--semi-color-bg-1)" }}>
            <pre className="gy-mono">{paneText || "加载中…"}</pre>
          </Card>
        )}
      </div>
    </div>
  );
}
