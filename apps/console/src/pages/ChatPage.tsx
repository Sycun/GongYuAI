import { useEffect, useRef, useState } from "react";
import { Button, SideSheet, TextArea } from "@douyinfe/semi-ui";
import { IconArrowUp, IconClose, IconFile, IconCommentStroked, IconFolder, IconList, IconRefresh } from "@douyinfe/semi-icons";
import type { ChatCatalog, ChatSelection } from "@gongyuai/contracts";
import { ChatModelPicker, effortLabels } from "../components/ChatModelPicker";
import type { AssignmentView } from "@gongyuai/contracts/chat-input";
import { AssignmentCard } from "../components/AssignmentCard";
import { STATUS_LABEL } from "../labels";
import { ChatTaskProgress, ChatTaskSelect } from "../components/ChatTaskProgress";
import type { TaskLink } from "../chat/useChatProjects";
import { ComposerSafety, ReviewRecord, decisions } from "../components/ComposerSafety";
import type { DraftFile } from "../chat/attachments";
import { BrandMark } from "../components/ChatSidebar";
import type { Conversation, Turn } from "../chat/useConversations";

type Props = {
  catalog: ChatCatalog | null; selected?: ChatSelection; modelError: boolean;
  onSelectModel: (s: ChatSelection) => void; onApprovalSettings: () => void;
  files: DraftFile[]; storing: boolean; onFiles: (files: DraftFile[]) => void; onRemoveFile: (id: string) => void;
  conversation?: Conversation; pending?: string; draft: string; onDraft: (text: string) => void;
  projects: string[]; project: string; onMove: (name: string) => void;
  taskLink?: TaskLink; onLink: (id: string) => void;
  onSend: () => void; onTask: (t: Turn, view: AssignmentView) => void; onRetry: (turn: Turn) => void;
};

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function stateOf(turn: Turn, pending?: string) {
  if (turn.taskStatus) return STATUS_LABEL[turn.taskStatus] ?? turn.taskStatus;
  if (pending === turn.id) return "正在提交";
  if (turn.review && turn.review.decision !== "allow") return decisions[turn.review.decision];
  if (turn.error === "已停止回复") return "已停止";
  return turn.error || !turn.answer ? "回复中断" : "已回复";
}

