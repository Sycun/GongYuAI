import { useCallback, useEffect, useRef, useState } from "react";
import {
  Banner, Button, Card, Checkbox, Descriptions, Input, Popconfirm, Progress, Select,
  SideSheet, Space, Tag, Toast, Typography,
} from "@douyinfe/semi-ui";
import { IconClose, IconRefresh, IconSearch, IconSetting, IconUpload } from "@douyinfe/semi-icons";
import type {
  KnowledgeImportInput, KnowledgeImportResult, KnowledgeIndexStatus, KnowledgeMaterialListItem,
  KnowledgeReaderScope, KnowledgeSearchHit, KnowledgeSearchMode, KnowledgeSearchResult,
  KnowledgeSummary, KnowledgeVersionIndexState,
} from "@gongyuai/contracts";
import { api, type KnowledgeScopeParam, type KnowledgeSectionResponse, type TaskRecord } from "../api";
import { KnowledgeEmbeddingSettings } from "../components/KnowledgeEmbeddingSettings";
import { formatDateTime } from "../time";

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
/** 首页固定浏览全局共享文档；任务/委托只通过深链锚定只读范围。 */
function initialScope(query: Record<string, string>): Scope {
  if (query.taskId) return { kind: "task", taskId: query.taskId };
  if (query.engagementId) return { kind: "engagement", engagementId: query.engagementId };
  return { kind: "shared" };
}

const SOURCE_KIND: Record<string, string> = { original: "原文", excerpt: "摘录", editorial: "编辑导读" };
const FORMAT_LABEL: Record<string, string> = { markdown: "Markdown", text: "文本", pdf: "PDF" };
const MATCH_FIELD: Record<string, string> = { body: "正文命中", locator: "章节定位", semantic: "语义相近", title: "标题命中", tags: "标签命中" };
const RESOLVED_FROM: Record<string, string> = { task: "按任务归属", declared: "按声明委托", "shared-only": "全局共享" };

type StagedFormat = "markdown" | "text" | "pdf";
type StagedFile = {
  key: string;
  name: string;
  size: number;
  format: StagedFormat;
  content?: string;
  contentBase64?: string;
  readError?: string;
};
type ImportOutcome = { key: string; name: string; tone: "ok" | "reused" | "warn" | "error"; text: string };

function formatOf(name: string): StagedFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".txt")) return "text";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}
function titleOf(name: string): string {
  return name.replace(/\.(md|markdown|txt|pdf)$/i, "").trim() || name;
}
async function readStaged(file: File): Promise<StagedFile> {
  const format = formatOf(file.name);
  if (!format) {
    return { key: `${file.name}:${file.size}`, name: file.name, size: file.size, format: "text",
      readError: "仅支持 Markdown、TXT、PDF 文件" };
  }
  const staged: StagedFile = { key: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, size: file.size, format };
  try {
    if (staged.format === "pdf") {
      if (file.size > 18 * 1024 * 1024) throw new Error("PDF 超过 18 MiB 上限");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      staged.contentBase64 = btoa(binary);
    } else {
      if (file.size > 8 * 1024 * 1024) throw new Error("文本文件超过 8 MiB 上限");
      staged.content = await file.text();
    }
  } catch (err) {
    staged.readError = err instanceof Error ? err.message : "读取文件失败";
  }
  return staged;
}

/** 逐份状态：待向量化 / 处理中 / 已就绪 / 失败原因。 */
type DocState = { label: string; color: "grey" | "blue" | "green" | "red"; progress?: string; failed?: string };
function docStateOf(item: KnowledgeMaterialListItem): DocState | null {
  if (!item.index) return null;
  const state = item.index.state;
  if (state === "ready") return { label: "已就绪", color: "green" };
  if (state === "indexing") {
    return {
      label: "处理中", color: "blue",
      progress: item.index.totalChunks > 0 ? `${item.index.indexedChunks}/${item.index.totalChunks}` : undefined,
    };
  }
  if (state === "error" || state === "unavailable") {
    return { label: "失败", color: "red", failed: item.index.lastError ?? "向量化服务不可用" };
  }
  return { label: "待向量化", color: "grey" };
}
const TERMINAL_INDEX_STATES = new Set(["ready", "error", "unavailable", "disabled", "unconfigured"]);

