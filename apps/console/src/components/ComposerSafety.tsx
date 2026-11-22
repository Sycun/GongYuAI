import { useEffect, useRef, useState } from "react";
import { Button, SideSheet, Toast } from "@douyinfe/semi-ui";
import { IconPaperclipStroked, IconShieldStroked } from "@douyinfe/semi-icons";
import { CHAT_FILE_ACCEPT, MAX_CHAT_FILES, MAX_FILES_BYTES, type ApprovalReceipt, type ChatApproval } from "@gongyuai/contracts/chat-input";
import type { ChatCatalog } from "@gongyuai/contracts";
import { api } from "../api";
import { prepareFile, type DraftFile } from "../chat/attachments";

export const decisions = { allow: "审批通过", block: "审批拦截", unavailable: "审批未完成" };
const risks = { low: "低风险", medium: "中风险", high: "高风险", unknown: "风险未确定" };
export function ReviewRecord({ review }: { review: ApprovalReceipt }) {
  return <details className={'gy-review-record gy-review-' + review.decision}>
    <summary>{decisions[review.decision]} · {risks[review.risk]}</summary>
    <p>{review.reason}</p><small>{review.model || "模型不可用"} · {new Date(review.at).toLocaleString("zh-CN")}</small>
  </details>;
}
type Props = {
  files: DraftFile[]; onFiles: (files: DraftFile[]) => void; onReading: (reading: boolean) => void;
  busy: boolean; catalog: ChatCatalog | null; onSettings: () => void;
};
export function ComposerSafety({ files, onFiles, onReading, busy, catalog, onSettings }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<ChatApproval | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false); setPolicy(null);
    api.approval().then(r => { if (active) setPolicy(r.json); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [open]);

  async function attach(picked: File[]) {
    if (!picked.length) return;
    if (files.length + picked.length > MAX_CHAT_FILES || [...files.map(f => f.bytes), ...picked.map(f => f.size)].reduce((a,b) => a+b,0) > MAX_FILES_BYTES) {
      Toast.error("每条消息最多 4 个附件，合计不超过 2 MiB。"); return;
    }
    onReading(true);
    try { onFiles(await Promise.all(picked.map(prepareFile))); }
    catch (e) { Toast.error(e instanceof Error ? e.message : "读取附件失败。"); }
    finally { onReading(false); }
  }
  const selected = policy?.reviewer;
  const profile = catalog?.profiles.find(p => p.id === (selected?.profileId ?? catalog?.defaultId));
  return <div className="gy-composer-left">
    <input type="file" hidden multiple ref={input} accept={CHAT_FILE_ACCEPT} aria-label="选择附件" onChange={e => {
      const picked = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void attach(picked);
    }} />
    <Button type="tertiary" theme="borderless" disabled={busy} icon={<IconPaperclipStroked />}
      aria-label="添加附件" title="添加文本或图片附件" onClick={() => input.current?.click()} />
    <Button type="tertiary" theme="borderless" icon={<IconShieldStroked />} aria-label="命令审批"
      aria-haspopup="dialog" onClick={() => setOpen(true)}><span>审批</span></Button>
    <SideSheet title="命令审批" aria-label="命令审批" visible={open} closeOnEsc width="min(360px, 92vw)" onCancel={() => setOpen(false)}>
      {policy ? <dl className="gy-session-meta"><dt>审批模型</dt><dd>{selected?.modelId ?? profile?.modelId ?? "未配置"}</dd>
        <dt>审查范围</dt><dd>{policy.scope === "read-only" ? "只读分析" : "只读分析与低风险本地校验"}</dd></dl> :
        <p role="status">{failed ? "无法读取审批策略" : "读取审批策略…"}</p>}
      <p className="gy-approval-note">任务在执行命令前检查风险。被拦截时，任务回执或关联任务进展卡会显示暂停原因。</p>
      <Button onClick={() => { setOpen(false); onSettings(); }}>审批设置</Button>
    </SideSheet>
  </div>;
}
