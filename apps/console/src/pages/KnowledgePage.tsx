import { useCallback, useEffect, useRef, useState } from "react";
import {
  AutoComplete, Banner, Button, Card, Descriptions, Input, Popconfirm, Progress,
  Select, SideSheet, Space, Tag, Toast, Typography,
} from "@douyinfe/semi-ui";
import { IconRefresh, IconSearch, IconSetting } from "@douyinfe/semi-icons";
import type {
  KnowledgeEmbeddingState, KnowledgeIndexStatus, KnowledgeMaterial, KnowledgeReaderScope,
  KnowledgeSearchMode, KnowledgeSearchResult, KnowledgeSummary,
} from "@gongyuai/contracts";
import { api, type KnowledgeScopeParam, type TaskRecord } from "../api";
import { KnowledgeEmbeddingSettings } from "../components/KnowledgeEmbeddingSettings";

type Scope =
  | { kind: "shared" }
  | { kind: "engagement"; engagementId: string }
  | { kind: "task"; taskId: string };

function keyOf(scope: Scope): string {
  return scope.kind === "shared" ? "shared"
    : scope.kind === "engagement" ? `eng:${scope.engagementId}`
    : `task:${scope.taskId}`;
}
function paramOf(key: string): KnowledgeScopeParam {
  if (key.startsWith("eng:")) return { engagementId: key.slice(4) };
  if (key.startsWith("task:")) return { taskId: key.slice(5) };
  return {};
}
function initialScope(query: Record<string, string>): Scope {
  if (query.taskId) return { kind: "task", taskId: query.taskId };
  if (query.engagementId) return { kind: "engagement", engagementId: query.engagementId };
  return { kind: "shared" };
}
const transient = (state: KnowledgeEmbeddingState) => state === "indexing" || state === "pending";

const STATE_META: Record<KnowledgeEmbeddingState, { label: string; color: "green" | "blue" | "orange" | "grey" | "red"; banner: "success" | "info" | "warning" | "danger" }> = {
  ready: { label: "索引就绪", color: "green", banner: "success" },
  indexing: { label: "正在索引", color: "blue", banner: "info" },
  pending: { label: "等待索引", color: "orange", banner: "info" },
  disabled: { label: "向量化已停用", color: "grey", banner: "warning" },
  unconfigured: { label: "模型未配置", color: "orange", banner: "warning" },
  unavailable: { label: "服务不可用", color: "red", banner: "danger" },
  error: { label: "索引出错", color: "red", banner: "danger" },
};
const SOURCE_KIND: Record<string, string> = { original: "原文", excerpt: "摘录", editorial: "编辑导读" };
const MATCH_FIELD: Record<string, string> = { body: "正文命中", locator: "章节定位", semantic: "语义相近", title: "标题命中", tags: "标签命中" };
const RESOLVED_FROM: Record<string, string> = { task: "按任务归属", declared: "按声明委托", "shared-only": "仅共享" };

