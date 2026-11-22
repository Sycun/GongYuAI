import { useEffect, useState } from "react";
import { Button, Select } from "@douyinfe/semi-ui";
import { selectableChatModels } from "@gongyuai/contracts/chat-model-options";
import type { ChatApproval } from "@gongyuai/contracts/chat-input";
import type { ChatCatalog } from "@gongyuai/contracts";
import { api } from "../api";

export const scopes = { "read-only": "只读分析", "local-validation": "只读分析与低风险本地校验" };
export function ChatApprovalSettings({ catalog }: { catalog: ChatCatalog | null }) {
  const [draft, setDraft] = useState<ChatApproval | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api.approval().then(r => { if (active) setDraft(r.json); }).catch(() => { if (active) setMessage("读取审批策略失败。"); });
    return () => { active = false; };
  }, [attempt]);
  if (!draft) return <div role="status">{message || "读取审批策略…"} {message && <Button onClick={() => setAttempt(n => n+1)}>重试</Button>}</div>;
  const options = [{ value: "", label: "使用默认服务商的主模型" }, ...(catalog?.profiles.flatMap(p =>
    selectableChatModels(p).map(id => ({ value: JSON.stringify([p.id, id]), label: p.name + " · " + id }))) ?? [])];
  const reviewerKey = draft.reviewer ? JSON.stringify([draft.reviewer.profileId, draft.reviewer.modelId]) : "";
  if (reviewerKey && !options.some(o => o.value === reviewerKey)) options.push({ value: reviewerKey, label: draft.reviewer!.modelId + "（当前不可用）" });
  async function save() {
    if (!draft) return;
    setSaving(true);
    try { setDraft((await api.saveApproval(draft)).json); setMessage("审批策略已保存。"); }
    catch (e) { setMessage(e instanceof Error ? e.message : "保存失败。"); }
    finally { setSaving(false); }
  }
  return <div className="gy-settings-stack"><form className="gy-config-card gy-model-form" onSubmit={e => { e.preventDefault(); void save(); }}>
    <div className="gy-field"><label id="gy-review-model">审批模型</label>
      <Select aria-labelledby="gy-review-model" filter value={reviewerKey} optionList={options} disabled={saving || !catalog}
        onSelect={key => { const [profileId, modelId] = key ? JSON.parse(String(key)) : []; setDraft({ ...draft, reviewer: profileId ? { profileId, modelId } : null }); setMessage(""); }} />
      <small>审批模型审查工具名、命令摘要和操作范围。任务说明和附件由任务处理器读取。</small></div>
    <div className="gy-field"><label id="gy-review-scope">允许的命令范围</label>
      <Select aria-labelledby="gy-review-scope" value={draft.scope} disabled={saving} optionList={Object.entries(scopes).map(([value, label]) => ({ value, label }))}
        onSelect={v => { setDraft({ ...draft, scope: v as ChatApproval["scope"] }); setMessage(""); }} />
      <small>仅范围内的有限本地检查可获准执行。高风险、未识别操作或审批不可用时暂停任务。</small></div>
    <div className="gy-form-footer"><Button htmlType="submit" theme="solid" loading={saving}>保存策略</Button><span role="status">{message}</span></div>
  </form></div>;
}
