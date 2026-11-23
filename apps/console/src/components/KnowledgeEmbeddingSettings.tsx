import { useEffect, useRef, useState } from "react";
import { AutoComplete, Banner, Button, Input, InputNumber, RadioGroup, Select, Switch } from "@douyinfe/semi-ui";
import { IconChevronDown } from "@douyinfe/semi-icons";
import type {
  KnowledgeEmbeddingProvider, KnowledgeEmbeddingTestResult, KnowledgeEmbeddingView,
} from "@gongyuai/contracts";
import { api } from "../api";

type Props = {
  /** 当前委托范围的人类可读标签，用于「重建当前范围索引」按钮。 */
  scopeLabel: string;
  onSaved: () => void;
  /** 宿主按当前范围重建索引并轮询进度。 */
  onRebuild: () => void;
  rebuilding?: boolean;
  /** 当前范围内待索引 + 失败的片段数，用于提示哪些资料需要重建。 */
  pendingWork?: number;
  knownEngagements?: string[];
};

/** 已验收的本机中英多语 embedding 模型；无服务端模型列表接口，作为手动选择种子。 */
const LOCAL_MODEL_SEED = "bge-m3-mlx-4bit";
const CLOUD_MODEL_SEEDS = ["text-embedding-3-small", "text-embedding-3-large", "bge-m3"];

type ServiceDraft = {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string;
  batchSize: number;
  timeoutMs: number;
};

type Draft = {
  enabled: boolean;
  provider: KnowledgeEmbeddingProvider;
  cloudEngagements: string[];
  local: ServiceDraft;
  cloud: ServiceDraft;
};

function serviceDraftOf(view: KnowledgeEmbeddingView["local"]): ServiceDraft {
  return {
    baseUrl: view.baseUrl,
    model: view.model,
    apiKeyEnv: view.apiKeyEnv,
    apiKey: "",
    batchSize: view.batchSize,
    timeoutMs: view.timeoutMs,
  };
}

function draftOf(view: KnowledgeEmbeddingView): Draft {
  return {
    enabled: view.enabled,
    provider: view.provider,
    cloudEngagements: view.cloudEngagements,
    local: serviceDraftOf(view.local),
    cloud: serviceDraftOf(view.cloud),
  };
}

/** 影响索引归属与指纹的字段：变了就提示重建，密钥变化不影响已有向量。 */
function identityOf(view: KnowledgeEmbeddingView): string {
  return JSON.stringify([view.provider, view.local.baseUrl, view.local.model,
    view.cloud.baseUrl, view.cloud.model, [...view.cloudEngagements].sort()]);
}

