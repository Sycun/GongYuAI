import { useEffect, useState } from "react";
import { Button, Card, Empty, Input, Table, Tabs, Tag, Typography } from "@douyinfe/semi-ui";
import type {
  Credential,
  FindingRetest,
  HttpTransaction,
  OastHit,
  OastToken,
  PlanStep,
} from "@gongyuai/contracts";
import { api, type AssetHistoryPayload, type TaskP14Payload, type TunnelMeta } from "../api";
import { shortId } from "../labels";
import { formatDateTime } from "../time";
import { StatusTag } from "./StatusTag";

const PLAN_STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  ready: "可执行",
  dispatched: "已派发",
  done: "完成",
  blocked: "受阻",
};

const PLAN_STATUS_COLOR: Record<string, "grey" | "blue" | "orange" | "green" | "red"> = {
  pending: "grey",
  ready: "blue",
  dispatched: "orange",
  done: "green",
  blocked: "red",
};

const CREDENTIAL_KIND_LABEL: Record<string, string> = {
  password: "密码",
  hash: "哈希",
  ticket: "票据",
  token: "令牌",
  key: "密钥",
  session: "会话",
  cookie: "Cookie",
  "foothold-shell": "立足点 Shell",
};

const CREDENTIAL_KIND_COLOR: Record<string, "grey" | "blue" | "orange" | "green" | "red"> = {
  password: "red",
  hash: "orange",
  ticket: "blue",
  token: "blue",
  key: "red",
  session: "orange",
  cookie: "orange",
  "foothold-shell": "green",
};

const RETEST_VERDICT_LABEL: Record<string, string> = {
  reproduced: "仍可复现",
  fixed: "已修复",
  inconclusive: "无法判定",
};

const RETEST_VERDICT_COLOR: Record<string, "red" | "green" | "grey"> = {
  reproduced: "red",
  fixed: "green",
  inconclusive: "grey",
};

function httpStatusColor(status: number): "green" | "blue" | "orange" | "red" | "grey" {
  if (status >= 200 && status < 300) return "green";
  if (status >= 300 && status < 400) return "blue";
  if (status >= 400 && status < 500) return "orange";
  if (status >= 500) return "red";
  return "grey";
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

function planDependencyCount(step: PlanStep): number {
  return step.needsFactIds.length + step.needsIntentIds.length + step.needsFindingIds.length;
}

function verifiedFindingCount(hit: AssetHistoryPayload["hits"][number]): number {
  return hit.findings.filter((finding) => finding.status === "verified").length;
}

/** P14 事务：请求/响应索引 + evidence 引用 `http:<id>`；响应摘要只作文本展示。 */
function TransactionsSection({ rows }: { rows: HttpTransaction[] }) {
  if (!rows.length) return <Empty description="暂无事务证据" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      expandedRowRender={(record?: HttpTransaction) =>
        record ? (
          <div style={{ padding: "8px 16px" }}>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              URL：{record.url}
            </Typography.Paragraph>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              开始时间：{formatDateTime(record.startedAt, true)}
            </Typography.Paragraph>
            {record.note ? (
              <Typography.Paragraph size="small" style={{ margin: 0 }}>
                备注：{record.note}
              </Typography.Paragraph>
            ) : null}
            {record.redirects.length ? (
              <Typography.Paragraph size="small" style={{ margin: 0 }}>
                跳转：{record.redirects.join(" → ")}
              </Typography.Paragraph>
            ) : null}
            <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0 4px" }}>
              响应头（内联摘要）
            </Typography.Paragraph>
            <Typography.Paragraph
              size="small"
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {record.responseHead || "（空）"}
            </Typography.Paragraph>
          </div>
        ) : null
      }
      columns={[
        {
          title: "方法",
          dataIndex: "method",
          width: 80,
          render: (method: string) => (
            <Typography.Text code size="small">
              {method}
            </Typography.Text>
          ),
        },
        {
          title: "状态",
          dataIndex: "status",
          width: 90,
          render: (status: number) => (
            <Tag color={httpStatusColor(status)} size="small">
              {status || "—"}
            </Tag>
          ),
        },
        {
          title: "目标（host + path）",
          dataIndex: "host",
          render: (_host: string, record: HttpTransaction) => (
            <Typography.Text style={{ wordBreak: "break-all" }}>
              {record.host}
              {record.path}
            </Typography.Text>
          ),
        },
        {
          title: "耗时",
          dataIndex: "durationMs",
          width: 100,
          render: (ms: number) => formatDuration(ms),
        },
        {
          title: "响应",
          dataIndex: "truncated",
          width: 90,
          render: (truncated: boolean) => (
            <Tag color={truncated ? "orange" : "grey"} size="small">
              {truncated ? "已截断" : "完整"}
            </Tag>
          ),
        },
        {
          title: "证据引用",
          dataIndex: "id",
          width: 300,
          render: (id: string) => (
            <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
              {`http:${id}`}
            </Typography.Text>
          ),
        },
      ]}
    />
  );
}

