import { useEffect, useMemo, useState } from "react";
import {
  Button, Card, Empty, Input, SideSheet, Space, Spin, Table, Tabs, Tag, Toast, Typography,
} from "@douyinfe/semi-ui";
import { IconCopy } from "@douyinfe/semi-icons";
import type { Credential, HostProfile, OastHit, OastToken } from "@gongyuai/contracts";
import { api, type AssetRecord, type AssetHistoryPayload, type TaskP14Payload, type TunnelMeta } from "../api";
import { ASSET_KIND_LABEL, shortId, statusColor } from "../labels";
import { formatDateTime } from "../time";
import { ChatMarkdown } from "./ChatMarkdown";
import {
  copyTextWithFallback,
  isMarkdownPath,
  resolveSecretRefTarget,
} from "./secretRefPreview";
import { StatusTag } from "./StatusTag";
import { useClientPagination } from "./useClientPagination";

const CREDENTIAL_KIND_LABEL: Record<string, string> = {
  password: "密码", hash: "哈希", ticket: "票据", token: "令牌", key: "密钥",
  session: "会话", cookie: "Cookie", "foothold-shell": "立足点 Shell",
};
const CREDENTIAL_KIND_COLOR: Record<string, "grey" | "blue" | "orange" | "green" | "red"> = {
  password: "red", hash: "orange", ticket: "blue", token: "blue", key: "red",
  session: "orange", cookie: "orange", "foothold-shell": "green",
};

type ActiveSecretPreview = {
  secretRef: string;
  credential?: Credential;
  label?: string;
};

type LoadedEvidence = {
  path: string;
  body: string;
  kind: "file" | "traffic";
};

type Props = {
  taskId: string;
  assets: AssetRecord[];
  active: boolean;
  focusAsset?: string;
};

