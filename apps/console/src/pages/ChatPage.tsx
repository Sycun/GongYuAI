import { useEffect, useRef, useState } from "react";
import { Button, Select, SideSheet, TextArea } from "@douyinfe/semi-ui";
import { IconArrowUp, IconClose, IconFile, IconCommentStroked, IconFolder, IconList, IconRefresh } from "@douyinfe/semi-icons";
import type { ChatCatalog, ChatSelection, TaskArchiveState } from "@gongyuai/contracts";
import { ChatModelPicker, effortLabels } from "../components/ChatModelPicker";
import type { AssignmentView } from "@gongyuai/contracts/chat-input";
import { AssignmentCard } from "../components/AssignmentCard";
import { ChatMarkdown } from "../components/ChatMarkdown";
import { STATUS_LABEL } from "../labels";
import { ChatTaskSelect } from "../components/ChatTaskProgress";
import type { TaskLink } from "../chat/useChatProjects";
import { projectLabel } from "../chat/projects";
import { ComposerSafety, ReviewRecord, decisions } from "../components/ComposerSafety";
import type { DraftFile } from "../chat/attachments";
import { BrandMark } from "../components/ChatSidebar";
import type { Conversation, Turn } from "../chat/useConversations";
import { GraphDetail, TaskGraphRail } from "../components/TaskGraphRail";
import { PlanCard } from "../components/PlanCard";
import { questionForTask, readNotices, type NoticeItem, type ViewName } from "../workspace/model";
import { discardMemoryCache } from "../workspace/useTaskGraph";

type Props = {
  catalog: ChatCatalog | null; selected?: ChatSelection; modelError: boolean;
  onSelectModel: (s: ChatSelection) => void; onApprovalSettings: () => void;
  files: DraftFile[]; storing: boolean; onFiles: (files: DraftFile[]) => void; onRemoveFile: (id: string) => void;
  conversation?: Conversation; pending?: string; draft: string; onDraft: (text: string) => void;
  projects: string[]; project: string; onMove: (name: string) => void;
  archived: boolean; archiveBusy: boolean; onArchive: (archived: boolean) => void;
  taskArchives: Map<string, TaskArchiveState>; onTaskArchive: (id: string, archived: boolean) => void;
  taskLink?: TaskLink; onLink: (id: string) => void;
  onSend: () => void; onTask: (t: Turn, view: AssignmentView) => void; onRetry: (turn: Turn) => void;
  onCancel: () => void;
  narrow: boolean;
  viewedTaskId: string | null;
  viewMode: "follow" | "pinned" | "waiting";
  taskChoices: string[];
  onPin: (taskId: string) => void;
  onFollow: () => void;
};

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const stamp = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const viewTitle: Record<ViewName, string> = { assets: "资产图", surface: "攻击面图", execution: "执行图", memory: "记忆图" };
function stateOf(turn: Turn, pending?: string) {
  if (turn.taskStatus) return STATUS_LABEL[turn.taskStatus] ?? turn.taskStatus;
  if (pending === turn.id) return "正在提交";
  if (turn.review && turn.review.decision !== "allow") return decisions[turn.review.decision];
  if (turn.error === "已停止回复") return "已停止";
  return turn.error || !turn.answer ? "回复中断" : "已回复";
}