/** P14 计划：ord / 状态 / 标题 / 依赖数；步骤本身不派发，状态由系统派生。 */
function PlanSection({ rows }: { rows: PlanStep[] }) {
  if (!rows.length) return <Empty description="暂无计划步骤" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      expandedRowRender={(record?: PlanStep) =>
        record ? (
          <div style={{ padding: "8px 16px" }}>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              摘要：{record.summary || "—"}
            </Typography.Paragraph>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              关联 Intent：{record.intentId ? shortId(record.intentId) : "—"}
            </Typography.Paragraph>
            <Typography.Paragraph type="tertiary" size="small" style={{ margin: 0 }}>
              更新时间：{formatDateTime(record.updatedAt, true)}
            </Typography.Paragraph>
          </div>
        ) : null
      }
      columns={[
        { title: "序号", dataIndex: "ord", width: 70 },
        {
          title: "状态",
          dataIndex: "status",
          width: 100,
          render: (status: string) => (
            <Tag color={PLAN_STATUS_COLOR[status] ?? "grey"} size="small">
              {PLAN_STATUS_LABEL[status] ?? status}
            </Tag>
          ),
        },
        {
          title: "标题",
          dataIndex: "title",
          render: (title: string) => (
            <Typography.Text style={{ wordBreak: "break-all" }}>{title}</Typography.Text>
          ),
        },
        {
          title: "依赖数",
          dataIndex: "needsFactIds",
          width: 220,
          render: (_ids: string[], record: PlanStep) => (
            <Typography.Text type="tertiary" size="small">
              {planDependencyCount(record)}（事实 {record.needsFactIds.length} · Intent{" "}
              {record.needsIntentIds.length} · Finding {record.needsFindingIds.length}）
            </Typography.Text>
          ),
        },
      ]}
    />
  );
}

/** P14 凭据：只展示脱敏指针与复用统计，任何情况下都不渲染明文。 */
function CredentialsSection({ rows }: { rows: Credential[] }) {
  return (
    <>
      <Typography.Paragraph type="tertiary" size="small" style={{ margin: "0 0 8px" }}>
        仅展示脱敏后的 secretRef 指针，不展示任何明文密钥。
      </Typography.Paragraph>
      {rows.length ? (
        <Table
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={rows.length > 20 ? { pageSize: 20 } : false}
          columns={[
            {
              title: "类型",
              dataIndex: "kind",
              width: 120,
              render: (kind: string) => (
                <Tag color={CREDENTIAL_KIND_COLOR[kind] ?? "grey"} size="small">
                  {CREDENTIAL_KIND_LABEL[kind] ?? kind}
                </Tag>
              ),
            },
            {
              title: "资产",
              dataIndex: "asset",
              render: (asset: string) => (
                <Typography.Text style={{ wordBreak: "break-all" }}>{asset}</Typography.Text>
              ),
            },
            {
              title: "用户名",
              dataIndex: "username",
              width: 140,
              render: (username: string | null) => username || "—",
            },
            {
              title: "secretRef（已脱敏）",
              dataIndex: "secretRef",
              render: (secretRef: string) => (
                <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
                  {secretRef}
                </Typography.Text>
              ),
            },
            { title: "复用次数", dataIndex: "reuseCount", width: 100 },
          ]}
        />
      ) : (
        <Empty description="暂无凭据记录" style={{ padding: "24px 0" }} />
      )}
    </>
  );
}