export function BattlefieldPanel({ taskId, assets, active, focusAsset }: Props) {
  const [payload, setPayload] = useState<TaskP14Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activePreview, setActivePreview] = useState<ActiveSecretPreview | null>(null);

  useEffect(() => {
    setActivePreview(null);
  }, [taskId]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setError(null);
    api.getTaskP14(taskId, controller.signal)
      .then(({ json }) => { if (!cancelled) setPayload(json); })
      .catch((err) => { if (!cancelled && !controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; controller.abort(); };
  }, [taskId, attempt]);

  const credentials = useMemo(() => payload?.credentials ?? [], [payload]);
  const sessions = useMemo(
    () => credentials.filter((c) => c.kind === "session" || c.kind === "foothold-shell"),
    [credentials],
  );
  const hostProfiles = useMemo(() => payload?.hostProfiles ?? [], [payload]);
  const assetPager = useClientPagination(assets, 20, taskId);

  return (
    <div className="gy-battlefield">
      <Card
        title={`资产清单 · ${assets.length} 条`}
        style={{ background: "var(--semi-color-bg-1)" }}
        headerExtraContent={
          <Space>
            <Tag color={active ? "green" : "grey"} size="small">{active ? "实时同步" : "静止"}</Tag>
            <Typography.Text type="tertiary" size="small">授权靶标与运行中发现 · 范围外不扇出利用</Typography.Text>
          </Space>
        }
      >
        {assets.length === 0 ? (
          <Empty title="暂无资产" description="创建任务后从授权范围写入种子；运行中发现会追加。" />
        ) : (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              {(["live", "admitted", "seed", "oos", "candidate"] as const).map((k) => {
                const n = assets.filter((a) => a.kind === k).length;
                if (!n) return null;
                return <Tag key={k} color={statusColor(k === "oos" ? "failed" : k === "live" ? "ok" : "running")} size="small">{ASSET_KIND_LABEL[k] ?? k} {n}</Tag>;
              })}
            </Space>
            <Table
              size="small" rowKey="address"
              pagination={assetPager.pagination}
              dataSource={assetPager.dataSource}
              rowClassName={(record?: AssetRecord) => record?.address === focusAsset ? "gy-list-active" : ""}
              columns={[
                { title: "地址 / 模式", dataIndex: "address", render: (v: string) => <Typography.Text style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{v}</Typography.Text> },
                { title: "状态", dataIndex: "kind", width: 100, render: (k: string) => <Tag color={statusColor(k === "oos" ? "failed" : k === "live" ? "ok" : "running")} size="small">{ASSET_KIND_LABEL[k] ?? k}</Tag> },
                { title: "来源", dataIndex: "source", width: 90, render: (s: string) => s === "auth" ? "授权" : "发现" },
                { title: "说明", dataIndex: "summary", ellipsis: true },
                { title: "Fact", dataIndex: "factId", width: 100, render: (id: string) => shortId(id) },
                { title: "更新", dataIndex: "createdAt", width: 170, render: (t: string) => formatDateTime(t, true) },
              ]}
            />
          </>
        )}
      </Card>

      <Card
        title="战场对象"
        style={{ background: "var(--semi-color-bg-1)", marginTop: 16 }}
        headerExtraContent={
          error ? <Button size="small" onClick={() => setAttempt((v) => v + 1)}>重试</Button>
            : <Typography.Text type="tertiary" size="small">只读</Typography.Text>
        }
      >
        {error && <Typography.Paragraph type="danger" style={{ margin: "0 0 8px" }}>战场对象读取失败：{error}</Typography.Paragraph>}
        {!payload && !error ? <Typography.Text type="tertiary">正在读取战场对象…</Typography.Text> : (
          <Tabs type="line" collapsible defaultActiveKey="hosts">
            <Tabs.TabPane itemKey="hosts" tab={`主机画像 ${hostProfiles.length}`}>
              <HostProfileSection
                taskId={taskId}
                rows={hostProfiles}
                onOpenEvidence={(path, asset) => setActivePreview({ secretRef: path, label: `主机画像 · ${asset}` })}
              />
            </Tabs.TabPane>
            <Tabs.TabPane itemKey="credentials" tab={`已获凭据 ${credentials.length}`}>
              <CredentialsSection
                taskId={taskId}
                rows={credentials}
                activeCredentialId={activePreview?.credential?.id}
                onOpenPreview={(cred) => setActivePreview({ secretRef: cred.secretRef, credential: cred })}
              />
            </Tabs.TabPane>
            <Tabs.TabPane itemKey="sessions" tab={`驻留会话 ${sessions.length}`}>
              <SessionsSection
                taskId={taskId}
                rows={sessions}
                activeCredentialId={activePreview?.credential?.id}
                onOpenPreview={(cred) => setActivePreview({ secretRef: cred.secretRef, credential: cred })}
              />
            </Tabs.TabPane>
            <Tabs.TabPane itemKey="tunnels" tab={`隧道 ${payload?.tunnels?.length ?? 0}`}>
              <TunnelsSection rows={payload?.tunnels ?? []} />
            </Tabs.TabPane>
            <Tabs.TabPane itemKey="oast" tab={`带外回调 ${(payload?.oastTokens.length ?? 0)}/${(payload?.oastHits.length ?? 0)}`}>
              <OastSection taskId={taskId} tokens={payload?.oastTokens ?? []} hits={payload?.oastHits ?? []} />
            </Tabs.TabPane>
          </Tabs>
        )}
      </Card>

      <div style={{ marginTop: 16 }}>
        <HistoryContact taskId={taskId} />
      </div>

      <SecretPreviewSheet
        taskId={taskId}
        preview={activePreview}
        onClose={() => setActivePreview(null)}
      />
    </div>
  );
}

