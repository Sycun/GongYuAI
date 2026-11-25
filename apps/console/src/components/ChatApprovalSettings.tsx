import { useEffect, useState } from "react";
import { Button, Input, Select } from "@douyinfe/semi-ui";
import { IconSearch } from "@douyinfe/semi-icons";
import { selectableChatModels } from "@gongyuai/contracts/chat-model-options";
import type { ChatApproval } from "@gongyuai/contracts/chat-input";
import type { ChatCatalog, ChatProtocol } from "@gongyuai/contracts";
import { ModelInput, protocolOptions, useChatModelQuery } from "./ChatModelFields";
import { approvalModelForm, approvalModelProfile, type ApprovalModelForm } from "./approvalModelConfig";
import { confirmationOptions, confirmationExample } from "../approvalPolicy";
import { api } from "../api";
import { newId } from "../chat/id";

type Mode = "reuse" | "independent";
type Props = { catalog: ChatCatalog | null; onCatalog: (value: ChatCatalog) => void; online?: boolean | null };

export function ChatApprovalSettings({ catalog, onCatalog, online }: Props) {
  const [draft, setDraft] = useState<ChatApproval | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode | null>(null);
  const [form, setForm] = useState<ApprovalModelForm | null>(null);
  const { found, busy: querying, query, reset } = useChatModelQuery();
  useEffect(() => {
    let active = true;
    setMessage("");
    api.approval().then(r => { if (active) setDraft(r.json); }).catch(() => { if (active) setMessage("读取审批策略失败。"); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (online === true && !draft && message) setAttempt(n => n + 1);
  }, [online, draft, message]);
  if (!draft) return <div role="status">{message || "读取审批策略…"} {message && <Button onClick={() => setAttempt(n => n+1)}>重试</Button>}</div>;

  const effective: Mode = mode ?? (draft.reviewer ? "independent" : "reuse");
  const defaultProfile = catalog?.profiles.find(p => p.id === catalog.defaultId);
  const reviewerProfile = draft.reviewer ? catalog?.profiles.find(p => p.id === draft.reviewer!.profileId) : undefined;
  const formBase = form ? catalog?.profiles.find(p => p.id === form.id) : undefined;
  const modelOptions = form ? found ?? (formBase && formBase.baseUrl === form.baseUrl && formBase.protocol === form.protocol && !form.apiKey
    ? selectableChatModels(formBase) : []) : [];

  function chooseReuse() {
    setMode("reuse"); setForm(null); reset(); setMessage("");
  }
  function chooseIndependent() {
    if (!draft) return;
    setMode("independent"); setMessage("");
    if (!draft.reviewer && !form) { reset(); setForm(approvalModelForm(undefined, undefined, newId)); }
  }
  function openEdit() {
    if (!draft) return;
    reset();
    setForm(approvalModelForm(reviewerProfile, draft.reviewer?.modelId, newId));
    setMode("independent"); setMessage("");
  }
  function cancelForm() {
    setForm(null); setMode(null); reset(); setMessage("");
  }
  function editForm(patch: Partial<ApprovalModelForm>) {
    setForm(f => f ? { ...f, ...patch } : f);
    setMessage("");
    if ("baseUrl" in patch || "apiKey" in patch || "protocol" in patch) reset();
  }
  async function runQuery() {
    if (!form) return;
    setMessage("");
    setMessage(await query(form));
  }
  async function save() {
    if (!draft) return;
    setSaving(true); setMessage("");
    try {
      let reviewer = draft.reviewer;
      if (effective === "reuse") reviewer = null;
      else if (form) {
        const profile = approvalModelProfile(form, formBase, found);
        const saved = await api.saveChatProfile(profile, false);
        onCatalog(saved.json);
        reviewer = { profileId: profile.id, modelId: form.modelId.trim() };
      }
      setDraft((await api.saveApproval({ ...draft, reviewer })).json);
      setForm(null); setMode(null);
      setMessage("审批策略已保存。");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }
  const formIncomplete = form !== null && (!form.baseUrl.trim() || !form.modelId.trim());
  return <div className="gy-settings-stack"><form className="gy-config-card gy-model-form" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="gy-field"><label id="gy-review-model">审批模型</label>
      <div className="gy-approval-options" role="radiogroup" aria-labelledby="gy-review-model">
        <div className={"gy-approval-option" + (effective === "reuse" ? " is-on" : "")}>
          <label className="gy-approval-option-head">
            <input type="radio" name="gy-approval-mode" checked={effective === "reuse"} disabled={saving} onChange={chooseReuse} />
            <span>复用主模型</span>
          </label>
          <small>当前默认服务商 {catalog ? defaultProfile ? defaultProfile.name + " · " + defaultProfile.modelId : "未配置" : "读取中"}，更换默认主模型后审批自动跟随。</small>
        </div>
        <div className={"gy-approval-option" + (effective === "independent" ? " is-on" : "")}>
          <label className="gy-approval-option-head">
            <input type="radio" name="gy-approval-mode" checked={effective === "independent"} disabled={saving} onChange={chooseIndependent} />
            <span>{draft.reviewer ? "独立审批模型" : "新增模型配置"}</span>
          </label>
          {draft.reviewer && !form && <div className="gy-approval-current">
            <small>当前服务商 {reviewerProfile ? reviewerProfile.name : draft.reviewer.profileId} · {draft.reviewer.modelId}{reviewerProfile ? "" : "（当前不可用）"}</small>
            <Button size="small" theme="light" disabled={saving} onClick={openEdit}>编辑配置</Button>
          </div>}
          {form && <div className="gy-approval-form">
            <div className="gy-field"><label id="gy-review-protocol-label" htmlFor="gy-review-protocol">接口协议</label>
              <Select id="gy-review-protocol" aria-labelledby="gy-review-protocol-label" value={form.protocol} optionList={protocolOptions} disabled={saving}
                onSelect={value => editForm({ protocol: value as ChatProtocol, models: [] })} /></div>
            <div className="gy-field"><label htmlFor="gy-review-base">服务地址</label>
              <Input id="gy-review-base" value={form.baseUrl} type="url" required placeholder="https://api.deepseek.com"
                aria-describedby="gy-review-url-help" disabled={saving} onChange={baseUrl => editForm({ baseUrl, models: [] })} />
              <small id="gy-review-url-help">系统自动补全 /{form.protocol === "gemini" ? "v1beta" : "v1"}，无需手动输入。</small></div>
            <div className="gy-field"><label htmlFor="gy-review-key">接口密钥</label>
              <Input id="gy-review-key" mode="password" autoComplete="off" value={form.apiKey} disabled={saving}
                placeholder={formBase?.hasKey && formBase.baseUrl === form.baseUrl && formBase.protocol === form.protocol ? "已保存密钥，留空沿用" : "输入服务商提供的密钥"}
                onChange={apiKey => editForm({ apiKey })} /></div>
            <div className="gy-field"><label htmlFor="gy-review-model-id">审批模型</label>
              <div className="gy-field-action"><ModelInput key={form.id} id="gy-review-model-id" options={modelOptions} value={form.modelId}
                placeholder="查询候选或手动输入模型标识" required onChange={modelId => editForm({ modelId })} />
                <Button icon={<IconSearch />} theme="light" loading={querying} disabled={!form.baseUrl.trim() || saving}
                  onClick={() => void runQuery()}>查询模型</Button>
              </div></div>
            <div className="gy-approval-form-actions">
              <Button theme="light" disabled={saving} onClick={cancelForm}>取消</Button>
              <small>取消或保存失败时，原审批选择继续生效；填写完成后用「保存策略」提交。</small>
            </div>
          </div>}
          {!draft.reviewer && !form && <small>单独配置审批使用的服务商、密钥与模型，可手动填写模型标识，不影响默认主模型。</small>}
        </div>
      </div>
      <small>审批模型审查工具名、命令摘要和操作范围。任务说明和附件由任务处理器读取。</small></div>
    <div className="gy-field"><label id="gy-review-confirm">命令执行前如何确认</label>
      <div className="gy-approval-options" role="radiogroup" aria-labelledby="gy-review-confirm">
        {confirmationOptions.map(option => <div key={option.value}
          className={"gy-approval-option" + (draft.confirmation === option.value ? " is-on" : "")}>
          <label className="gy-approval-option-head">
            <input type="radio" name="gy-approval-confirm" checked={draft.confirmation === option.value} disabled={saving}
              onChange={() => { setDraft({ ...draft, confirmation: option.value }); setMessage(""); }} />
            <span>{option.label}</span>
          </label>
          <small>{option.description}</small>
        </div>)}
      </div>
      <small>{confirmationExample}</small></div>
    <div className="gy-form-footer"><Button htmlType="submit" theme="solid" loading={saving}
      disabled={querying || formIncomplete}>保存策略</Button><span role="status">{message}</span></div>
  </form></div>;
}
