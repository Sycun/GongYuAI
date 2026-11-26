import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  Button, Card, Col, Collapsible, Descriptions, Empty, List, Row, Space, Tabs, Tag, TextArea, Toast, Typography,
} from "@douyinfe/semi-ui";
import { IconArchive, IconPlay, IconRefresh, IconStop, IconUndo } from "@douyinfe/semi-icons";
import {
  api,
  type AssetRecord,
  type HistoryPayload,
  type RuntimePayload,
  type TaskRecord,
} from "../api";
import {
  DETAIL_TABS,
  type DetailTab,
  formatWorkerStatus,
  isActiveStatus,
  isArchivableStatus,
  isArchivedTask,
  isPausedStatus,
  isStartableStatus,
  shortId,
} from "../labels";
import { StatusTag } from "../components/StatusTag";
import { GoalCoverage } from "../components/GoalCoverage";
import { GoalReconcileCard, type AdoptedReconcile } from "../components/GoalReconcileCard";
import { TaskOps } from "../components/TaskOps";
import { CommandReviewCard } from "../components/CommandReviewCard";
import { IntegrationUsage } from "../components/IntegrationUsage";
import { BattlefieldPanel } from "../components/BattlefieldPanel";
import { TrafficPanel } from "../components/TrafficPanel";
import { FindingsPanel } from "../components/FindingsPanel";
import { LogsPanel } from "../components/LogsPanel";
import { assetNodeId } from "../components/dag/buildDagLayout";
import { formatDateTime } from "../time";
import type { PlanStep } from "@gongyuai/contracts";

const FactIntentDag = lazy(() => import("../components/dag/FactIntentDag"));

class DagErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Card title="意图图谱">
        <Space>
          <Typography.Text role="alert">关系图加载失败</Typography.Text>
          <Button size="small" onClick={() => window.location.reload()}>重新加载页面</Button>
        </Space>
      </Card>
    );
  }
}

type Props = {
  task: TaskRecord | null;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  onRefresh: () => Promise<void>;
  focus?: Record<string, string>;
  refreshNonce?: number;
};