/** 服务「来源」（协议+主机+端口）：与已存配置不同来源时，留空密钥不再沿用旧值。 */
function sourceOf(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function ModelInput({ id, options, value, onChange }: {
  id: string; options: string[]; value: string; onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filter = search.trim().toLowerCase();
  const matches = filter ? options.filter(model => model.toLowerCase().includes(filter)) : options;
  return <AutoComplete value={value} data={matches} maxHeight={240} motion={false}
    onSearch={setSearch} onChange={model => onChange(String(model))}
    onDropdownVisibleChange={open => { if (!open) setSearch(""); }}
    emptyContent={filter ? "没有匹配的模型，可手动输入" : "可手动输入模型 ID"}
    triggerRender={({ inputValue, onChange: onInput, onFocus, onBlur }) => (
      <Input id={id} value={inputValue} placeholder="选择或输入 embedding 模型 ID"
        onChange={onInput} onFocus={onFocus} onBlur={onBlur}
        suffix={<IconChevronDown size="small" aria-hidden="true" />} />
    )} />;
}

/**
 * 向量化设置。本地与云端两套配置分别保存，切换回来恢复原配置；
 * 密钥与环境变量按服务分开，切到云端不会把本机密钥发出去。
 */
export function KnowledgeEmbeddingSettings({
  scopeLabel, onSaved, onRebuild, rebuilding, pendingWork = 0, knownEngagements = [],
}: Props) {
  const [loaded, setLoaded] = useState<KnowledgeEmbeddingView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [needsRebuild, setNeedsRebuild] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<KnowledgeEmbeddingTestResult | null>(null);
  const generation = useRef(0);
  const testGeneration = useRef(0);

  async function load() {
    const request = ++generation.current;
    setLoadError("");
    try {
      const { json } = await api.settings();
      if (generation.current !== request) return;
      setLoaded(json.knowledgeEmbedding);
      setDraft(draftOf(json.knowledgeEmbedding));
    } catch (e) {
      if (generation.current === request) setLoadError(e instanceof Error ? e.message : "读取向量化配置失败。");
    }
  }
  useEffect(() => { void load(); return () => { generation.current++; testGeneration.current++; }; }, []);

  function edit(patch: Partial<Draft>) {
    setDraft(d => (d ? { ...d, ...patch } : d));
    setNotice("");
  }

  function editService(patch: Partial<ServiceDraft>) {
    setDraft(d => (d ? { ...d, [d.provider]: { ...d[d.provider], ...patch } } : d));
    setNotice("");
    setTestResult(null);
  }

  function servicePayload(service: ServiceDraft) {
    return {
      baseUrl: service.baseUrl.trim(),
      model: service.model.trim(),
      apiKeyEnv: service.apiKeyEnv.trim(),
      apiKey: service.apiKey.trim(),
      batchSize: service.batchSize,
      timeoutMs: service.timeoutMs,
    };
  }

  async function save() {
    if (!draft || !loaded) return;
    const request = ++generation.current;
    setBusy(true); setNotice("");
    try {
      const { json } = await api.saveKnowledgeEmbedding({
        enabled: draft.enabled,
        provider: draft.provider,
        cloudEngagements: draft.cloudEngagements,
        local: servicePayload(draft.local),
        cloud: servicePayload(draft.cloud),
      });
      if (generation.current !== request) return;
      setNeedsRebuild(identityOf(json.knowledgeEmbedding) !== identityOf(loaded));
      setLoaded(json.knowledgeEmbedding);
      setDraft(draftOf(json.knowledgeEmbedding));
      setNotice("向量化配置已保存。");
      onSaved();
    } catch (e) {
      if (generation.current === request) setNotice(e instanceof Error ? e.message : "保存失败。");
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  async function test() {
    if (!draft) return;
    const request = ++testGeneration.current;
    setTesting(true); setTestResult(null); setNotice("");
    const r = await api.testKnowledgeEmbedding({
      provider: draft.provider,
      service: servicePayload(draft[draft.provider]),
    });
    if (testGeneration.current !== request) return;
    setTesting(false);
    if (r.ok) setTestResult(r.json);
    else setTestResult({
      provider: draft.provider, baseUrl: draft[draft.provider].baseUrl,
      model: draft[draft.provider].model, probeText: "", ok: false, error: r.error,
    });
  }

  if (loadError) return <div className="gy-config-card gy-model-form">
    <Banner type="danger" closeIcon={null} description={loadError} />
    <div className="gy-form-footer"><Button theme="light" onClick={() => void load()}>重试</Button></div>
  </div>;
  if (!draft || !loaded) return <span role="status">正在读取向量化配置…</span>;

  const provider = draft.provider;
  const service = draft[provider];
  const savedService = loaded[provider];
  const isCloud = provider === "cloud";
  const sourceSwitched = Boolean(service.baseUrl.trim())
    && sourceOf(service.baseUrl) !== sourceOf(savedService.baseUrl);
  const modelOptions = [...new Set([
    ...(isCloud ? CLOUD_MODEL_SEEDS : [LOCAL_MODEL_SEED]), savedService.model, service.model,
  ].filter(Boolean))];
  const engagementOptions = [...new Set([...knownEngagements, ...draft.cloudEngagements])].filter(Boolean);

  return <form className="gy-config-card gy-model-form" onSubmit={e => { e.preventDefault(); void save(); }}>
    <Banner type="info" closeIcon={null}
      description="服务商会收到：待索引资料的正文片段（含标题路径），以及语义检索的查询文本。原文、版本、向量索引与报告快照始终留在本地，云端只负责计算 embedding。" />
    <div className="gy-field">
      <label id="ke-enabled-label">启用向量化</label>
      <div className="gy-field-action">
        <Switch checked={draft.enabled} aria-labelledby="ke-enabled-label" onChange={enabled => edit({ enabled })} />
        <small>停用后关键词检索仍可用，语义召回关闭。</small>
      </div>
    </div>
    <div className="gy-field">
      <label id="ke-provider-label">向量化服务</label>
      <RadioGroup type="button" aria-labelledby="ke-provider-label" value={provider}
        onChange={e => { edit({ provider: e.target.value as KnowledgeEmbeddingProvider }); setTestResult(null); }}
        options={[{ label: "本地服务", value: "local" }, { label: "云端服务", value: "cloud" }]} />
      <small>两套配置分别保存，切回来恢复原配置。团队共享资料用这里选定的服务；委托专属资料默认本地。</small>
    </div>
    <div className="gy-field">
      <label htmlFor="ke-base">服务地址</label>
      <Input id="ke-base" type="url" value={service.baseUrl}
        placeholder={isCloud ? "https://api.example.com/v1" : "http://127.0.0.1:8000/v1"}
        onChange={baseUrl => editService({ baseUrl })} />
      <small>OpenAI 兼容接口，后端请求 {"{服务地址}"}/embeddings。浏览器只经控制面 API，不直连模型服务。</small>
    </div>
    <div className="gy-field">
      <label htmlFor="ke-model">Embedding 模型</label>
      <ModelInput id="ke-model" options={modelOptions} value={service.model} onChange={model => editService({ model })} />
      <small>{isCloud
        ? "云端首版支持 OpenAI 兼容 /embeddings，模型 ID 可手动填写。"
        : `已验收 ${LOCAL_MODEL_SEED}（中英多语，1024 维）。无服务端模型列表接口，可手动输入其他模型 ID。`}</small>
    </div>
    <div className="gy-field">
      <label htmlFor="ke-env">密钥环境变量</label>
      <Input id="ke-env" value={service.apiKeyEnv}
        placeholder={isCloud ? "GY_CLOUD_EMBEDDING_API_KEY" : "OMLX_API_KEY"}
        onChange={apiKeyEnv => editService({ apiKeyEnv })} />
      <small>{sourceSwitched
        ? "服务地址已换到不同来源，留空保存不会沿用旧来源的密钥环境变量。"
        : "只读该服务自己的环境变量；留空表示不带 Authorization。本机 OMLX_API_KEY 不会发给云端。"}</small>
    </div>
    <div className="gy-field">
      <label htmlFor="ke-key">接口密钥</label>
      <Input id="ke-key" mode="password" autoComplete="off" value={service.apiKey}
        placeholder={sourceSwitched
          ? "已换到不同来源，需重新登记密钥"
          : savedService.apiKeyConfigured ? `已保存密钥（${savedService.apiKeyMask}），留空沿用` : "可选，直接登记密钥"}
        onChange={apiKey => editService({ apiKey })} />
      <small>{sourceSwitched
        ? "不同来源的服务不会继承旧地址的已存密钥，留空即不带 Authorization。"
        : "已存密钥只显示掩码；留空保存保留原密钥。两套服务的密钥互不影响。"}</small>
    </div>
    <div className="gy-field">
      <label htmlFor="ke-batch">批大小</label>
      <InputNumber id="ke-batch" min={1} max={64} value={service.batchSize} onChange={v => editService({ batchSize: Number(v) })} />
    </div>
    <div className="gy-field">
      <label htmlFor="ke-timeout">超时（毫秒）</label>
      <InputNumber id="ke-timeout" min={500} max={120000} step={500} value={service.timeoutMs}
        onChange={v => editService({ timeoutMs: Number(v) })} />
    </div>
    <div className="gy-field">
      <Button theme="light" loading={testing} onClick={() => void test()}
        disabled={!service.baseUrl.trim() || !service.model.trim()}>测试连接</Button>
      <small>后端用固定合成短句请求所选模型，只验证向量有效并报告实测维度，不触发资料重建。</small>
    </div>
    {testResult && <Banner type={testResult.ok ? "success" : "danger"} closeIcon={null}
      description={testResult.ok
        ? `连接成功：模型 ${testResult.model} · 实测维度 ${testResult.dim} · 耗时 ${testResult.durationMs}ms · 服务 ${testResult.baseUrl}`
        : `连接失败：${testResult.error}`} />}
    {isCloud && <div className="gy-field">
      <label htmlFor="ke-cloud-eng">允许云端处理的委托</label>
      <Select id="ke-cloud-eng" aria-label="允许云端处理的委托" multiple filter allowCreate style={{ width: "100%" }}
        value={draft.cloudEngagements} optionList={engagementOptions.map(id => ({ value: id, label: id }))}
        placeholder="默认全部委托只用本地服务；在此明确允许的委托才可发往云端"
        onChange={value => edit({ cloudEngagements: (value as string[]).map(v => v.trim()).filter(Boolean) })} />
      <small>未列入的委托：其专属正文与查询文本一律零次云端请求，即使库里有云端索引的共享资料。</small>
    </div>}
    {(needsRebuild || pendingWork > 0) && <>
      <Banner type="warning" closeIcon={null}
        description={pendingWork > 0
          ? `当前范围（${scopeLabel}）有 ${pendingWork} 个片段待索引或失败，需要重建/重试才能用当前服务召回。重建期间关键词检索仍可用，报告定版引用按原版本回读。`
          : "服务或模型已变更，已有资料需要重建索引才能用新服务召回。重建期间关键词检索仍可用，报告定版引用按原版本回读。"} />
      <div className="gy-field">
        <Button theme="light" type="warning" loading={rebuilding} onClick={onRebuild}>
          重建当前范围索引（{scopeLabel}）
        </Button>
      </div>
    </>}
    <div className="gy-form-footer">
      <Button htmlType="submit" theme="solid" loading={busy}
        disabled={!service.model.trim() || !service.baseUrl.trim()}>保存配置</Button>
      <span role="status">{notice}</span>
    </div>
  </form>;
}