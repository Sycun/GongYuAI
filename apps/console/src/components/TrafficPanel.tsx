import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Input, Select, Space, Spin, Tag, Toast, Typography } from "@douyinfe/semi-ui";
import { IconCopy, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import type { TrafficRecord } from "@gongyuai/contracts";
import { api } from "../api";
import { shortId } from "../labels";
import { formatDateTime } from "../time";
import {
  buildCurl, buildRawRequest, buildRawResponse, formatBytes, formatDuration,
  httpStatusColor, matchKeyword, HTTP_METHODS, STATUS_CLASSES,
} from "./trafficFormat";

const PAGE_SIZE = 50;
const CHUNK_BYTES = 8192;

type BodyChunk = {
  text: string;
  nextOffset: number | null;
  size: number;
  loading: boolean;
  error: string | null;
};

const emptyChunk = (size: number): BodyChunk => ({ text: "", nextOffset: 0, size, loading: false, error: null });

type Props = {
  taskId: string;
  intents?: Array<{ id: string; title: string }>;
};

export function TrafficPanel({ taskId, intents = [] }: Props) {
  const [rows, setRows] = useState<TrafficRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hostDraft, setHostDraft] = useState("");
  const [method, setMethod] = useState<string>("");
  const [intentId, setIntentId] = useState<string>("");
  const [applied, setApplied] = useState({ host: "", method: "", intentId: "" });
  const [keyword, setKeyword] = useState("");
  const [statusClass, setStatusClass] = useState<string>("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, { req: BodyChunk; res: BodyChunk }>>({});
  const offsetRef = useRef(0);
  const reqSeq = useRef(0);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const seq = ++reqSeq.current;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const { json } = await api.traffic(taskId, {
        host: applied.host || undefined,
        method: applied.method || undefined,
        intentId: applied.intentId || undefined,
        offset,
        limit: PAGE_SIZE,
      });
      if (seq !== reqSeq.current) return;
      const page = json.traffic ?? [];
      offsetRef.current = json.nextOffset ?? offset + page.length;
      setHasMore(json.nextOffset != null || page.length >= PAGE_SIZE);
      setRows((prev) => {
        const next = append ? [...prev, ...page] : page;
        if (!append) setSelectedId((current) => (current && next.some((r) => r.id === current) ? current : next[0]?.id ?? null));
        return next;
      });
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      if (!append) setRows([]);
    } finally {
      if (seq === reqSeq.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [taskId, applied]);

  useEffect(() => {
    offsetRef.current = 0;
    setRows([]);
    setBodies({});
    void loadPage(0, false);
  }, [loadPage]);

  const visible = useMemo(() => rows.filter((row) => {
    if (statusClass && Math.floor(row.status / 100) !== Number(statusClass)) return false;
    return matchKeyword(row, keyword);
  }), [rows, keyword, statusClass]);

  const selected = useMemo(() => visible.find((r) => r.id === selectedId) ?? null, [visible, selectedId]);

  const loadChunk = useCallback(async (tid: string, side: "req" | "res", offset: number) => {
    setBodies((prev) => {
      const entry = prev[tid] ?? { req: emptyChunk(0), res: emptyChunk(0) };
      return { ...prev, [tid]: { ...entry, [side]: { ...entry[side], loading: true, error: null } } };
    });
    try {
      const { json } = await api.trafficBlob(taskId, tid, side, offset, CHUNK_BYTES);
      setBodies((prev) => {
        const entry = prev[tid] ?? { req: emptyChunk(0), res: emptyChunk(0) };
        const old = entry[side];
        return {
          ...prev,
          [tid]: {
            ...entry,
            [side]: {
              text: offset === 0 ? json.body : old.text + json.body,
              nextOffset: json.nextOffset,
              size: json.size,
              loading: false,
              error: null,
            },
          },
        };
      });
    } catch (e) {
      setBodies((prev) => {
        const entry = prev[tid] ?? { req: emptyChunk(0), res: emptyChunk(0) };
        return { ...prev, [tid]: { ...entry, [side]: { ...entry[side], loading: false, error: e instanceof Error ? e.message : String(e) } } };
      });
    }
  }, [taskId]);

  // 选中一条流量时按需拉取请求/响应体首段。
  useEffect(() => {
    if (!selected) return;
    const tid = selected.id;
    setBodies((prev) => {
      if (prev[tid]) return prev;
      return {
        ...prev,
        [tid]: {
          req: emptyChunk(selected.reqBodyBlob?.size ?? 0),
          res: emptyChunk(selected.resBodyBlob?.size ?? 0),
        },
      };
    });
    if (selected.reqBodyBlob) void loadChunk(tid, "req", 0);
    if (selected.resBodyBlob) void loadChunk(tid, "res", 0);
  }, [selected?.id]);

  const applyFilters = () => {
    setApplied({ host: hostDraft.trim(), method, intentId });
  };

  const copyCurl = async () => {
    if (!selected) return;
    try {
      let body = bodies[selected.id]?.req.text ?? "";
      if (selected.reqBodyBlob) {
        const { json } = await api.trafficBlob(taskId, selected.id, "req", 0, 1024 * 1024);
        body = json.body;
      }
      const curl = buildCurl(selected, body);
      await navigator.clipboard.writeText(curl);
      Toast.success("已复制 cURL");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "复制失败");
    }
  };

  const openFinding = (findingId: string) => {
    window.location.hash = `#/findings/${encodeURIComponent(taskId)}?finding=${encodeURIComponent(findingId)}`;
  };

  const body = selected ? bodies[selected.id] : undefined;

  return (
    <div className="gy-traffic">
      <div className="gy-traffic-filters">
        <Input
          prefix={<IconSearch />} aria-label="按 Host 筛选" placeholder="Host，例如 app.example.com"
          value={hostDraft} onChange={setHostDraft} onEnterPress={applyFilters} style={{ width: 240 }} showClear
        />
        <Select
          aria-label="按方法筛选" placeholder="方法" value={method || undefined} onChange={(v) => setMethod(String(v ?? ""))}
          optionList={HTTP_METHODS.map((m) => ({ value: m, label: m }))} style={{ width: 120 }} showClear
        />
        <Select
          aria-label="按状态筛选" placeholder="状态" value={statusClass || undefined} onChange={(v) => setStatusClass(String(v ?? ""))}
          optionList={STATUS_CLASSES} style={{ width: 160 }} showClear
        />
        <Select
          aria-label="按意图筛选" placeholder="所属 Intent" value={intentId || undefined} onChange={(v) => setIntentId(String(v ?? ""))}
          optionList={intents.map((i) => ({ value: i.id, label: `${shortId(i.id)} · ${i.title}` }))}
          style={{ width: 240 }} showClear filter
        />
        <Input
          aria-label="关键字" placeholder="关键字（本地匹配已加载记录）" value={keyword} onChange={setKeyword}
          style={{ width: 240 }} showClear
        />
        <Button theme="solid" icon={<IconRefresh />} onClick={applyFilters} loading={loading}>查询</Button>
        <Typography.Text type="tertiary" size="small">
          {visible.length} / {rows.length} 条
        </Typography.Text>
      </div>

      {error && (
        <Typography.Paragraph type="danger" style={{ margin: "8px 0" }}>
          流量读取失败：{error}（若控制面尚未接入流量记录，请稍后重试）
        </Typography.Paragraph>
      )}

      <div className="gy-traffic-body">
        <div className="gy-traffic-list" role="listbox" aria-label="请求列表">
          {loading && rows.length === 0 ? (
            <div className="gy-traffic-empty"><Spin /> 正在读取流量…</div>
          ) : visible.length === 0 ? (
            <Empty title="暂无流量" description="任务发起 HTTP/HTTPS 请求后会记录在这里。" style={{ padding: 24 }} />
          ) : (
            <>
              {visible.map((row) => (
                <button
                  type="button" key={row.id} role="option" aria-selected={row.id === selectedId}
                  className={`gy-traffic-row${row.id === selectedId ? " gy-traffic-row-active" : ""}`}
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className="gy-traffic-row-top">
                    <Tag size="small" color="blue">{row.method}</Tag>
                    <Tag size="small" color={httpStatusColor(row.status)}>{row.status || "—"}</Tag>
                    <span className="gy-traffic-row-time">{formatDateTime(row.startedAt, true)}</span>
                  </span>
                  <span className="gy-traffic-row-path" title={row.path}>{row.host}{row.path}</span>
                  <span className="gy-traffic-row-meta">
                    {formatDuration(row.durationMs)}
                    {row.resBodyBlob ? ` · ${formatBytes(row.resBodyBlob.size)}` : ""}
                    {row.findingIds?.length ? ` · 关联漏洞 ${row.findingIds.length}` : ""}
                  </span>
                </button>
              ))}
              {hasMore && (
                <Button block loading={loadingMore} onClick={() => void loadPage(offsetRef.current, true)} style={{ marginTop: 8 }}>
                  加载更多
                </Button>
              )}
            </>
          )}
        </div>

        <div className="gy-traffic-detail">
          {!selected ? (
            <Empty title="选择一条请求" description="左侧选择后查看完整 Raw 报文。" style={{ padding: 48 }} />
          ) : (
            <>
              <div className="gy-traffic-detail-head">
                <Space wrap spacing={8}>
                  <Tag color="blue">{selected.method}</Tag>
                  <Tag color={httpStatusColor(selected.status)}>{selected.status || "—"}</Tag>
                  <Typography.Text strong style={{ wordBreak: "break-all" }}>{selected.url}</Typography.Text>
                </Space>
                <Space spacing={8}>
                  {selected.findingIds?.map((fid) => (
                    <Button key={fid} size="small" theme="borderless" onClick={() => openFinding(fid)}>
                      漏洞 {shortId(fid)}
                    </Button>
                  ))}
                  <Button size="small" icon={<IconCopy />} onClick={() => void copyCurl()}>复制 cURL</Button>
                </Space>
                <Typography.Text type="tertiary" size="small" style={{ display: "block", marginTop: 4 }}>
                  {formatDateTime(selected.startedAt, true)} · {formatDuration(selected.durationMs)}
                  {selected.intentId ? ` · Intent ${shortId(selected.intentId)}` : ""}
                  {selected.workerId ? ` · ${selected.workerId}` : ""}
                </Typography.Text>
              </div>
              <div className="gy-traffic-raw">
                <RawPane
                  title="Raw Request" side="req" record={selected}
                  chunk={body?.req} hasBlob={Boolean(selected.reqBodyBlob)}
                  onLoadMore={(offset) => void loadChunk(selected.id, "req", offset)}
                  build={(text) => buildRawRequest(selected, text)}
                />
                <RawPane
                  title="Raw Response" side="res" record={selected}
                  chunk={body?.res} hasBlob={Boolean(selected.resBodyBlob)}
                  onLoadMore={(offset) => void loadChunk(selected.id, "res", offset)}
                  build={(text) => buildRawResponse(selected, text)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RawPane({ title, chunk, hasBlob, onLoadMore, build }: {
  title: string;
  side: "req" | "res";
  record: TrafficRecord;
  chunk?: BodyChunk;
  hasBlob: boolean;
  onLoadMore: (offset: number) => void;
  build: (text: string) => string;
}) {
  const text = chunk ? build(chunk.text) : build("");
  const loadedBytes = chunk ? new Blob([chunk.text]).size : 0;
  return (
    <div className="gy-traffic-raw-pane">
      <div className="gy-traffic-raw-head">
        <Typography.Text strong size="small">{title}</Typography.Text>
        {hasBlob && chunk && (
          <Typography.Text type="tertiary" size="small">
            {formatBytes(loadedBytes)} / {formatBytes(chunk.size)}
          </Typography.Text>
        )}
      </div>
      <pre className="gy-mono gy-traffic-raw-pre">{text || "（空）"}</pre>
      {chunk?.error && <Typography.Text type="danger" size="small">{chunk.error}</Typography.Text>}
      {hasBlob && chunk && chunk.nextOffset != null && (
        <Button size="small" block loading={chunk.loading} onClick={() => onLoadMore(chunk.nextOffset!)} style={{ marginTop: 6 }}>
          加载更多（{formatBytes(chunk.size - loadedBytes)} 剩余）
        </Button>
      )}
      {hasBlob && chunk && chunk.nextOffset == null && chunk.size > 0 && (
        <Typography.Text type="tertiary" size="small" style={{ display: "block", marginTop: 6 }}>已加载完整报文</Typography.Text>
      )}
    </div>
  );
}