export function TaskDetailPage({ task, tab, onTabChange, onRefresh, focus, refreshNonce = 0 }: Props) {
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [liveUsage, setLiveUsage] = useState<TaskRecord["usage"] | null>(null);
  const [hints, setHints] = useState<Array<{ id: string; text: string; source: string; createdAt: string }>>([]);
  const [hintDraft, setHintDraft] = useState("");
  const [hintBusy, setHintBusy] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        if (tab === "live" || tab === "graph" || tab === "findings" || tab === "traffic" || tab === "logs") {
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
        if (tab === "logs") {
          try {
            const p = await api.getTaskP14(task!.id);
            if (!cancelled) setPlan(p.json.plan ?? []);
          } catch { /* 计划缺失不阻塞日志 */ }
        }
      } catch (e) {
        if (!cancelled) Toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [task?.id, task?.status, tab, historyTick, refreshNonce]);

  useEffect(() => {
    if (!task || !isActiveStatus(task.status)) return;
    if (tab !== "live" && tab !== "graph" && tab !== "findings" && tab !== "assets" && tab !== "logs") return;
    let cancelled = false;
    const tick = async () => {
      try {
        if (tab === "live" || tab === "graph" || tab === "findings" || tab === "logs") {
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
        await onRefresh();
      } catch { /* 轮询失败静默 */ }
    };
    const timer = window.setInterval(() => void tick(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [task?.id, task?.status, tab, onRefresh]);

  useEffect(() => { setLiveUsage(null); }, [task?.id]);

  if (!task) {
    return <Empty title="未选择任务" description="请先在「任务」里选择一个任务。" style={{ padding: 48 }} />;
  }

  const usage = liveUsage ?? task.usage;
  const active = isActiveStatus(task.status);
  const paused = isPausedStatus(task.status);
  const startable = isStartableStatus(task.status);
  const archived = isArchivedTask(task);
  const archivable = isArchivableStatus(task.status) && !archived;

  const runAction = async (fn: () => Promise<unknown>, ok: string, guard: boolean) => {
    if (!guard || actionBusy) return;
    setActionBusy(true);
    try {
      await fn();
      Toast.success(ok);
      await onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const reloadAfterGoalAction = async () => {
    setHistoryTick((n) => n + 1);
    await onRefresh();
  };

  const goals = history?.goals?.length ? history.goals : task.goals;
  const goalEvents = history?.events ?? [];
  const adoptedByGoal = new Map<string, AdoptedReconcile>();
  for (const event of [...goalEvents].reverse()) {
    const payload = (event?.payload ?? {}) as { goalId?: string; adoptedReconcile?: AdoptedReconcile };
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
  const passedGoals = goals.filter((g) => g.passes).length;

  const graphFocus = focus?.intent || focus?.fact || focus?.finding
    || (focus?.asset ? assetNodeId(focus.asset) : undefined);

  return (
    <div>
      <div className="gy-task-heading">
        <div>
          <Space align="center" spacing={12}>
            <Typography.Title heading={4} style={{ margin: 0 }}>{task.name}</Typography.Title>
            <StatusTag status={task.status} />
            {archived ? <Tag color="grey">已归档</Tag> : null}
          </Space>
          <Typography.Text type="tertiary" style={{ display: "block", marginTop: 6 }}>
            编号 {shortId(task.id)} · 授权范围 {(task.auth.targets || []).join(", ") || "—"} · 授权版本 v
            {runtime?.scopeVersion ?? task.scopeVersion ?? 1}
            {runtime?.externalState ? ` · 外部状态 ${runtime.externalState}` : ""}
            {runtime?.lastConfirmedAt ? ` · 最后确认 ${formatDateTime(runtime.lastConfirmedAt)}` : ""}
          </Typography.Text>
          {task.error ? (
            <Typography.Text type="danger" style={{ display: "block", marginTop: 4 }}>{task.error}</Typography.Text>
          ) : null}
        </div>
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void onRefresh()} loading={loading}>刷新</Button>
          {archivable ? <Button icon={<IconArchive />} loading={actionBusy} onClick={() => void runAction(() => api.archive(task.id), "已归档", archivable)}>归档</Button> : null}
          {archived ? <Button icon={<IconUndo />} loading={actionBusy} onClick={() => void runAction(() => api.unarchive(task.id), "已取消归档", archived)}>取消归档</Button> : null}
          {active && task.status !== "pause_requested" && task.status !== "stopping" ? (
            <Button loading={actionBusy} onClick={() => void runAction(() => api.pause(task.id), "已请求暂停；确认 worker 退出后显示已暂停", active)}>暂停</Button>
          ) : null}
          {paused ? <Button type="primary" theme="solid" icon={<IconPlay />} loading={actionBusy} onClick={() => void runAction(() => api.resume(task.id), "已继续；本次运行读取最新授权版本", paused)}>继续</Button> : null}
          {active ? (
            <Button type="danger" theme="solid" icon={<IconStop />} loading={actionBusy} onClick={() => void runAction(() => api.stop(task.id), "已发送停止", active)}>停止</Button>
          ) : startable ? (
            <Button type="primary" theme="solid" icon={<IconPlay />} loading={actionBusy} onClick={() => void runAction(() => api.start(task.id), "已开始运行", startable)}>开始</Button>
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
          <>
            <TaskOps taskId={task.id} focus={focus} />
            {task.commandReview && (
              <div style={{ margin: "12px 0" }}>
                <CommandReviewCard taskId={task.id} review={task.commandReview} onDecided={onRefresh} />
              </div>
            )}
            <Row gutter={16}>
              <Col span={12}>
                <Card title="持久运行" style={{ background: "var(--semi-color-bg-1)" }}>
                  <Descriptions
                    align="left"
                    data={[
                      { key: "图相位", value: <Tag color="blue" size="small">{runtime?.phase || (runtime?.workerStatus as { phase?: string } | null)?.phase || "—"}</Tag> },
                      { key: "活跃 Intent", value: shortId(runtime?.activeIntentId || (runtime?.workerStatus as { activeIntentId?: string } | null)?.activeIntentId || "") || "—" },
                      { key: "租约持有者", value: runtime?.leaseOwner || "—" },
                      { key: "租约到期", value: runtime?.leaseUntil ? formatDateTime(runtime.leaseUntil, true) : "—" },
                      { key: "栅栏号", value: String(runtime?.fence ?? task.fence) },
                      { key: "检查点", value: runtime?.hasCheckpoint ? "有" : "无" },
                      { key: "Explore 并发", value: String(runtime?.execution?.maxConcurrentExplores ?? task.execution?.maxConcurrentExplores ?? 3) },
                      { key: "Reason 扇出硬顶", value: `${runtime?.execution?.maxIntentsPerReason ?? task.execution?.maxIntentsPerReason ?? 4} / 同根 ${runtime?.execution?.maxIntentsPerAssetRoot ?? task.execution?.maxIntentsPerAssetRoot ?? 2}` },
                      { key: "工作进程", value: (runtime?.workerPids?.length ? runtime.workerPids : runtime?.workerPid ? [runtime.workerPid] : []).join(", ") || "—" },
                    ]}
                  />
                </Card>
              </Col>
              <Col span={12}>
                <Card title="预算" style={{ background: "var(--semi-color-bg-1)" }}>
                  <Descriptions
                    align="left"
                    data={[
                      { key: "工具调用", value: `${usage.toolCalls} / ${task.budget.maxToolCalls > 0 ? task.budget.maxToolCalls : "∞"}` },
                      { key: "安装次数", value: `${usage.installs} / ${task.budget.maxInstalls > 0 ? task.budget.maxInstalls : "∞"}` },
                      { key: "Token", value: `${usage.tokens} / ${task.budget.maxTokens > 0 ? task.budget.maxTokens : "∞"}` },
                      { key: "墙钟上限", value: task.budget.maxWallMs > 0 ? `${Math.round(task.budget.maxWallMs / 3_600_000)}h` : "∞" },
                      { key: "任务备注", value: task.auth.authorizationNote || "—" },
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
                  headerExtraContent={<Typography.Text type="tertiary" size="small">写入 History · 下次 Observe 吸收</Typography.Text>}
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
                              <Typography.Text type="tertiary" size="small">{h.source} · {formatDateTime(h.createdAt, true)}</Typography.Text>
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
                <Card title="执行节点状态" style={{ background: "var(--semi-color-bg-1)" }}>
                  <Descriptions align="left" data={formatWorkerStatus(runtime?.workerStatus)} />
                </Card>
              </Col>
            </Row>
          </>
        )}

        {tab === "assets" && (
          <BattlefieldPanel taskId={task.id} assets={assets} active={active} focusAsset={focus?.asset} />
        )}

        {tab === "graph" && (
          <div className="gy-graph-tab">
            <Card
              className="gy-graph-goals"
              style={{ background: "var(--semi-color-bg-1)" }}
              bodyStyle={{ paddingTop: 8 }}
            >
              <button type="button" className="gy-exec-group-head" onClick={() => setGoalsOpen((v) => !v)} aria-expanded={goalsOpen}>
                <Typography.Text strong>目标契约与完成度</Typography.Text>
                <Tag size="small" color={passedGoals === goals.length && goals.length > 0 ? "green" : "orange"}>
                  {passedGoals} / {goals.length} 通过
                </Tag>
                <Typography.Text type="tertiary" size="small" style={{ marginLeft: "auto" }}>
                  {goalsOpen ? "收起" : "展开查看验收条件与覆盖记录"}
                </Typography.Text>
              </button>
              <Collapsible isOpen={goalsOpen}>
                <List
                  dataSource={goals}
                  emptyContent={loading ? "正在读取目标…" : "暂无目标"}
                  renderItem={(g) => {
                    const adopted = adoptedByGoal.get(g.id) ?? null;
                    const businessGoal = g.kind === "business-reconcile" || Boolean(g.business);
                    return (
                      <List.Item
                        main={
                          <div>
                            <Space wrap>
                              <Typography.Text strong>{g.title}</Typography.Text>
                              <Tag>{g.assessment ?? (g.passes ? "控制面记录已通过，待核对" : "未验证")}</Tag>
                              {businessGoal ? <Tag color="violet" size="small">业务核算</Tag> : null}
                            </Space>
                            <Typography.Paragraph type="tertiary" style={{ margin: "4px 0 0", maxWidth: "85ch", overflowWrap: "anywhere" }}>
                              {g.description}
                            </Typography.Paragraph>
                            <Descriptions
                              align="left" size="small" style={{ marginTop: 8, overflowWrap: "anywhere" }}
                              data={[
                                { key: "所需证据", value: g.evidencePatterns?.join("、") || "—" },
                                { key: "已记录证据", value: g.evidencePaths?.join("、") || "暂无" },
                              ]}
                            />
                            {g.reconcileGate && (
                              <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
                                核算条件：{g.reconcileGate.pattern}
                                （未知项≤{g.reconcileGate.maxUnknown}、重复主键歧义≤{g.reconcileGate.maxAmbiguous}；只挂差异文件不算完成比对）
                                {!g.passes && rejectionByGoal.get(g.id) ? ` · 未通过原因：${rejectionByGoal.get(g.id)}` : ""}
                              </Typography.Paragraph>
                            )}
                            {businessGoal && (
                              <GoalReconcileCard taskId={task.id} goal={g} adopted={adopted} onChanged={reloadAfterGoalAction} />
                            )}
                            {g.passes && adopted && !businessGoal && (
                              <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
                                首次通过采用的核算文件：{adopted.path} · SHA-256 {adopted.sha256}
                              </Typography.Paragraph>
                            )}
                            {history && (
                              <GoalCoverage
                                key={task.id + "/" + g.id}
                                taskId={task.id}
                                goalId={g.id}
                                record={history.coverage?.filter((row) => row.goalId === g.id).at(-1)}
                                onSaved={(row) => setHistory((prev) => prev && ({
                                  ...prev, coverage: [...(prev.coverage ?? []).filter((r) => r.id !== row.id), row],
                                }))}
                              />
                            )}
                          </div>
                        }
                      />
                    );
                  }}
                />
              </Collapsible>
            </Card>
            <DagErrorBoundary>
              <Suspense fallback={<div className="gy-dag-empty" role="status">正在加载关系图…</div>}>
                <FactIntentDag
                  key={graphFocus}
                  facts={history?.facts ?? []}
                  intents={history?.intents ?? []}
                  findings={history?.findings ?? []}
                  assets={history?.assets ?? []}
                  serverDag={history?.dag}
                  height={560}
                  loading={loading}
                  focusId={graphFocus}
                />
              </Suspense>
            </DagErrorBoundary>
          </div>
        )}

        {tab === "traffic" && (
          <TrafficPanel taskId={task.id} intents={(history?.intents ?? []).map((i) => ({ id: i.id, title: i.title }))} />
        )}

        {tab === "findings" && (
          <FindingsPanel
            taskId={task.id}
            findings={history?.findings ?? []}
            goals={goals}
            focusFinding={focus?.finding}
            refreshKey={historyTick + refreshNonce}
            onRefresh={() => void reloadAfterGoalAction()}
          />
        )}

        {tab === "logs" && (
          <LogsPanel
            taskId={task.id}
            runtime={runtime}
            active={active}
            intents={(history?.intents ?? []).map((i) => ({ id: i.id, title: i.title }))}
            plan={plan}
          />
        )}
      </div>
    </div>
  );
}