/** P14 复测：verdict 与关联 finding 明确对应，证据哈希在展开行。 */
function RetestsSection({ rows }: { rows: FindingRetest[] }) {
  if (!rows.length) return <Empty description="暂无复测记录" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20 } : false}
      expandedRowRender={(record?: FindingRetest) =>
        record ? (
          <div style={{ padding: "8px 16px" }}>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              复现步骤：{record.repro || "—"}
            </Typography.Paragraph>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              备注：{record.note || "—"}
            </Typography.Paragraph>
            <Typography.Paragraph size="small" style={{ margin: 0 }}>
              关联 Finding：<Typography.Text code>{record.findingId}</Typography.Text>
            </Typography.Paragraph>
            <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0 4px" }}>
              封存证据
            </Typography.Paragraph>
            {record.evidence.length ? (
              record.evidence.map((entry) => (
                <div key={`${entry.path}:${entry.sha256}`} style={{ wordBreak: "break-all" }}>
                  <Typography.Text code size="small">
                    {entry.path}
                  </Typography.Text>
                  <Typography.Text type="tertiary" size="small">
                    {" "}
                    SHA-256 {entry.sha256}
                  </Typography.Text>
                </div>
              ))
            ) : (
              <Typography.Text type="tertiary" size="small">
                暂无封存证据
              </Typography.Text>
            )}
          </div>
        ) : null
      }
      columns={[
        {
          title: "结论",
          dataIndex: "verdict",
          width: 110,
          render: (verdict: string) => (
            <Tag color={RETEST_VERDICT_COLOR[verdict] ?? "grey"} size="small">
              {RETEST_VERDICT_LABEL[verdict] ?? verdict}
            </Tag>
          ),
        },
        {
          title: "关联 Finding",
          dataIndex: "findingId",
          width: 300,
          render: (findingId: string) => (
            <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
              {findingId}
            </Typography.Text>
          ),
        },
        { title: "复测人", dataIndex: "reviewer", width: 130 },
        {
          title: "时间",
          dataIndex: "createdAt",
          width: 170,
          render: (at: string) => formatDateTime(at, true),
        },
      ]}
    />
  );
}

/** P14 带外回调：令牌与命中分开，命中标注 sourceIp 与 protocol。 */
function OastSection({ tokens, hits }: { tokens: OastToken[]; hits: OastHit[] }) {
  return (
    <>
      <Typography.Title heading={6} style={{ margin: "0 0 8px" }}>
        令牌
      </Typography.Title>
      {tokens.length ? (
        <Table
          size="small"
          rowKey="token"
          dataSource={tokens}
          pagination={tokens.length > 20 ? { pageSize: 20 } : false}
          columns={[
            {
              title: "令牌",
              dataIndex: "token",
              width: 180,
              render: (token: string) => (
                <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
                  {token}
                </Typography.Text>
              ),
            },
            {
              title: "类型",
              dataIndex: "kind",
              width: 80,
              render: (kind: string) => (
                <Tag color={kind === "dns" ? "blue" : "green"} size="small">
                  {kind.toUpperCase()}
                </Tag>
              ),
            },
            {
              title: "回调地址",
              dataIndex: "callback",
              render: (callback: string) => (
                <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
                  {callback}
                </Typography.Text>
              ),
            },
            {
              title: "签发时间",
              dataIndex: "issuedAt",
              width: 170,
              render: (at: string) => formatDateTime(at, true),
            },
            {
              title: "到期时间",
              dataIndex: "expiresAt",
              width: 170,
              render: (at: string) => formatDateTime(at, true),
            },
            { title: "命中数", dataIndex: "hits", width: 80 },
          ]}
        />
      ) : (
        <Empty description="暂无带外令牌" style={{ padding: "24px 0" }} />
      )}
      <Typography.Title heading={6} style={{ margin: "20px 0 8px" }}>
        命中
      </Typography.Title>
      {hits.length ? (
        <Table
          size="small"
          rowKey={(record?: OastHit) => `${record?.token ?? ""}:${record?.at ?? ""}:${record?.sourceIp ?? ""}`}
          dataSource={hits}
          pagination={hits.length > 20 ? { pageSize: 20 } : false}
          columns={[
            {
              title: "令牌",
              dataIndex: "token",
              width: 160,
              render: (token: string) => (
                <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>
                  {token}
                </Typography.Text>
              ),
            },
            {
              title: "时间",
              dataIndex: "at",
              width: 170,
              render: (at: string) => formatDateTime(at, true),
            },
            { title: "sourceIp", dataIndex: "sourceIp", width: 140 },
            {
              title: "协议",
              dataIndex: "protocol",
              width: 80,
              render: (protocol: string) => (
                <Tag color={protocol === "dns" ? "blue" : "green"} size="small">
                  {protocol.toUpperCase()}
                </Tag>
              ),
            },
            {
              title: "请求",
              dataIndex: "path",
              render: (_path: string, record: OastHit) => (
                <Typography.Text style={{ wordBreak: "break-all" }}>
                  {record.method ? `${record.method} ` : ""}
                  {record.path || "—"}
                </Typography.Text>
              ),
            },
            {
              title: "User-Agent",
              dataIndex: "userAgent",
              render: (userAgent: string) => (
                <Typography.Text type="tertiary" size="small" style={{ wordBreak: "break-all" }}>
                  {userAgent || "—"}
                </Typography.Text>
              ),
            },
          ]}
        />
      ) : (
        <Empty description="暂无带外回调命中" style={{ padding: "24px 0" }} />
      )}
    </>
  );
}