type SectionDetail = KnowledgeSectionResponse;

export function KnowledgePage({ query, tasks }: { query: Record<string, string>; tasks: TaskRecord[] }) {
  const [scope, setScope] = useState<Scope>(() => initialScope(query));
  const scopeKey = keyOf(scope);
  const [readerScope, setReaderScope] = useState<KnowledgeReaderScope | null>(null);
  const [index, setIndex] = useState<KnowledgeIndexStatus | null>(null);
  const [materials, setMaterials] = useState<KnowledgeMaterialListItem[] | null>(null);
  const [summary, setSummary] = useState<KnowledgeSummary | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);

  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [stagedChecked, setStagedChecked] = useState<Record<string, boolean>>({});
  const [importBusy, setImportBusy] = useState(false);
  const [importOutcomes, setImportOutcomes] = useState<ImportOutcome[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [vectorBusy, setVectorBusy] = useState(false);
  const [vectorNotice, setVectorNotice] = useState("");
  const [vectorError, setVectorError] = useState("");
  const [polling, setPolling] = useState(false);
  const queuedIdsRef = useRef<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>("hybrid");
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [detail, setDetail] = useState<KnowledgeSearchHit | null>(null);
  const [detailData, setDetailData] = useState<SectionDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [showParent, setShowParent] = useState(false);
  const generation = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // 轮询用最新数据判停，避免把 materials/index 放进轮询 effect 的依赖里反复重建定时器。
  const materialsRef = useRef<KnowledgeMaterialListItem[] | null>(null);
  const indexRef = useRef<KnowledgeIndexStatus | null>(null);
  materialsRef.current = materials;
  indexRef.current = index;

  const knownEngagements = [...new Set(tasks.map(t => t.engagementId ?? t.id))];
  const anchoredTask = scope.kind === "task" ? tasks.find(t => t.id === scope.taskId) : undefined;
  const emptyLibrary = materials !== null && materials.length === 0;
  const modelReady = Boolean(index && index.model && index.state !== "unconfigured" && index.state !== "disabled");
  const semanticReady = index?.state === "ready";
  const selectedDocs = materials?.filter(m => selected.has(m.id)) ?? [];
  const vectorizableIds = selectedDocs
    .map(m => m.effectiveVersionId)
    .filter((id): id is string => Boolean(id));

  // 深链切换（#/knowledge?engagementId=… 或 ?taskId=…）时按当前查询重新锚定范围。
  useEffect(() => { setScope(initialScope(query)); }, [query.taskId, query.engagementId]);

  const reload = useCallback(async () => {
    const gen = generation.current;
    const [idx, mats, sum] = await Promise.all([
      api.knowledgeIndex(paramOf(scopeKey), abortRef.current?.signal),
      api.knowledgeMaterials(paramOf(scopeKey), abortRef.current?.signal),
      api.knowledgeSummary(paramOf(scopeKey), abortRef.current?.signal),
    ]);
    if (gen !== generation.current) return;
    if (idx.ok) { setIndex(idx.json.index); setReaderScope(idx.json.scope); }
    if (mats.ok) setMaterials(mats.json.materials);
    if (sum.ok) setSummary(sum.json);
  }, [scopeKey]);

  // 范围锚定变化：作废在途请求，清空旧范围结果，避免把上一上下文的内容显示到当前页面。
  useEffect(() => {
    const gen = ++generation.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    const param = paramOf(scopeKey);
    setIndex(null); setMaterials(null); setSummary(null); setSearchResult(null); setReaderScope(null);
    setLoadError(""); setVectorNotice(""); setVectorError(""); setPolling(false);
    queuedIdsRef.current = new Set();
    void (async () => {
      const [idx, mats, sum] = await Promise.all([
        api.knowledgeIndex(param, signal),
        api.knowledgeMaterials(param, signal),
        api.knowledgeSummary(param, signal),
      ]);
      if (gen !== generation.current) return;
      if (idx.ok) { setIndex(idx.json.index); setReaderScope(idx.json.scope); }
      else if (idx.kind !== "aborted") setLoadError(idx.error);
      if (mats.ok) setMaterials(mats.json.materials);
      else if (mats.kind !== "aborted") setLoadError(mats.error);
      if (sum.ok) setSummary(sum.json);
    })();
    return () => { controller.abort(); };
  }, [scopeKey, reloadNonce]);

  // 「开始向量化」后的轮询：等每个入队版本到终态，同时刷新列表逐份进度。
  useEffect(() => {
    if (!polling) return;
    const gen = generation.current;
    let active = true;
    let timer = 0;
    let ticks = 0;
    const tick = async () => {
      await reload();
      if (!active || gen !== generation.current) return;
      ticks += 1;
      const queued = queuedIdsRef.current;
      const items = materialsRef.current ?? [];
      const stateOf = (versionId: string): KnowledgeVersionIndexState["state"] | undefined =>
        items.find(m => m.effectiveVersionId === versionId)?.index?.state;
      const settled = queued.size === 0 || [...queued].every(id => {
        const state = stateOf(id) ?? indexRef.current?.state;
        return state === undefined || TERMINAL_INDEX_STATES.has(state);
      });
      if (!settled && ticks < 200) { timer = window.setTimeout(tick, 1500); }
      else { setPolling(false); }
    };
    timer = window.setTimeout(tick, 1200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [polling, reload]);

  function chooseFiles(files: FileList | null) {
    if (!files?.length) return;
    setImportOutcomes([]);
    void (async () => {
      const read = await Promise.all([...files].map(readStaged));
      setStaged(prev => {
        const seen = new Set(prev.map(f => f.key));
        return [...prev, ...read.filter(f => !seen.has(f.key))];
      });
      setStagedChecked(prev => {
        const next = { ...prev };
        for (const f of read) next[f.key] = true;
        return next;
      });
    })();
  }

  function removeStaged(key: string) {
    setStaged(prev => prev.filter(f => f.key !== key));
    setStagedChecked(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function confirmImport() {
    if (importBusy) return;
    const gen = generation.current;
    const picked = staged.filter(f => stagedChecked[f.key] !== false && !f.readError);
    if (!picked.length) { Toast.info("请先选择要导入的文件"); return; }
    setImportBusy(true);
    setImportOutcomes([]);
    const outcomes: ImportOutcome[] = [];
    for (const file of picked) {
      const meta = {
        title: titleOf(file.name),
        publisher: "本地导入",
        sourceKind: "original" as const,
        format: file.format,
        scope: { kind: "shared" as const },
        tags: [] as string[],
      };
      const body: KnowledgeImportInput = file.format === "pdf"
        ? { ...meta, contentBase64: file.contentBase64 ?? "" }
        : { ...meta, content: file.content ?? "" };
      const r = await api.knowledgeImport(body);
      if (gen !== generation.current) return;
      if (!r.ok) {
        outcomes.push({ key: file.key, name: file.name, tone: "error", text: `导入失败：${r.error}` });
        continue;
      }
      const result = r.json as KnowledgeImportResult;
      if (result.version.bodyStatus !== "ready") {
        outcomes.push({
          key: file.key, name: file.name, tone: "warn",
          text: `未提取到可索引文本${result.version.bodyStatusReason ? `：${result.version.bodyStatusReason}` : ""}。已登记资料与版本，不能生成段落引用。`,
        });
      } else if (result.reused) {
        outcomes.push({ key: file.key, name: file.name, tone: "reused", text: `已存在，复用 ${result.version.versionLabel}（${result.sections.length} 片段）。` });
      } else {
        outcomes.push({ key: file.key, name: file.name, tone: "ok", text: `已导入 ${result.version.versionLabel} · ${result.sections.length} 片段。` });
      }
    }
    setImportBusy(false);
    setImportOutcomes(outcomes);
    const okCount = outcomes.filter(o => o.tone === "ok" || o.tone === "reused").length;
    const warnCount = outcomes.filter(o => o.tone === "warn").length;
    if (okCount && !warnCount) Toast.success(`已导入 ${okCount} 份文档`);
    else if (warnCount) Toast.warning(`导入完成：${okCount} 份可用，${warnCount} 份未提取到可索引文本`);
    setStaged([]);
    setStagedChecked({});
    if (fileInputRef.current) fileInputRef.current.value = "";
    await reload();
    if (gen !== generation.current) return;
    // 导入只登记待向量化；勾选与入队都留给用户显式动作。
    setVectorNotice(outcomes.some(o => o.tone === "warn")
      ? "有文档未提取到可索引文本，关键词与语义检索都不会命中其正文。"
      : "导入完成。勾选文档后点「开始向量化」建立语义索引；在此之前可用关键词检索。");
  }

  async function queueVectorize(versionIds: string[], label: string) {
    if (vectorBusy) return;
    const gen = generation.current;
    setVectorBusy(true); setVectorError(""); setVectorNotice("");
    const r = await api.knowledgeRetry(paramOf(scopeKey), { versionIds });
    if (gen !== generation.current) return;
    setVectorBusy(false);
    if (!r.ok) { setVectorError(r.error); Toast.error(r.error); return; }
    setIndex(r.json.status); setReaderScope(r.json.scope);
    if (!r.json.queued.length) {
      setVectorNotice(`${label}已全部就绪，没有需要向量化的版本。`);
      Toast.info("没有需要向量化的资料");
      return;
    }
    queuedIdsRef.current = new Set(r.json.queued);
    setPolling(true);
    Toast.success(`已排队：${label} ${r.json.queued.length} 个版本开始向量化`);
  }

  async function startVectorize() {
    if (!vectorizableIds.length) { Toast.info("请先勾选要向量化的文档"); return; }
    if (!modelReady) {
      setSettingsOpen(true);
      setVectorNotice("尚未配置向量模型。保存配置后勾选会保留，回到这里再点「开始向量化」。");
      return;
    }
    await queueVectorize(vectorizableIds, "所选文档");
  }

  async function retryOne(item: KnowledgeMaterialListItem) {
    if (!item.effectiveVersionId || !item.index) return;
    await queueVectorize([item.effectiveVersionId], `《${item.title}》`);
  }

  async function rebuildScope() {
    const gen = generation.current;
    setVectorBusy(true); setVectorError(""); setVectorNotice("");
    const r = await api.knowledgeRebuild(paramOf(scopeKey));
    if (gen !== generation.current) return;
    setVectorBusy(false);
    if (!r.ok) { setVectorError(r.error); Toast.error(r.error); return; }
    setIndex(r.json.status);
    queuedIdsRef.current = new Set(r.json.versions);
    setPolling(true);
    Toast.success(`已排队：重切分并重新向量化 ${r.json.versions.length} 个版本（不影响资料版本与定版引用）`);
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

  async function openDetail(hit: KnowledgeSearchHit) {
    setDetail(hit); setDetailData(null); setDetailError(""); setDetailBusy(true); setShowParent(false);
    const r = await api.knowledgeSection(hit.materialId, hit.versionId, hit.locator, paramOf(scopeKey));
    setDetailBusy(false);
    if (r.ok) setDetailData(r.json);
    else setDetailError(r.error);
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  }

  const stagedPickCount = staged.filter(f => stagedChecked[f.key] !== false && !f.readError).length;
  const pct = index && index.totalChunks > 0 ? Math.round((index.indexedChunks / index.totalChunks) * 100) : 0;

  return <div className="gy-knowledge">
    <input ref={fileInputRef} type="file" multiple className="gy-sr-file"
      aria-label="选择文档" accept=".md,.markdown,.txt,.pdf"
      onChange={e => { chooseFiles(e.target.files); e.target.value = ""; }} />

    <Card className="gy-knowledge-import" title={<Space><IconUpload aria-hidden="true" />导入文档</Space>}
      headerExtraContent={
        <Button size="small" theme="solid" icon={<IconUpload />}
          loading={importBusy} onClick={() => fileInputRef.current?.click()}>选择文档</Button>
      }>
      {emptyLibrary && <div className="gy-knowledge-empty">
        <Typography.Title heading={5}>知识库还是空的</Typography.Title>
        <Typography.Text type="tertiary">
          支持一次多选 Markdown、TXT、PDF。操作顺序：选择本地文档 → 导入全局知识库 → 配置或沿用向量模型 → 开始向量化 → 检索。
          导入的文档写入共享范围，跨项目、跨任务可检索；未配置模型也能先完成导入。
        </Typography.Text>
      </div>}
      {!emptyLibrary && <Typography.Text type="tertiary" size="small" className="gy-knowledge-import-note">
        多选 Markdown / TXT / PDF；文件名作标题，写入共享范围，跨项目、跨任务可检索。导入不触发向量化。
      </Typography.Text>}

      {staged.length > 0 && <>
        <ul className="gy-knowledge-stage">
          {staged.map(f => <li key={f.key} className={f.readError ? "gy-knowledge-stage-error" : ""}>
            <Space spacing={8} wrap={false}>
              <Checkbox checked={stagedChecked[f.key] !== false && !f.readError}
                disabled={Boolean(f.readError)}
                aria-label={`导入 ${f.name}`}
                onChange={c => setStagedChecked(prev => ({ ...prev, [f.key]: Boolean(c) }))} />
              <Typography.Text strong ellipsis={{ showTooltip: true }} style={{ maxWidth: 320 }}>{f.name}</Typography.Text>
              <Tag size="small">{FORMAT_LABEL[f.format]}</Tag>
              <Typography.Text type="tertiary" size="small">{(f.size / 1024).toFixed(1)} KB</Typography.Text>
              {f.readError && <Tag size="small" color="red">{f.readError}</Tag>}
            </Space>
            <Button size="small" theme="borderless" type="danger" icon={<IconClose />}
              aria-label={`移除 ${f.name}`} onClick={() => removeStaged(f.key)} />
          </li>)}
        </ul>
        <Space style={{ marginTop: 10 }}>
          <Button theme="solid" loading={importBusy} disabled={!stagedPickCount}
            onClick={() => void confirmImport()}>确认导入（{stagedPickCount} 份）</Button>
          <Button theme="light" disabled={importBusy}
            onClick={() => { setStaged([]); setStagedChecked({}); }}>清空</Button>
        </Space>
      </>}

      {importOutcomes.length > 0 && <>
        <ul className="gy-knowledge-outcomes">
          {importOutcomes.map(o => <li key={o.key}>
            <Tag size="small" color={o.tone === "error" ? "red" : o.tone === "warn" ? "orange" : o.tone === "reused" ? "blue" : "green"}>
              {o.tone === "error" ? "失败" : o.tone === "warn" ? "未提取到可索引文本" : o.tone === "reused" ? "已存在" : "已导入"}
            </Tag>
            <Typography.Text strong>{o.name}</Typography.Text>
            <Typography.Text type="tertiary" size="small">{o.text}</Typography.Text>
          </li>)}
        </ul>
        <Button size="small" theme="borderless" icon={<IconClose />}
          onClick={() => setImportOutcomes([])}>清除结果</Button>
      </>}
    </Card>

    {!emptyLibrary && <>
      <Card className="gy-knowledge-vector" title="向量化"
        headerExtraContent={<Button size="small" theme="borderless" icon={<IconSetting />}
          onClick={() => setSettingsOpen(true)}>{modelReady ? "查看模型" : "配置模型"}</Button>}>
        <div className="gy-knowledge-vector-bar">
          <Space spacing={8} wrap>
            {modelReady
              ? <Typography.Text>当前模型 <Typography.Text strong>{index?.model}</Typography.Text>
                <Typography.Text type="tertiary">（{index?.providerKind === "cloud" ? "云端" : "本地"}服务）</Typography.Text></Typography.Text>
              : <Typography.Text type="warning">未配置向量模型</Typography.Text>}
            <Tag size="small" color={semanticReady ? "green" : "grey"}>
              {semanticReady ? "语义检索可用" : "可用关键词检索"}
            </Tag>
            {readerScope && scope.kind !== "shared" && <Tag size="small" color="blue">
              {RESOLVED_FROM[readerScope.resolvedFrom]} · {readerScope.engagementId ?? "无委托"}
            </Tag>}
          </Space>
          <Space>
            {anchoredTask && <Typography.Text type="tertiary" size="small">任务上下文：{anchoredTask.name}</Typography.Text>}
            <Popconfirm title="开始向量化所选文档" position="top"
              content={`将勾选的 ${vectorizableIds.length} 份文档加入索引队列；已就绪的自动跳过，不影响资料版本与定版引用。`}
              okText="开始" cancelText="取消" onConfirm={() => void startVectorize()}>
              <Button theme="solid" loading={vectorBusy} disabled={!vectorizableIds.length || polling}>
                开始向量化（{vectorizableIds.length}）
              </Button>
            </Popconfirm>
          </Space>
        </div>
        {!modelReady && <Banner type="info" closeIcon={null}
          description="未配置模型也能导入与检索。配置保存后勾选会保留，点「开始向量化」才会向模型服务发送文档片段。" />}
        {semanticReady === false && Boolean(materials?.some(m => m.index?.state === "ready")) && <Banner type="info" closeIcon={null}
          description="部分文档已向量化；本轮检索范围尚未整体就绪，关键词检索始终可用。" />}
        {polling && <>
          <Progress percent={pct} aria-label="向量化进度" style={{ margin: "10px 0" }} />
          <Typography.Text type="tertiary" size="small">已索引 {index?.indexedChunks ?? 0} / {index?.totalChunks ?? 0} 片段，正在处理勾选的文档…</Typography.Text>
        </>}
        {index?.blockedChunks ? <Banner type="warning" closeIcon={null}
          description={`本范围有 ${index.blockedChunks} 个已索引片段属于未获授权的向量化服务，不参与语义召回，也不会把查询文本发给该服务。`} /> : null}
        {vectorNotice && <Banner type="info" closeIcon={null} description={vectorNotice} />}
        {vectorError && <Banner type="danger" closeIcon={null} description={vectorError} />}
        {loadError && <Banner type="danger" closeIcon={null} description={loadError} />}
      </Card>

      <Card className="gy-knowledge-search" title="检索"
        headerExtraContent={<Typography.Text type="tertiary" size="small">
          {semanticReady ? "语义检索可用" : "有正文即可用关键词检索；向量完成后语义检索可用"}
        </Typography.Text>}>
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
                <Button size="small" theme="borderless" className="gy-knowledge-hit-title"
                  onClick={() => void openDetail(hit)}>{hit.title}</Button>
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

      <Card className="gy-knowledge-materials" title="文档列表"
        headerExtraContent={<Space>
          {summary && <Typography.Text type="tertiary" size="small">
            {summary.materials} 份 · {summary.versions} 版本 · 待补正文 {summary.pendingBody}
          </Typography.Text>}
          <Button size="small" icon={<IconRefresh />} theme="borderless"
            onClick={() => setReloadNonce(n => n + 1)}>刷新</Button>
        </Space>}>
        {materials && materials.length === 0 && <Typography.Text type="tertiary">暂无文档</Typography.Text>}
        {materials && materials.length > 0 && <ul className="gy-knowledge-material-list">
          {materials.map(m => {
            const doc = docStateOf(m);
            const failed = doc?.failed;
            return <li key={m.id} className="gy-knowledge-doc-row">
              <div className="gy-knowledge-doc-main">
                <Checkbox aria-label={`选择 ${m.title}`} checked={selected.has(m.id)}
                  disabled={!m.effectiveVersionId}
                  onChange={c => toggleSelect(m.id, Boolean(c))} />
                <Space wrap spacing={6}>
                  <Typography.Text strong>{m.title}</Typography.Text>
                  <Tag size="small">{SOURCE_KIND[m.sourceKind] ?? m.sourceKind}</Tag>
                  {m.version && <Tag size="small" color="grey">{FORMAT_LABEL[m.version.format] ?? m.version.format}</Tag>}
                  {m.scope.kind === "shared"
                    ? <Tag size="small" color="grey">共享</Tag>
                    : <Tag size="small" color="blue">委托专属 · {m.scope.engagementId}</Tag>}
                  {m.versionCount > 1 && <Typography.Text type="tertiary" size="small">{m.versionCount} 个版本</Typography.Text>}
                  <Typography.Text type="tertiary" size="small">
                    {m.publisher} · {m.version ? `${m.version.versionLabel} · ${formatDateTime(m.version.importedAt)}` : "—"}
                  </Typography.Text>
                </Space>
              </div>
              <Space spacing={6} wrap className="gy-knowledge-doc-status">
                {m.version && m.version.bodyStatus !== "ready" && <Tag size="small" color="orange">未提取到可索引文本</Tag>}
                {m.effectiveVersionId === null && <Tag size="small" color="grey">全部版本已停用</Tag>}
                {doc && <Tag size="small" color={doc.color}>{doc.label}{doc.progress ? ` ${doc.progress}` : ""}</Tag>}
                {failed && <>
                  <Typography.Text type="danger" size="small" className="gy-knowledge-doc-error">{failed}</Typography.Text>
                  <Button size="small" theme="light" loading={vectorBusy}
                    onClick={() => void retryOne(m)}>重试</Button>
                </>}
              </Space>
            </li>;
          })}
        </ul>}
      </Card>
    </>}

    <SideSheet title="向量化设置" aria-label="向量化设置" visible={settingsOpen} placement="right"
      closeOnEsc width="min(480px, 100vw)" onCancel={() => setSettingsOpen(false)}>
      {/* 每次打开都重新挂载，确保读到的是服务端当前配置，而不是上一次的草稿。保存后勾选保留在列表页。 */}
      {settingsOpen && <KnowledgeEmbeddingSettings scopeLabel="共享资料（全局）" rebuilding={vectorBusy}
        pendingWork={index ? index.pendingChunks + index.failedChunks : 0} knownEngagements={knownEngagements}
        onSaved={() => { void reload(); }}
        onRebuild={() => { setSettingsOpen(false); void rebuildScope(); }} />}
    </SideSheet>

    <SideSheet title="命中片段原文" aria-label="命中片段原文" visible={detail !== null} placement="right"
      closeOnEsc width="min(560px, 100vw)" onCancel={() => setDetail(null)}>
      {detail && <>
        <Space wrap spacing={6} style={{ marginBottom: 8 }}>
          <Typography.Text strong>{detail.title}</Typography.Text>
          <Tag size="small" color="violet">{detail.locator}</Tag>
          <Tag size="small">{detail.versionLabel}</Tag>
          {detail.versionStatus === "deprecated" && <Tag size="small" color="orange">已停用</Tag>}
        </Space>
        {detailBusy && <span role="status">正在读取原文…</span>}
        {detailError && <Banner type="danger" closeIcon={null} description={detailError} />}
        {detailData && <>
          <Typography.Text type="tertiary" size="small" className="gy-knowledge-detail-crumb">
            {detailData.context.headingPath.join(" › ")}
          </Typography.Text>
          <Typography.Paragraph className="gy-knowledge-detail-text">
            {detailData.section.text}
          </Typography.Paragraph>
          <Space vertical align="start" spacing={4} className="gy-knowledge-detail-siblings">
            {detailData.context.previous && <Typography.Text type="tertiary" size="small">
              上一段（{detailData.context.previous.locator}）：{detailData.context.previous.text.slice(0, 120)}…
            </Typography.Text>}
            {detailData.context.next && <Typography.Text type="tertiary" size="small">
              下一段（{detailData.context.next.locator}）：{detailData.context.next.text.slice(0, 120)}…
            </Typography.Text>}
          </Space>
          <Button size="small" theme="light" style={{ marginTop: 10 }}
            onClick={() => setShowParent(v => !v)}>{showParent ? "收起整章" : "查看整章"}</Button>
          {showParent && <Typography.Paragraph className="gy-knowledge-detail-parent">
            {detailData.context.parentText}
          </Typography.Paragraph>}
          <Descriptions align="left" size="small" data={[
            { key: "片段校验值", value: detailData.section.chunkSha256.slice(0, 16) + "…" },
            { key: "原文范围", value: `[${detailData.section.charStart}, ${detailData.section.charEnd})` },
            ...(detailData.section.page != null ? [{ key: "页码", value: `p.${detailData.section.page}` }] : []),
          ]} />
        </>}
      </>}
    </SideSheet>
  </div>;
}
