import { useEffect, useRef, useState } from "react";
import { Button, Input, Select, Checkbox } from "@douyinfe/semi-ui";
import { IconPlus, IconSearch } from "@douyinfe/semi-icons";
import type { ChatCatalog, ChatProfile, ChatProtocol, PublicChatProfile } from "@gongyuai/contracts";
import { selectableChatModels } from "@gongyuai/contracts/chat-model-options";
import { ModelInput, protocolOptions, useChatModelQuery } from "./ChatModelFields";
import { api } from "../api";
import { newId } from "../chat/id";

type Props = { initialId?: string | null; catalog: ChatCatalog; onSaved: (catalog: ChatCatalog) => void };
function draftOf(profile: PublicChatProfile): ChatProfile {
  const { hasKey: _, ...data } = profile;
  return { ...data, apiKey: "" };
}

export function ChatModelSettings({ catalog, onSaved, initialId }: Props) {
  const initial = catalog.profiles.find(p => p.id === initialId) ?? catalog.profiles.find(p => p.id === catalog.defaultId) ?? catalog.profiles[0]!;
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [makeDefault, setMakeDefault] = useState(catalog.defaultId === initial.id);
  const [busy, setBusy] = useState<"save" | null>(null);
  const [notice, setNotice] = useState("");
  const { found, busy: querying, query, reset } = useChatModelQuery();
  const saveGuard = useRef(0);
  useEffect(() => () => { saveGuard.current++; }, []);
  const current = catalog.profiles.find(p => p.id === draft.id);
  const choose = (p: PublicChatProfile) => {
    saveGuard.current++; reset();
    setDraft(draftOf(p)); setMakeDefault(p.id === catalog.defaultId);
    setNotice(""); setBusy(null);
  };
  function edit(patch: Partial<ChatProfile>) {
    setDraft(d => ({ ...d, ...patch }));
    setNotice("");
    if ("baseUrl" in patch || "apiKey" in patch || "protocol" in patch) {
      saveGuard.current++; reset(); setBusy(null);
    }
  }
  async function runQuery() {
    setNotice("");
    setNotice(await query(draft));
  }
  async function save() {
    const request = ++saveGuard.current;
    setBusy("save"); setNotice("");
    try {
      const result = await api.saveChatProfile({
        ...draft, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), models: found ?? draft.models,
      }, makeDefault);
      if (saveGuard.current !== request) return;
      onSaved(result.json);
      setDraft(d => ({ ...d, apiKey: "", models: found ?? d.models }));
      setNotice("模型配置已保存。");
    } catch (e) {
      if (saveGuard.current === request) setNotice(e instanceof Error ? e.message : "保存失败。");
    } finally {
      if (saveGuard.current === request) setBusy(null);
    }
  }
  const sameConnection = current && current.baseUrl === draft.baseUrl && current.protocol === draft.protocol && !draft.apiKey;
  const modelOptions = found ?? (sameConnection ? selectableChatModels(current) : []);
  const isCustom = draft.id.startsWith("custom-");
  return <form className="gy-config-card gy-model-form" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="gy-field"><label id="chat-provider-label" htmlFor="chat-provider">服务商</label>
      <div className="gy-field-action"><Select id="chat-provider" aria-labelledby="chat-provider-label" value={draft.id}
        disabled={busy === "save"} optionList={[
          ...catalog.profiles.map(p => ({ value: p.id, label: p.name })),
          ...(!current ? [{ value: draft.id, label: "自定义服务" }] : []),
        ]} onSelect={id => { const p = catalog.profiles.find(item => item.id === id); if (p) choose(p); }} />
        <Button theme="light" icon={<IconPlus />} disabled={busy === "save"} onClick={() => choose({
          id: "custom-" + newId(), name: "", baseUrl: "", protocol: "openai", modelId: "", models: [], hasKey: false,
        })}>添加服务商</Button>
      </div>
    </div>
    {isCustom && <div className="gy-field"><label htmlFor="chat-profile-name">显示名称</label>
      <Input id="chat-profile-name" value={draft.name} placeholder="例如：本地模型" onChange={name => edit({ name })} required /></div>}
    <div className="gy-field"><label id="chat-protocol-label" htmlFor="chat-protocol">接口协议</label>
      <Select id="chat-protocol" aria-labelledby="chat-protocol-label" value={draft.protocol} optionList={protocolOptions}
        onSelect={value => edit({ protocol: value as ChatProtocol, models: [] })} /></div>
    <div className="gy-field"><label htmlFor="chat-base">服务地址</label>
      <Input id="chat-base" value={draft.baseUrl} type="url" required placeholder="https://api.deepseek.com"
        aria-describedby="gy-url-help" onChange={baseUrl => edit({ baseUrl, models: [] })} />
      <small id="gy-url-help">系统自动补全 /{draft.protocol === "gemini" ? "v1beta" : "v1"}，无需手动输入。</small></div>
    <div className="gy-field"><label htmlFor="chat-key">接口密钥</label>
      <Input id="chat-key" mode="password" autoComplete="off" value={draft.apiKey}
        placeholder={current?.hasKey && current.baseUrl === draft.baseUrl && current.protocol === draft.protocol ? "已保存密钥，留空沿用" : "输入服务商提供的密钥"}
        onChange={apiKey => edit({ apiKey })} /></div>
    <div className="gy-field"><label htmlFor="chat-model-id">主模型</label>
      <div className="gy-field-action"><ModelInput key={draft.id} id="chat-model-id" options={modelOptions} value={draft.modelId} placeholder="选择或输入模型标识"
        required onChange={modelId => edit({ modelId })} />
        <Button icon={<IconSearch />} theme="light" loading={querying} disabled={!draft.baseUrl.trim() || busy === "save"}
          onClick={() => void runQuery()}>查询模型</Button>
      </div>
    </div>
    <div className="gy-field"><label htmlFor="chat-vision-model">视觉模型</label>
      <ModelInput key={draft.id} id="chat-vision-model" options={modelOptions} value={draft.visionModelId ?? ""}
        placeholder={draft.modelId ? "留空沿用主模型（" + draft.modelId + "）" : "可选，留空沿用主模型"}
        onChange={visionModelId => edit({ visionModelId })} />
    </div>
    <Checkbox checked={makeDefault} disabled={draft.id === catalog.defaultId}
      onChange={e => setMakeDefault(Boolean(e.target.checked))}>设为新任务的默认模型</Checkbox>
    <div className="gy-form-footer"><Button htmlType="submit" theme="solid" loading={busy === "save"}
      disabled={querying || !draft.name.trim() || !draft.modelId.trim() || !draft.baseUrl.trim()}>保存配置</Button>
      <span role="status">{notice}</span></div>
  </form>;
}