export function KnowledgePage({ query, tasks }: { query: Record<string, string>; tasks: TaskRecord[] }) {
  const [scope, setScope] = useState<Scope>(() => initialScope(query));
  const scopeKey = keyOf(scope);
  const [readerScope, setReaderScope] = useState<KnowledgeReaderScope | null>(null);
  const [index, setIndex] = useState<KnowledgeIndexStatus | null>(null);
  const [materials, setMaterials] = useState<KnowledgeMaterial[] | null>(null);
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null);
  const [indexError, setIndexError] = useState("");
  const [actionBusy, setActionBusy] = useState<"rebuild" | "retry" | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [queued, setQueued] = useState(false);
  const [polling, setPolling] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>("hybrid");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const knownEngagements = [...new Set(tasks.map(t => t.engagementId ?? t.id))];
  const scopeLabel = scope.kind === "shared" ? "共享资料"
    : scope.kind === "engagement" ? `委托 ${scope.engagementId || "（未填）"}`
    : `任务 ${tasks.find(t => t.id === scope.taskId)?.name ?? scope.taskId}`;

  // 深链切换（#/knowledge?engagementId=… 或 ?taskId=…）时按当前查询重新锚定范围。
  useEffect(() => { setScope(initialScope(query)); }, [query.taskId, query.engagementId]);

  // 切换委托/任务：作废旧请求与轮询，清空旧范围结果，避免把上一委托的进度显示到当前页面。
  useEffect(() => {
    const gen = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const param = paramOf(scopeKey);
    setIndex(null); setMaterials(null); setSummary(null); setSearchResult(null);
    setReaderScope(null); setIndexError(""); setActionError(""); setActionNotice(""); setQueued(false); setPolling(false);
    void (async () => {
      const [idx, mats, sum] = await Promise.all([
        api.knowledgeIndex(param, signal),
        api.knowledgeMaterials(param, signal),
        api.knowledgeSummary(param, signal),
      ]);
      if (gen !== generation.current) return;
      if (idx.ok) {
        setIndex(idx.json.index); setReaderScope(idx.json.scope);
        if (transient(idx.json.index.state)) setPolling(true);
      } else if (idx.kind !== "aborted") setIndexError(idx.error);
      if (mats.ok) setMaterials(mats.json.materials);
      if (sum.ok) setSummary(sum.json);
    })();
    return () => { controller.abort(); };
  }, [scopeKey, reloadNonce]);

  // 202 已排队后轮询索引状态，直到就绪/失败/停用等终态。
  useEffect(() => {
    if (!polling) return;
    const gen = generation.current;
    let active = true; let timer = 0; let ticks = 0;
    const tick = async () => {
      const r = await api.knowledgeIndex(paramOf(scopeKey), abortRef.current?.signal);
      if (!active || gen !== generation.current) return;
      if (r.ok) {
        setIndex(r.json.index); setReaderScope(r.json.scope); setIndexError("");
        if (transient(r.json.index.state) && ticks < 150) { ticks++; timer = window.setTimeout(tick, 1500); }
        else { setPolling(false); setQueued(false); }
      } else if (r.kind !== "aborted") { setIndexError(r.error); setPolling(false); setQueued(false); }
    };
    timer = window.setTimeout(tick, 1200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [polling, scopeKey]);

  const refreshIndex = useCallback(async () => {
    const gen = generation.current;
    const r = await api.knowledgeIndex(paramOf(scopeKey), abortRef.current?.signal);
    if (gen !== generation.current) return;
    if (r.ok) {
      setIndex(r.json.index); setReaderScope(r.json.scope); setIndexError("");
      if (transient(r.json.index.state)) setPolling(true);
    } else if (r.kind !== "aborted") setIndexError(r.error);
  }, [scopeKey]);

  async function rebuild() {
    if (actionBusy) return;
    const gen = generation.current;
    setActionBusy("rebuild"); setActionError(""); setActionNotice("");
    const r = await api.knowledgeRebuild(paramOf(scopeKey));
    if (gen !== generation.current) return;
    setActionBusy(null);
    if (r.ok) {
      setIndex(r.json.status); setReaderScope(r.json.scope);
      if (!r.json.versions.length) { setActionNotice("没有需要重建的资料。"); Toast.info("没有需要重建的资料"); return; }
      setQueued(true); setPolling(true);
      Toast.success(`已排队：重建${scopeLabel}索引（${r.json.versions.length} 个版本）`);
    } else { setActionError(r.error); Toast.error(r.error); }
  }
  async function retry() {
    if (actionBusy) return;
    const gen = generation.current;
    setActionBusy("retry"); setActionError(""); setActionNotice("");
    const r = await api.knowledgeRetry(paramOf(scopeKey));
    if (gen !== generation.current) return;
    setActionBusy(null);
    if (r.ok) {
      setIndex(r.json.status); setReaderScope(r.json.scope);
      // 后端确实无事可做时不能报「已排队」，否则页面停在假进度上。
      if (!r.json.queued.length) {
        setQueued(false); setPolling(false);
        setActionNotice("没有需要重试的资料。");
        Toast.info("没有需要重试的资料");
        return;
      }
      setQueued(true); setPolling(true);
      Toast.success(`已排队：重试${scopeLabel}失败/未就绪片段（${r.json.queued.length} 个版本）`);
    } else { setActionError(r.error); Toast.error(r.error); }
  }
  async function runSearch() {
    const gen = generation.current;
    setSearchBusy(true); setSearchError("");
    const r = await api.knowledgeSearch(paramOf(scopeKey), searchQuery, searchMode, abortRef.current?.signal);
    if (gen !== generation.current) return;
    setSearchBusy(false);
    if (r.ok) { setSearchResult(r.json); setIndex(r.json.index); setReaderScope(r.json.scope); }
    else if (r.kind !== "aborted") setSearchError(r.error);
  }

  function changeMode(kind: string) {
    if (kind === "engagement") setScope({ kind: "engagement", engagementId: knownEngagements[0] ?? "" });
    else if (kind === "task") setScope({ kind: "task", taskId: tasks[0]?.id ?? "" });
    else setScope({ kind: "shared" });
  }

  const meta = index ? STATE_META[index.state] : null;
  const pct = index && index.totalChunks > 0 ? Math.round((index.indexedChunks / index.totalChunks) * 100) : 0;
  const emptyLibrary = index ? index.totalChunks === 0 : false;
  const pendingWork = index ? index.pendingChunks + index.failedChunks : 0;

  return <div className="gy-knowledge">
    <div className="gy-knowledge-toolbar">
      <Space className="gy-knowledge-scope" wrap>
        <Select aria-label="资料范围" value={scope.kind} style={{ width: 132 }} onChange={v => changeMode(String(v ?? "shared"))} optionList={[
          { value: "shared", label: "共享资料" },
          { value: "engagement", label: "指定委托" },
          { value: "task", label: "按任务" },
        ]} />
        {scope.kind === "engagement" && <AutoComplete aria-label="委托 ID" style={{ width: 240 }}
          value={scope.engagementId} data={knownEngagements} placeholder="输入或选择委托 ID"
          onChange={v => setScope({ kind: "engagement", engagementId: String(v) })} />}
        {scope.kind === "task" && <Select aria-label="任务" style={{ width: 280 }} filter value={scope.taskId}
          placeholder="选择任务（按服务端归属定委托）"
          optionList={tasks.map(t => ({ value: t.id, label: `${t.name}（${t.engagementId ?? t.id}）` }))}
          onChange={v => setScope({ kind: "task", taskId: String(v) })} />}
        {readerScope && <Tag color="blue" size="small">
          {RESOLVED_FROM[readerScope.resolvedFrom]} · {readerScope.engagementId ?? "无委托"}
        </Tag>}
      </Space>
      <Button icon={<IconSetting />} theme="light" onClick={() => setSettingsOpen(true)}>向量化设置</Button>
    </div>

    {readerScope && <Typography.Text type="tertiary" size="small" className="gy-knowledge-scope-note">
      单操作者环境 · 声明上下文非已认证身份 · 用户级权限未验证（userLevelPermissionVerified=false）
    </Typography.Text>}

    <Card className="gy-knowledge-index" title={<Space><IconSetting aria-hidden="true" />向量索引状态</Space>}
      headerExtraContent={<Button size="small" icon={<IconRefresh />} theme="borderless"
        onClick={() => setReloadNonce(n => n + 1)}>刷新</Button>}>
      {indexError && <Banner type="danger" closeIcon={null} description={indexError} />}
      {!index && !indexError && <span role="status">正在读取索引状态…</span>}
      {index && meta && <>
        <Space wrap className="gy-knowledge-index-head">
          <Tag color={meta.color} size="large">{meta.label}</Tag>
          {queued && <Tag color="blue" size="small">已排队</Tag>}
          {index.degraded && <Tag color="orange" size="small">关键词降级</Tag>}
          <Typography.Text type="tertiary" size="small">范围：{scopeLabel}</Typography.Text>
        </Space>
        {emptyLibrary ? <Banner type="info" closeIcon={null} description="暂无待索引资料" /> : <>
          <Progress percent={pct} stroke={index.state === "ready" ? "var(--semi-color-success)" : "var(--semi-color-primary)"}
            aria-label="索引进度" style={{ margin: "10px 0" }} />
          <Descriptions align="left" size="small" data={[
            { key: "当前模型", value: index.model ?? "未配置" },
            { key: "服务", value: `${index.providerKind === "cloud" ? "云端服务" : index.providerKind === "local" ? "本地服务" : "—"} ${index.provider ?? ""}` },
            { key: "维度 / 切分", value: `${index.modelDim ?? "—"} / c${index.chunkerVersion}` },
            { key: "索引指纹", value: index.indexKey ?? "—" },
            { key: "已索引 / 总片段", value: `${index.indexedChunks} / ${index.totalChunks}` },
            { key: "待索引 / 失败", value: `${index.pendingChunks} / ${index.failedChunks}` },
          ]} />
          {index.services.length > 1 && <Descriptions align="left" size="small" className="gy-knowledge-services"
            data={index.services.map(s => ({
              key: s.provider === "cloud" ? "云端服务" : "本地服务",
              value: `${s.model || "未配置"} · ${s.modelDim ?? "—"} 维 · ${s.indexedChunks}/${s.totalChunks} 片段 · ${STATE_META[s.state].label}${s.allowed ? "" : " · 本范围未授权"}`,
            }))} />}
        </>}
        {index.blockedChunks > 0 && <Banner type="warning" closeIcon={null}
          description={`本范围有 ${index.blockedChunks} 个已索引片段属于未获授权的向量化服务，不参与语义召回，也不会把查询文本发给该服务。如需语义召回，请在向量化设置里明确允许本委托使用云端，或把该服务切回本地。`} />}
        {index.degraded && index.degradedReason && <Banner type="warning" closeIcon={null}
          description={`本次只用关键词：${index.degradedReason}`} />}
        {index.lastError && <Banner type="danger" closeIcon={null} description={`最近错误：${index.lastError}`} />}
        {actionError && <Banner type="danger" closeIcon={null} description={actionError} />}
        {actionNotice && <Banner type="info" closeIcon={null} description={actionNotice} />}
        <Space wrap style={{ marginTop: 12 }}>
          <Popconfirm title="重建当前范围索引" position="top"
            content={`将重新切分并重新向量化【${scopeLabel}】的资料。不影响资料版本与已定版引用；重建期间关键词检索仍可用。`}
            okText="重建" cancelText="取消" onConfirm={() => void rebuild()}>
            <Button theme="solid" icon={<IconRefresh />} loading={actionBusy === "rebuild"}
              disabled={actionBusy !== null || emptyLibrary}>重建当前范围索引</Button>
          </Popconfirm>
          <Button theme="light" loading={actionBusy === "retry"} disabled={actionBusy !== null || emptyLibrary}
            onClick={() => void retry()}>重试失败/未就绪片段</Button>
          <Button theme="borderless" onClick={() => setSettingsOpen(true)}>去设置模型</Button>
        </Space>
      </>}
    </Card>

    <Card className="gy-knowledge-search" title="检索（关键词 / 混合）"
      headerExtraContent={<Typography.Text type="tertiary" size="small">完整检索与引用页由后续交付</Typography.Text>}>
      <Space wrap className="gy-knowledge-search-bar">
        <Input aria-label="检索词" prefix={<IconSearch />} style={{ width: 280 }} value={searchQuery}
          placeholder="输入查询词，回车检索" onChange={setSearchQuery}
          onEnterPress={() => void runSearch()} />
        <Select aria-label="检索模式" value={searchMode} style={{ width: 120 }} onChange={v => setSearchMode(v as KnowledgeSearchMode)}
          optionList={[{ value: "hybrid", label: "混合" }, { value: "keyword", label: "关键词" }]} />
        <Button theme="solid" loading={searchBusy} onClick={() => void runSearch()}>检索</Button>
      </Space>
      {searchError && <Banner type="danger" closeIcon={null} description={searchError} />}
      {searchResult && <>
        <Banner type={searchResult.index.degraded ? "warning" : "success"} closeIcon={null}
          description={`命中 ${searchResult.total} 段 / ${searchResult.materials} 份资料 · 参与版本 ${searchResult.searchedVersions} · 关键词召回 ${searchResult.recall.keyword} · 语义召回 ${searchResult.recall.semantic}${searchResult.index.degraded && searchResult.index.degradedReason ? ` · ${searchResult.index.degradedReason}` : ""}`} />
        <ul className="gy-knowledge-hits">
          {searchResult.hits.slice(0, 12).map(hit => <li key={`${hit.versionId}:${hit.ordinal}`}>
            <Space wrap spacing={4}>
              <Typography.Text strong>{hit.title}</Typography.Text>
              <Tag size="small" color="violet">{hit.locator}</Tag>
              {hit.matchedFields.map(f => <Tag key={f} size="small" color={f === "semantic" ? "blue" : f === "body" ? "green" : "grey"}>{MATCH_FIELD[f] ?? f}</Tag>)}
              {hit.tagOnly && <Tag size="small" color="orange">仅标签命中</Tag>}
              {hit.semanticScore != null && <Typography.Text type="tertiary" size="small">余弦 {hit.semanticScore.toFixed(3)}</Typography.Text>}
            </Space>
            <Typography.Text type="tertiary" size="small" className="gy-knowledge-hit-context">{hit.context}</Typography.Text>
          </li>)}
          {searchResult.hits.length === 0 && <li><Typography.Text type="tertiary">无命中片段</Typography.Text></li>}
        </ul>
      </>}
    </Card>

    <Card className="gy-knowledge-materials" title="资料清单"
      headerExtraContent={summary && <Typography.Text type="tertiary" size="small">
        {summary.materials} 份 · {summary.versions} 版本 · 待补正文 {summary.pendingBody}
      </Typography.Text>}>
      {materials && materials.length === 0 && <Typography.Text type="tertiary">暂无资料（导入入口由完整参考资料页提供）</Typography.Text>}
      <ul className="gy-knowledge-material-list">
        {materials?.map(m => <li key={m.id}>
          <Space wrap spacing={6}>
            <Typography.Text strong>{m.title}</Typography.Text>
            <Tag size="small">{SOURCE_KIND[m.sourceKind] ?? m.sourceKind}</Tag>
            <Tag size="small" color={m.scope.kind === "shared" ? "grey" : "blue"}>{m.scope.kind === "shared" ? "共享" : "委托专属"}</Tag>
            <Typography.Text type="tertiary" size="small">{m.publisher} · {m.versionCount} 个版本{m.effectiveVersionId ? "" : " · 全停用"}</Typography.Text>
          </Space>
        </li>)}
      </ul>
    </Card>

    <SideSheet title="向量化设置" aria-label="向量化设置" visible={settingsOpen} placement="right"
      closeOnEsc width={480} onCancel={() => setSettingsOpen(false)}>
      {/* 每次打开都重新挂载，确保读到的是服务端当前配置，而不是上一次的草稿。 */}
      {settingsOpen && <KnowledgeEmbeddingSettings scopeLabel={scopeLabel} rebuilding={actionBusy === "rebuild"}
        pendingWork={pendingWork} knownEngagements={knownEngagements}
        onSaved={() => { void refreshIndex(); }}
        onRebuild={() => { setSettingsOpen(false); void rebuild(); }} />}
    </SideSheet>
  </div>;
}