function HostProfileSection({
  taskId,
  rows,
  onOpenEvidence,
}: {
  taskId: string;
  rows: HostProfile[];
  onOpenEvidence: (evidencePath: string, asset: string) => void;
}) {
  const pager = useClientPagination(rows, 20, taskId);
  if (!rows.length) return <Empty description="暂无主机画像；立足点后由执行节点回填。" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small" rowKey="id" dataSource={pager.dataSource}
      pagination={pager.pagination}
      expandedRowRender={(record?: HostProfile) => record ? (
        <div style={{ padding: "8px 16px", display: "grid", gap: 4 }}>
          <ProfileList label="用户" items={record.users} />
          <ProfileList label="权限" items={record.privileges} />
          <ProfileList label="服务" items={record.services} />
          <ProfileList label="共享" items={record.shares} />
          <ProfileList label="AV/EDR 信号" items={record.av} />
          {record.evidencePath && (
            <Space spacing={6} wrap>
              <Typography.Text type="tertiary" size="small">证据：{record.evidencePath}</Typography.Text>
              {resolveSecretRefTarget(record.evidencePath).kind !== "none" && (
                <Button
                  size="small"
                  theme="light"
                  type="primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenEvidence(record.evidencePath!, record.asset);
                  }}
                >
                  查看
                </Button>
              )}
            </Space>
          )}
        </div>
      ) : null}
      columns={[
        { title: "资产", dataIndex: "asset", render: (v: string) => <Typography.Text style={{ fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all" }}>{v}</Typography.Text> },
        { title: "主机名", dataIndex: "hostname", width: 140, render: (v: string | null) => v || "—" },
        { title: "操作系统", dataIndex: "os", width: 140, render: (v: string | null) => v || "—" },
        { title: "域", dataIndex: "domain", width: 130, render: (v: string | null) => v || "—" },
        { title: "用户/权限", dataIndex: "users", width: 110, render: (_: unknown, r: HostProfile) => `${r.users.length} / ${r.privileges.length}` },
        { title: "更新", dataIndex: "updatedAt", width: 170, render: (t: string) => formatDateTime(t, true) },
      ]}
    />
  );
}

function ProfileList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <Typography.Text size="small" style={{ wordBreak: "break-all" }}>
      <Typography.Text type="tertiary" size="small">{label}：</Typography.Text>{items.join("、")}
    </Typography.Text>
  );
}