export function ChatPage({ catalog, selected, modelError, onSelectModel, onApprovalSettings, files, storing, onFiles, onRemoveFile, conversation, pending, draft, onDraft, onSend, onTask, onRetry,
  projects, project, onMove, taskLink, onLink }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [details, setDetails] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const jumpTo = useRef<string | null>(null);
  const last = conversation?.turns.at(-1);
  const anchor = conversation?.turns.find(t => t.id === taskLink?.turnId) ?? conversation?.turns[0];
  const taskCard = taskLink && <ChatTaskProgress key={taskLink.id} taskId={taskLink.id} />;
  useEffect(() => {
    const view = transcript.current;
    if (view && follow.current) view.scrollTop = view.scrollHeight;
  }, [last]);

  function submit() {
    if (reading || storing) return;
    if (draft.trim() === "/model" && !files.length) {
      if (!catalog) return;
      onDraft(""); setModelOpen(true);
    } else if (selected && !pending) onSend();
  }

  const composer = <form className="gy-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
    <TextArea aria-label="任务要求" placeholder="布置任务或添加待审材料，输入 /model 选择模型…" value={draft} onChange={onDraft}
      borderless autosize={{ minRows: 2, maxRows: 7 }} maxLength={32000}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault(); submit();
        }
      }} />
    {files.length > 0 && <div className="gy-attachment-list" aria-label="待发送附件">{files.map(f =>
      <span key={f.id}><IconFile aria-hidden="true" /><b title={f.name}>{f.name}</b>
        <Button size="small" type="tertiary" theme="borderless" icon={<IconClose />} disabled={storing}
          aria-label={"移除 " + f.name} onClick={() => onRemoveFile(f.id)} /></span>)}</div>}
    <div className="gy-composer-actions">
      <ComposerSafety files={files} onFiles={onFiles} onReading={setReading} busy={reading || storing}
        catalog={catalog} onSettings={onApprovalSettings} />
      <div className="gy-composer-right">
      {modelError && !catalog ? <span role="status">模型暂不可用</span> :
        <ChatModelPicker catalog={catalog} selected={selected} open={modelOpen} onOpen={setModelOpen}
          onSelect={onSelectModel} />}
      <Button className="gy-send" theme="solid" htmlType="submit" loading={Boolean(pending)}
        disabled={Boolean(pending) || reading || storing || (!draft.trim() && !files.length) || !selected}
        aria-label="提交任务" title="提交任务" icon={<IconArrowUp />} />
      </div>
    </div>
  </form>;
  return <section className="gy-chat-page">
    <header className="gy-work-header">
      <div className="gy-work-path">{conversation
          ? <><IconFolder aria-hidden="true" /><span className="gy-path-project" title={project}>{project}</span><i>/</i></>
          : <IconCommentStroked aria-hidden="true" />}
        <h1 title={conversation?.title}>{conversation?.title ?? "新会话"}</h1></div>
      <Button theme="borderless" type="tertiary" icon={<IconList />} aria-label="会话详情"
        title="会话详情" aria-haspopup="dialog" onClick={() => setDetails(true)}><span>会话详情</span></Button>
    </header>
    {conversation ? <>
      <div className="gy-transcript" ref={transcript} onScroll={e => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      }}>
        <div className="gy-transcript-inner">
          {conversation.turns.map(t => <article key={t.id} className="gy-turn" id={"turn-" + t.id} tabIndex={-1}>
            <div className="gy-question" aria-label="你">{t.question}
              {Boolean(t.attachments?.length) && <div className="gy-sent-files">{t.attachments!.map(f =>
                <span key={f.id}><IconFile aria-hidden="true" />{f.name}</span>)}</div>}
            </div>
            {t.review && <ReviewRecord review={t.review} />}
            {t.submissionKey && <AssignmentCard turn={t} submitting={pending === t.id} onTask={onTask} onRetry={onRetry} />}
            {(!t.submissionKey || t.answer) && <div className="gy-answer"><div className="gy-answer-brand"><BrandMark />{t.submissionKey ? "任务结果" : "GongYuAI"}
              <time dateTime={new Date(t.created).toISOString()}>{clock.format(t.created)}</time></div>
              {t.answer && <div className="gy-answer-text">{t.answer}</div>}
              {!t.submissionKey && pending === t.id && !t.answer && <span role="status" className="gy-response-state">正在回复…</span>}
              {!t.submissionKey && pending !== t.id && (t.error || !t.answer) && <div className="gy-response-state" role="status">
                <span>{t.error === t.review?.reason && t.error ? decisions[t.review!.decision] : t.error || "上次回复已中断。"}</span>
                {last?.id === t.id && !pending && <Button size="small" type="tertiary" theme="borderless" icon={<IconRefresh />}
                  onClick={() => onRetry(t)}>重试</Button>}
              </div>}
            </div>}
            {t.id === anchor?.id && taskCard}
          </article>)}
        </div>
      </div>
      <div className="gy-composer-dock">{composer}</div>
    </> : <div className="gy-session-start"><div className="gy-welcome-inner">
      <div className="gy-workspace-context"><IconFolder size="small" />{project} 工作区</div>
      <h2>今天要处理什么任务？</h2>
      {taskCard}
      {composer}
    </div></div>}
    <SideSheet title="会话详情" aria-label="会话详情" visible={details} closeOnEsc placement="right"
      width="min(340px, 90vw)" onCancel={() => setDetails(false)} className="gy-session-details"
      afterVisibleChange={visible => {
        if (!visible && jumpTo.current) {
          const target = document.getElementById("turn-" + jumpTo.current);
          target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "start" });
          jumpTo.current = null;
        }
      }}>
      <dl className="gy-session-meta">
        <dt>所属项目</dt><dd><select aria-label="所属项目" value={project} onChange={e => onMove(e.target.value)}>
          {projects.map(name => <option key={name}>{name}</option>)}
        </select></dd>
        <dt>关联任务</dt><dd>{details && <ChatTaskSelect value={taskLink?.id ?? ""} onChange={onLink} />}</dd>
        <dt>当前模型</dt><dd>{selected?.modelId ?? "未选择"}</dd>
        <dt>思考强度</dt><dd>{effortLabels[selected?.effort ?? "default"]}</dd>
        <dt>会话状态</dt><dd>{last ? stateOf(last, pending) : "尚未开始"}</dd>
        {conversation && <><dt>开始时间</dt><dd>{stamp.format(conversation.turns[0].created)}</dd></>}
      </dl>
      {conversation && <section className="gy-session-turns"><h3>会话记录 <span>{conversation.turns.length}</span></h3>
        {conversation.turns.map((t, i) => <button type="button" key={t.id} onClick={() => { jumpTo.current = t.id; setDetails(false); }}>
          <b>{t.question}</b><small>第 {i + 1} 轮 · {stateOf(t, pending)}{t.selection && " · " + (t.replyModel ?? t.selection.modelId) + " · " + effortLabels[t.replyModel && t.replyModel !== t.selection.modelId ? "default" : t.selection.effort ?? "default"]}</small>
        </button>)}
      </section>}
    </SideSheet>
  </section>;
}