function TunnelsSection({ rows }: { rows: TunnelMeta[] }) {
  if (!rows.length) return <Empty description="暂无本地隧道" style={{ padding: "24px 0" }} />;
  return (
    <Table
      pagination={false}
      size="small"
      rowKey="id"
      dataSource={rows}
      columns={[
        { title: "类型", dataIndex: "kind", width: 110 },
        {
          title: "本地",
          width: 150,
          render: (_: unknown, row: TunnelMeta) => `127.0.0.1:${row.localPort}`,
        },
        {
          title: "目标",
          render: (_: unknown, row: TunnelMeta) =>
            row.targetHost ? `${row.targetHost}:${row.targetPort ?? "-"}` : row.via ?? "-",
        },
        {
          title: "状态",
          width: 100,
          render: (_: unknown, row: TunnelMeta) => (
            <Tag color={row.status === "running" ? "green" : row.status === "error" ? "red" : "grey"}>
              {row.status}
            </Tag>
          ),
        },
        { title: "PID", dataIndex: "pid", width: 90 },
        {
          title: "命令",
          render: (_: unknown, row: TunnelMeta) => (
            <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 360 }}>
              {row.command}
            </Typography.Text>
          ),
        },
        {
          title: "错误",
          render: (_: unknown, row: TunnelMeta) =>
            row.error ? <Typography.Text type="danger">{row.error}</Typography.Text> : "—",
        },
      ]}
    />
  );
}

function P14Sections({ payload }: { payload: TaskP14Payload }) {
  return (
    <Card
      title="执行记录"
      style={{ background: "var(--semi-color-bg-1)" }}
      headerExtraContent={
        <Typography.Text type="tertiary" size="small">
          只读 · 证据索引与脱敏指针
        </Typography.Text>
      }
    >
      <Tabs type="line" collapsible defaultActiveKey="transactions">
        <Tabs.TabPane itemKey="transactions" tab={`事务 ${payload.transactions.length}`}>
          <TransactionsSection rows={payload.transactions} />
        </Tabs.TabPane>
        <Tabs.TabPane itemKey="plan" tab={`计划 ${payload.plan.length}`}>
          <PlanSection rows={payload.plan} />
        </Tabs.TabPane>
        <Tabs.TabPane itemKey="credentials" tab={`凭据 ${payload.credentials.length}`}>
          <CredentialsSection rows={payload.credentials} />
        </Tabs.TabPane>
        <Tabs.TabPane itemKey="retests" tab={`复测 ${payload.retests.length}`}>
          <RetestsSection rows={payload.retests} />
        </Tabs.TabPane>
        <Tabs.TabPane
          itemKey="oast"
          tab={`OAST 令牌 ${payload.oastTokens.length} · 命中 ${payload.oastHits.length}`}
        >
          <OastSection tokens={payload.oastTokens} hits={payload.oastHits} />
        </Tabs.TabPane>
        <Tabs.TabPane itemKey="tunnels" tab={`隧道 ${payload.tunnels?.length ?? 0}`}>
          <TunnelsSection rows={payload.tunnels ?? []} />
        </Tabs.TabPane>
      </Tabs>
    </Card>
  );
}