export function ChatPage({ catalog, selected, modelError, onSelectModel, onApprovalSettings, files, storing, onFiles, onRemoveFile, conversation, pending, draft, onDraft, onSend, onTask, onRetry, onCancel,
  projects, project, onMove, taskLink, onLink, narrow, viewedTaskId, viewMode, taskChoices, onPin, onFollow,
  archived, archiveBusy, onArchive, taskArchives, onTaskArchive }: Props) {
  const [modelOpen, setModelOpen] = useState(false);
  const [reading, setReading] = useState(false);
  const [details, setDetails] = useState(false);
  const [graphsOpen, setGraphsOpen] = useState(false);
  const [stage, setStage] = useState<ViewName | null>(null);
  const [away, setAway] = useState(false);
  const binding = questionForTask(conversation?.turns ?? [], viewedTaskId);
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  useEffect(() => {
    discardMemoryCache();
    setNotices(readNotices(conversation?.id, viewedTaskId).items);
  }, [conversation?.id, viewedTaskId]);
  const transcript = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const jumpTo = useRef<string | null>(null);
  const last = conversation?.turns.at(-1);
  const contentKey = `${last?.id ?? ""}:${last?.answer ?? ""}:${last?.taskStatus ?? ""}:${notices.length}`;
  const showRail = Boolean(conversation);
  const projectName = projectLabel(project);

  useEffect(() => {
    const view = transcript.current;
    const key = conversation ? "gy-chat-scroll." + conversation.id : "";
    const saved = key ? sessionStorage.getItem(key) : null;
    if (saved !== null && view) {
      sessionStorage.removeItem(key);
      follow.current = false;
      view.scrollTop = Number(saved);
      return;
    }
    if (view && follow.current) {
      view.scrollTop = view.scrollHeight;
      setAway(false);
    } else if (!follow.current) setAway(true);
  }, [contentKey, conversation?.id]);

  function submit() {
    if (reading || storing) return;
    if (draft.trim() === "/model" && !files.length) {
      if (!catalog) return;
      onDraft(""); setModelOpen(true);
    } else if (selected && !pending) onSend();
  }
  function openRecord(href: string) {
    const top = transcript.current?.scrollTop ?? 0;
    if (conversation) sessionStorage.setItem("gy-chat-scroll." + conversation.id, String(top));
    location.hash = href;
  }
  function closeStage() {
    setStage(null);
    setGraphsOpen(false);
    document.querySelector<HTMLTextAreaElement>(".gy-composer textarea")?.focus();
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
      {pending && <Button size="small" type="tertiary" onClick={onCancel}>停止等待本轮回复</Button>}
      {modelError && !catalog ? <span role="status">模型暂不可用</span> :
        <ChatModelPicker catalog={catalog} selected={selected} open={modelOpen} onOpen={setModelOpen}
          onSelect={onSelectModel} />}
      <Button className="gy-send" theme="solid" htmlType="submit" loading={Boolean(pending)}
        disabled={archiveBusy || Boolean(pending) || reading || storing || (!draft.trim() && !files.length) || !selected}
        aria-label="提交任务" title="提交任务" icon={<IconArrowUp />} />
      </div>
    </div>
  </form>;
  const rail = showRail ? <TaskGraphRail taskId={viewedTaskId} mode={viewMode} choices={taskChoices}
    tasks={taskArchives} archiveBusy={archiveBusy} onArchive={onTaskArchive} onPin={onPin} onFollow={onFollow} onStage={setStage} /> : null;
  return <section className="gy-chat-page">
    <header className="gy-work-header">
      <div className="gy-work-path">{conversation
          ? <><IconFolder aria-hidden="true" /><span className="gy-path-project" title={projectName}>{projectName}</span><i>/</i></>
          : <IconCommentStroked aria-hidden="true" />}
        <h1 title={conversation?.title}>{conversation?.title ?? "新会话"}</h1></div>
      {narrow && showRail && <Button theme="borderless" type="tertiary" aria-label="任务图谱" onClick={() => setGraphsOpen(true)}>任务图谱</Button>}
      <Button theme="borderless" type="tertiary" icon={<IconList />} aria-label="会话详情"
        title="会话详情" aria-haspopup="dialog" onClick={() => setDetails(true)}><span>会话详情</span></Button>
    </header>
    <div className="gy-chat-body">
      <div className="gy-chat-center">
        {conversation ? <>
          <div className="gy-chat-stream">
            <div className="gy-transcript" ref={transcript} onScroll={e => {
              if (!e.nativeEvent.isTrusted) return;
              const el = e.currentTarget;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
              follow.current = near;
              if (near) setAway(false);
            }}>
              <div className="gy-transcript-inner">
                <PlanCard key={viewedTaskId} taskId={viewedTaskId} turnId={binding?.turnId ?? null} question={binding?.question ?? null} conversationId={conversation.id}
                  onNotices={setNotices} onOpen={openRecord} />
                {notices.map(item => <p key={item.id} className="gy-notice" role="status">{item.text}</p>)}
                {conversation.turns.map(t => <article key={t.id} className="gy-turn" id={"turn-" + t.id} tabIndex={-1}>
                  <div className="gy-question" aria-label="你"><ChatMarkdown text={t.question} />
                    {Boolean(t.attachments?.length) && <div className="gy-sent-files">{t.attachments!.map(f =>
                      <span key={f.id}><IconFile aria-hidden="true" />{f.name}</span>)}</div>}
                  </div>
                  {t.review && <ReviewRecord review={t.review} />}
                  {t.submissionKey && <AssignmentCard turn={t} submitting={pending === t.id} onTask={onTask} onRetry={archived ? undefined : onRetry} />}
                  {(!t.submissionKey || t.answer) && <div className="gy-answer"><div className="gy-answer-brand"><BrandMark />{t.submissionKey ? "任务结果" : "GongYuAI"}
                    <time dateTime={new Date(t.created).toISOString()}>{clock.format(t.created)}</time></div>
                    {t.answer && <div className="gy-answer-text"><ChatMarkdown text={t.answer} /></div>}
                    {!t.submissionKey && pending === t.id && !t.answer && <span role="status" className="gy-response-state">正在回复…</span>}
                    {!t.submissionKey && pending !== t.id && (t.error || !t.answer) && <div className="gy-response-state" role="status">
                      <span>{t.error === t.review?.reason && t.error ? decisions[t.review!.decision] : t.error || "上次回复已中断。"}</span>
                      {last?.id === t.id && !pending && !archived && <Button size="small" type="tertiary" theme="borderless" icon={<IconRefresh />}
                        onClick={() => onRetry(t)}>重试</Button>}
                    </div>}
                  </div>}
                </article>)}
              </div>
            </div>
            {away && <Button className="gy-catch-up" onClick={() => {
              follow.current = true;
              const view = transcript.current;
              if (view) view.scrollTop = view.scrollHeight;
              setAway(false);
            }}>有新进展</Button>}
            {narrow && graphsOpen && !stage && <div className="gy-graph-drawer" role="dialog" aria-label="任务图谱">
              <header><Button size="small" onClick={() => { setGraphsOpen(false); document.querySelector<HTMLTextAreaElement>(".gy-composer textarea")?.focus(); }}>返回输入</Button></header>
              {rail}
            </div>}
            {stage && <div className="gy-inline-stage" role="dialog" aria-label={viewTitle[stage]}>
              <header><Button size="small" onClick={closeStage}>返回输入</Button><strong>{viewTitle[stage]}</strong></header>
              {viewedTaskId ? <GraphDetail taskId={viewedTaskId} view={stage} onOpenRecord={openRecord} /> : <p role="status">等待任务回执</p>}
            </div>}
          </div>
          <div className="gy-composer-dock">{archived ? <div className="gy-archive-notice">
            <span role="status">此会话已归档</span>
            <Button size="small" disabled={archiveBusy} onClick={() => onArchive(false)}>取消归档会话</Button>
          </div> : composer}</div>
        </> : <div className="gy-session-start"><div className="gy-welcome-inner">
          <span id="gy-project-switch-label" hidden>切换项目</span>
          <Select className="gy-workspace-context" dropdownClassName="gy-workspace-options" size="small" borderless motion={false}
            aria-labelledby="gy-project-switch-label" prefix={<IconFolder size="small" aria-hidden="true" />}
            value={project} disabled={archiveBusy || storing || Boolean(pending)} maxHeight={250}
            dropdownMatchSelectWidth={false} onChange={value => { if (typeof value === "string") onMove(value); }}>
            {projects.map(name => <Select.Option key={name} value={name} showTick={false}>{projectLabel(name)}</Select.Option>)}
            {archived && <Select.Option value={project} disabled showTick={false}>{projectName}（已归档）</Select.Option>}
          </Select>
          <h2>今天要处理什么任务？</h2>
          {archived ? <p role="status">此项目已归档，请切换项目后开始会话。</p> : composer}
        </div></div>}
      </div>
      {!narrow && rail}
    </div>
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
        <dt>所属项目</dt><dd>{archived ? projectName : <select aria-label="所属项目" disabled={archiveBusy || storing || Boolean(pending)} value={project} onChange={e => onMove(e.target.value)}>
          {projects.map(name => <option key={name} value={name}>{projectLabel(name)}</option>)}
        </select>}</dd>
        <dt>关联任务</dt><dd>{archived ? taskArchives.get(taskLink?.id ?? "")?.name ?? taskLink?.id ?? "未手动关联" :
          details && <ChatTaskSelect value={taskLink?.id ?? ""} onChange={onLink} disabled={archiveBusy} />}</dd>
        <dt>当前模型</dt><dd>{selected?.modelId ?? "未选择"}</dd>
        <dt>思考强度</dt><dd>{effortLabels[selected?.effort ?? "default"]}</dd>
        <dt>会话状态</dt><dd>{archived ? "已归档" : last ? stateOf(last, pending) : "尚未开始"}</dd>
        {conversation?.turns[0] && <><dt>开始时间</dt><dd>{stamp.format(conversation.turns[0].created)}</dd></>}
      </dl>
      {conversation && <Button className="gy-session-archive" size="small" disabled={archiveBusy} onClick={() => onArchive(!archived)}>
        {archived ? "取消归档会话" : "归档会话"}
      </Button>}
      {conversation && <section className="gy-session-turns"><h3>会话记录 <span>{conversation.turns.length}</span></h3>
        {conversation.turns.map((t, i) => <button type="button" key={t.id} onClick={() => { jumpTo.current = t.id; setDetails(false); }}>
          <b>{t.question}</b><small>第 {i + 1} 轮 · {stateOf(t, pending)}{t.selection && " · " + (t.replyModel ?? t.selection.modelId) + " · " + effortLabels[t.replyModel && t.replyModel !== t.selection.modelId ? "default" : t.selection.effort ?? "default"]}</small>
        </button>)}
      </section>}
    </SideSheet>
  </section>;
}