async function readSecretRefEvidence(
  taskId: string,
  secretRef: string,
  signal?: AbortSignal,
): Promise<LoadedEvidence> {
  const target = resolveSecretRefTarget(secretRef);
  if (target.kind === "none") {
    throw new Error("该引用为环境变量或非文件指针，不含可预览证据文件");
  }
  if (target.kind === "http") {
    const [reqSlice, resSlice] = await Promise.all([
      api.trafficBlob(taskId, target.trafficId, "req", 0, 32_768, signal).catch(() => null),
      api.trafficBlob(taskId, target.trafficId, "res", 0, 65_536, signal),
    ]);
    const parts = [
      reqSlice?.json.body ? `### Request\n${reqSlice.json.body}` : "",
      `### Response\n${resSlice.json.body}`,
    ].filter(Boolean);
    return {
      path: `http:${target.trafficId}`,
      body: parts.join("\n\n"),
      kind: "traffic",
    };
  }

  let lastError: unknown;
  for (const path of target.paths) {
    try {
      const res = await api.evidenceFile(taskId, path, {
        signal,
        fallbackWorkspace: true,
      });
      return { path, body: res.text, kind: "file" };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "无法读取证据文件");
  throw new Error(
    reason === "not found"
      ? `未找到对应证据文件（已尝试：${target.paths.join("、")}）`
      : reason,
  );
}

function SecretRefCell({
  secretRef,
  active,
  onOpen,
}: {
  secretRef: string;
  active?: boolean;
  onOpen: () => void;
}) {
  const canPreview = resolveSecretRefTarget(secretRef).kind !== "none";
  return (
    <Space spacing={6} wrap>
      <Typography.Text code copyable size="small" style={{ wordBreak: "break-all" }}>
        {secretRef}
      </Typography.Text>
      {canPreview && (
        <Button
          size="small"
          theme={active ? "solid" : "light"}
          type="primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          查看
        </Button>
      )}
    </Space>
  );
}

function SecretPreviewSheet({
  taskId,
  preview,
  onClose,
}: {
  taskId: string;
  preview: ActiveSecretPreview | null;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<LoadedEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [viewMode, setViewMode] = useState<"raw" | "markdown">("raw");

  const secretRef = preview?.secretRef ?? "";
  const cred = preview?.credential;

  useEffect(() => {
    if (!preview) {
      setLoaded(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    setLoaded(null);
    setViewMode("raw");

    readSecretRefEvidence(taskId, preview.secretRef, ac.signal)
      .then((res) => {
        if (cancelled) return;
        setLoaded(res);
      })
      .catch((err) => {
        if (cancelled || ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [taskId, preview, reloadNonce]);

  const markdownCapable = loaded ? isMarkdownPath(loaded.path) || isMarkdownPath(secretRef) : false;

  const copyText = async (text: string, label: string) => {
    try {
      await copyTextWithFallback(text);
      Toast.success(label);
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "复制失败");
    }
  };

  return (
    <SideSheet
      className="gy-finding-sheet"
      title={cred ? `凭据证据预览 · ${cred.asset}` : (preview?.label ?? "证据文件预览")}
      visible={Boolean(preview)}
      width={680}
      placement="right"
      closeOnEsc
      maskClosable
      onCancel={onClose}
      bodyStyle={{ padding: "16px 20px 28px", overflow: "auto" }}
    >
      {preview && (
        <div className="gy-finding-drawer">
          <div className="gy-finding-meta-card">
            {cred && (
              <>
                <div className="gy-finding-meta-item">
                  <span className="gy-finding-meta-label">凭据类型</span>
                  <Tag color={CREDENTIAL_KIND_COLOR[cred.kind] ?? "grey"} size="small">
                    {CREDENTIAL_KIND_LABEL[cred.kind] ?? cred.kind}
                  </Tag>
                </div>
                <div className="gy-finding-meta-item">
                  <span className="gy-finding-meta-label">用户名</span>
                  <span className="gy-finding-meta-value">{cred.username || "—"}</span>
                </div>
                <div className="gy-finding-meta-item">
                  <span className="gy-finding-meta-label">目标资产</span>
                  <Typography.Text code size="small" className="gy-finding-meta-value">
                    {cred.asset}
                  </Typography.Text>
                </div>
                <div className="gy-finding-meta-item">
                  <span className="gy-finding-meta-label">验证 / 复用</span>
                  <span className="gy-finding-meta-value">
                    {cred.verifiedAt ? "已验证" : "已登记"} · 复用 {cred.reuseCount} 次
                  </span>
                </div>
              </>
            )}
            <div className="gy-finding-meta-item gy-finding-meta-item-wide">
              <span className="gy-finding-meta-label">引用指针</span>
              <Space spacing={6} wrap>
                <Typography.Text code size="small" className="gy-finding-meta-value">
                  {secretRef}
                </Typography.Text>
                <Button
                  size="small"
                  theme="borderless"
                  icon={<IconCopy />}
                  onClick={() => void copyText(secretRef, "已复制引用路径")}
                >
                  复制路径
                </Button>
              </Space>
            </div>
          </div>

          {loading && (
            <div style={{ padding: "48px 0", textAlign: "center" }}>
              <Spin size="large" tip="正在读取对应证据文件…" />
            </div>
          )}

          {!loading && error && (
            <Card
              title="证据读取失败"
              style={{ borderColor: "var(--semi-color-danger)" }}
              headerExtraContent={
                <Button size="small" onClick={() => setReloadNonce((n) => n + 1)}>
                  重试
                </Button>
              }
            >
              <Typography.Paragraph type="danger" style={{ margin: 0, wordBreak: "break-all" }}>
                {error}
              </Typography.Paragraph>
            </Card>
          )}

          {!loading && loaded && (
            <>
              <div className="gy-finding-view-tabs">
                <Space spacing={8} wrap>
                  <Tag color="blue" size="small">
                    {loaded.kind === "traffic" ? "HTTP 事务载荷" : `实际路径：${loaded.path}`}
                  </Tag>
                  <Typography.Text type="tertiary" size="small">
                    {loaded.body.length} 字符
                  </Typography.Text>
                  {markdownCapable && (
                    <Space spacing={4}>
                      <Button
                        size="small"
                        theme={viewMode === "raw" ? "solid" : "light"}
                        type={viewMode === "raw" ? "primary" : "tertiary"}
                        onClick={() => setViewMode("raw")}
                      >
                        原始文本
                      </Button>
                      <Button
                        size="small"
                        theme={viewMode === "markdown" ? "solid" : "light"}
                        type={viewMode === "markdown" ? "primary" : "tertiary"}
                        onClick={() => setViewMode("markdown")}
                      >
                        Markdown 渲染
                      </Button>
                    </Space>
                  )}
                </Space>
                <Button
                  size="small"
                  theme="solid"
                  type="primary"
                  icon={<IconCopy />}
                  onClick={() => void copyText(loaded.body, "已复制凭据证据内容")}
                >
                  复制全文
                </Button>
              </div>

              {viewMode === "markdown" && markdownCapable ? (
                <div className="gy-finding-prose-box">
                  <ChatMarkdown text={loaded.body} />
                </div>
              ) : (
                <pre
                  className="gy-sheet-raw"
                  style={{ maxHeight: "calc(100vh - 280px)", overflow: "auto" }}
                >
                  {loaded.body || "（文件内容为空）"}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </SideSheet>
  );
}

function CredentialsSection({
  taskId,
  rows,
  activeCredentialId,
  onOpenPreview,
}: {
  taskId: string;
  rows: Credential[];
  activeCredentialId?: string;
  onOpenPreview: (cred: Credential) => void;
}) {
  const pager = useClientPagination(rows, 20, taskId);
  return (
    <>
      <Typography.Paragraph type="tertiary" size="small" style={{ margin: "0 0 8px" }}>
        展示完整凭据引用（secretRef），可点击“查看”在右侧抽屉直接预览对应证据文件以复现。
      </Typography.Paragraph>
      {rows.length ? (
        <Table
          size="small"
          rowKey="id"
          dataSource={pager.dataSource}
          pagination={pager.pagination}
          rowClassName={(record?: Credential) => record?.id === activeCredentialId ? "gy-list-active" : ""}
          columns={[
            { title: "类型", dataIndex: "kind", width: 120, render: (k: string) => <Tag color={CREDENTIAL_KIND_COLOR[k] ?? "grey"} size="small">{CREDENTIAL_KIND_LABEL[k] ?? k}</Tag> },
            { title: "资产", dataIndex: "asset", render: (v: string) => <Typography.Text style={{ wordBreak: "break-all" }}>{v}</Typography.Text> },
            { title: "用户名", dataIndex: "username", width: 140, render: (v: string | null) => v || "—" },
            {
              title: "secretRef",
              dataIndex: "secretRef",
              render: (v: string, record: Credential) => (
                <SecretRefCell
                  secretRef={v}
                  active={record.id === activeCredentialId}
                  onOpen={() => onOpenPreview(record)}
                />
              ),
            },
            { title: "复用次数", dataIndex: "reuseCount", width: 100 },
          ]}
        />
      ) : <Empty description="暂无凭据记录" style={{ padding: "24px 0" }} />}
    </>
  );
}

function SessionsSection({
  taskId,
  rows,
  activeCredentialId,
  onOpenPreview,
}: {
  taskId: string;
  rows: Credential[];
  activeCredentialId?: string;
  onOpenPreview: (cred: Credential) => void;
}) {
  const pager = useClientPagination(rows, 20, taskId);
  if (!rows.length) return <Empty description="暂无驻留会话；获取会话或立足点 Shell 后记录在这里。" style={{ padding: "24px 0" }} />;
  return (
    <Table
      size="small"
      rowKey="id"
      dataSource={pager.dataSource}
      pagination={pager.pagination}
      rowClassName={(record?: Credential) => record?.id === activeCredentialId ? "gy-list-active" : ""}
      columns={[
        { title: "类型", dataIndex: "kind", width: 130, render: (k: string) => <Tag color={CREDENTIAL_KIND_COLOR[k] ?? "grey"} size="small">{CREDENTIAL_KIND_LABEL[k] ?? k}</Tag> },
        { title: "资产", dataIndex: "asset", render: (v: string) => <Typography.Text style={{ wordBreak: "break-all" }}>{v}</Typography.Text> },
        { title: "用户名", dataIndex: "username", width: 140, render: (v: string | null) => v || "—" },
        {
          title: "会话指针",
          dataIndex: "secretRef",
          render: (v: string, record: Credential) => (
            <SecretRefCell
              secretRef={v}
              active={record.id === activeCredentialId}
              onOpen={() => onOpenPreview(record)}
            />
          ),
        },
        { title: "最近使用", dataIndex: "lastUsedAt", width: 170, render: (t: string | null) => t ? formatDateTime(t, true) : "—" },
        { title: "复用", dataIndex: "reuseCount", width: 70 },
      ]}
    />
  );
}

function TunnelsSection({ rows }: { rows: TunnelMeta[] }) {
  if (!rows.length) return <Empty description="暂无本地隧道" style={{ padding: "24px 0" }} />;
  return (
    <Table
      pagination={false} size="small" rowKey="id" dataSource={rows}
      columns={[
        { title: "类型", dataIndex: "kind", width: 110 },
        { title: "本地", width: 150, render: (_: unknown, r: TunnelMeta) => `127.0.0.1:${r.localPort}` },
        { title: "目标", render: (_: unknown, r: TunnelMeta) => r.targetHost ? `${r.targetHost}:${r.targetPort ?? "-"}` : r.via ?? "-" },
        { title: "状态", width: 100, render: (_: unknown, r: TunnelMeta) => <Tag color={r.status === "running" ? "green" : r.status === "error" ? "red" : "grey"}>{r.status}</Tag> },
        { title: "PID", dataIndex: "pid", width: 90 },
        { title: "命令", render: (_: unknown, r: TunnelMeta) => <Typography.Text type="tertiary" size="small" ellipsis={{ showTooltip: true }} style={{ maxWidth: 360 }}>{r.command}</Typography.Text> },
        { title: "错误", render: (_: unknown, r: TunnelMeta) => r.error ? <Typography.Text type="danger">{r.error}</Typography.Text> : "—" },
      ]}
    />
  );
}

function OastSection({ taskId, tokens, hits }: { taskId: string; tokens: OastToken[]; hits: OastHit[] }) {
  const tokenPager = useClientPagination(tokens, 20, taskId);
  const hitPager = useClientPagination(hits, 20, taskId);
  return (
    <>
      <Typography.Title heading={6} style={{ margin: "0 0 8px" }}>令牌</Typography.Title>
      {tokens.length ? (
        <Table
          size="small" rowKey="token" dataSource={tokenPager.dataSource}
          pagination={tokenPager.pagination}
          columns={[
            { title: "令牌", dataIndex: "token", width: 180, render: (t: string) => <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{t}</Typography.Text> },
            { title: "类型", dataIndex: "kind", width: 80, render: (k: string) => <Tag color={k === "dns" ? "blue" : "green"} size="small">{k.toUpperCase()}</Tag> },
            { title: "回调地址", dataIndex: "callback", render: (c: string) => <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{c}</Typography.Text> },
            { title: "签发", dataIndex: "issuedAt", width: 160, render: (at: string) => formatDateTime(at, true) },
            { title: "到期", dataIndex: "expiresAt", width: 160, render: (at: string) => formatDateTime(at, true) },
            { title: "命中", dataIndex: "hits", width: 70 },
          ]}
        />
      ) : <Empty description="暂无带外令牌" style={{ padding: "24px 0" }} />}
      <Typography.Title heading={6} style={{ margin: "20px 0 8px" }}>命中</Typography.Title>
      {hits.length ? (
        <Table
          size="small" rowKey={(r?: OastHit) => `${r?.token ?? ""}:${r?.at ?? ""}:${r?.sourceIp ?? ""}`}
          dataSource={hitPager.dataSource} pagination={hitPager.pagination}
          columns={[
            { title: "令牌", dataIndex: "token", width: 160, render: (t: string) => <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{t}</Typography.Text> },
            { title: "时间", dataIndex: "at", width: 160, render: (at: string) => formatDateTime(at, true) },
            { title: "来源 IP", dataIndex: "sourceIp", width: 140 },
            { title: "协议", dataIndex: "protocol", width: 80, render: (p: string) => <Tag color={p === "dns" ? "blue" : "green"} size="small">{p.toUpperCase()}</Tag> },
            { title: "请求", dataIndex: "path", render: (_: string, r: OastHit) => <Typography.Text style={{ wordBreak: "break-all" }}>{r.method ? `${r.method} ` : ""}{r.path || "—"}</Typography.Text> },
            { title: "User-Agent", dataIndex: "userAgent", render: (ua: string) => <Typography.Text type="tertiary" size="small" style={{ wordBreak: "break-all" }}>{ua || "—"}</Typography.Text> },
          ]}
        />
      ) : <Empty description="暂无带外回调命中" style={{ padding: "24px 0" }} />}
    </>
  );
}

function HistoryContact({ taskId }: { taskId: string }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssetHistoryPayload | null>(null);
  const hitsPager = useClientPagination(result?.hits ?? [], 10, `${taskId}:${result?.host ?? ""}`);

  async function query() {
    const value = address.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    try { const { json } = await api.getAssetHistory(taskId, value); setResult(json); }
    catch (err) { setResult(null); setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <Card
      title="历史接触"
      style={{ background: "var(--semi-color-bg-1)" }}
      headerExtraContent={<Typography.Text type="tertiary" size="small">只读线索 · 不自动查询 · 不等于本次授权</Typography.Text>}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Input value={address} onChange={setAddress} onEnterPress={() => void query()} placeholder="host 或 URL，例如 target.example.com" aria-label="历史接触地址" style={{ width: 360, maxWidth: "100%" }} />
        <Button theme="solid" type="primary" loading={busy} disabled={!address.trim()} onClick={() => void query()}>查询</Button>
      </div>
      {error && <Typography.Paragraph type="danger" style={{ margin: "12px 0 0" }}>历史接触读取失败：{error}</Typography.Paragraph>}
      {result && (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph style={{ margin: "0 0 8px" }}>历史接触 · {result.host || "—"} · {result.hits.length} 条</Typography.Paragraph>
          <Table
            size="small" rowKey="taskId" dataSource={hitsPager.dataSource}
            pagination={hitsPager.pagination} empty="暂无历史接触"
            columns={[
              { title: "任务名", dataIndex: "name", render: (name: string, record: AssetHistoryPayload["hits"][number]) => (
                <div style={{ wordBreak: "break-all" }}>
                  <Typography.Text strong>{name}</Typography.Text>
                  <Typography.Text type="tertiary" size="small"> {shortId(record.taskId)}</Typography.Text>
                </div>
              ) },
              { title: "状态", dataIndex: "status", width: 130, render: (s: string) => <StatusTag status={s} /> },
              { title: "已复现漏洞", dataIndex: "findings", width: 140, render: (_: unknown, record: AssetHistoryPayload["hits"][number]) => record.findings.filter((f) => f.status === "verified").length },
            ]}
          />
          <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0 0" }}>{result.note}</Typography.Paragraph>
        </div>
      )}
    </Card>
  );
}