/** 顶部「历史接触」：手动输入 host/URL 才查询，结果只作线索展示。 */
function HistoryContact({ taskId }: { taskId: string }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssetHistoryPayload | null>(null);

  async function query() {
    const value = address.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { json } = await api.getAssetHistory(taskId, value);
      setResult(json);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="历史接触"
      style={{ background: "var(--semi-color-bg-1)" }}
      headerExtraContent={
        <Typography.Text type="tertiary" size="small">
          只读线索 · 不自动查询 · 不等于本次授权
        </Typography.Text>
      }
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Input
          value={address}
          onChange={setAddress}
          onEnterPress={() => void query()}
          placeholder="host 或 URL，例如 p14.lab.test"
          aria-label="历史接触地址"
          style={{ width: 360, maxWidth: "100%" }}
        />
        <Button
          theme="solid"
          type="primary"
          loading={busy}
          disabled={!address.trim()}
          onClick={() => void query()}
        >
          查询
        </Button>
      </div>
      {error ? (
        <Typography.Paragraph type="danger" style={{ margin: "12px 0 0" }}>
          历史接触读取失败：{error}
        </Typography.Paragraph>
      ) : null}
      {result ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph style={{ margin: "0 0 8px" }}>
            历史接触 · {result.host || "—"} · {result.hits.length} 条
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="taskId"
            dataSource={result.hits}
            pagination={result.hits.length > 10 ? { pageSize: 10 } : false}
            empty="暂无历史接触"
            columns={[
              {
                title: "任务名",
                dataIndex: "name",
                render: (name: string, record: AssetHistoryPayload["hits"][number]) => (
                  <div style={{ wordBreak: "break-all" }}>
                    <Typography.Text strong>{name}</Typography.Text>
                    <Typography.Text type="tertiary" size="small">
                      {" "}
                      {shortId(record.taskId)}
                    </Typography.Text>
                  </div>
                ),
              },
              {
                title: "状态",
                dataIndex: "status",
                width: 130,
                render: (status: string) => <StatusTag status={status} />,
              },
              {
                title: "已复现 finding",
                dataIndex: "findings",
                width: 140,
                render: (_findings: unknown, record: AssetHistoryPayload["hits"][number]) =>
                  verifiedFindingCount(record),
              },
            ]}
          />
          <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0 0" }}>
            {result.note}
          </Typography.Paragraph>
        </div>
      ) : null}
    </Card>
  );
}

export function P14Panel({ taskId }: { taskId: string }) {
  const [payload, setPayload] = useState<TaskP14Payload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPayload(null);
    api
      .getTaskP14(taskId, controller.signal)
      .then(({ json }) => {
        if (!cancelled) setPayload(json);
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [taskId, attempt]);

  return (
    <div>
      <HistoryContact taskId={taskId} />
      <div style={{ marginTop: 12 }}>
        {payload ? (
          <>
            {error ? (
              <Card style={{ background: "var(--semi-color-bg-1)", marginBottom: 12 }}>
                <Typography.Paragraph type="danger" style={{ margin: "0 0 8px" }}>
                  执行记录读取失败：{error}
                </Typography.Paragraph>
                <Button loading={loading} onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </Button>
              </Card>
            ) : null}
            <P14Sections payload={payload} />
          </>
        ) : (
          <Card style={{ background: "var(--semi-color-bg-1)" }}>
            {error ? (
              <>
                <Typography.Paragraph type="danger" style={{ margin: "0 0 8px" }}>
                  执行记录读取失败：{error}
                </Typography.Paragraph>
                <Button loading={loading} onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </Button>
              </>
            ) : (
              <Typography.Text type="tertiary">正在读取执行记录…</Typography.Text>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
