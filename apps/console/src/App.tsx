import { chatThinkingEfforts, selectableChatModels } from "@gongyuai/contracts/chat-model-options";
import type { ChatCatalog, ChatSelection } from "@gongyuai/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button, SideSheet, Toast } from "@douyinfe/semi-ui";
import { IconChevronLeft, IconChevronRight } from "@douyinfe/semi-icons";
import { api, type Overview, type TaskRecord } from "./api";
import { DETAIL_TABS, ROUTE_META, SETTINGS_SECTIONS, isSettingsRoute, settingsSectionOf, type DetailTab, type SettingsRoute } from "./labels";
import { newId } from "./chat/id";
import { storeFiles, type DraftFile } from "./chat/attachments";
import { useConversations } from "./chat/useConversations";
import { useChatProjects } from "./chat/useChatProjects";
import { ChatSidebar } from "./components/ChatSidebar";
import { ChatPage } from "./pages/ChatPage";

const OverviewPage = lazy(() => import("./pages/OverviewPage").then(m => ({ default: m.OverviewPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then(m => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import("./pages/TaskDetailPage").then(m => ({ default: m.TaskDetailPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));

type Route = "chat" | "overview" | "tasks" | SettingsRoute | DetailTab;
type Location = { route: Route; id: string | null };
const workPages = [{ key: "overview", label: "总览" }, { key: "tasks", label: "任务" }] as const;
const groups = [
  { title: "工作区", items: workPages },
  { title: "任务详情", items: DETAIL_TABS },
  { title: "系统设置", items: SETTINGS_SECTIONS },
];
function isDetail(value: string): value is DetailTab { return DETAIL_TABS.some(t => t.key === value); }

function parseHash(): Location {
  const [part, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (part === "settings" || part === "settings-tools") return { route: "settings-model", id: null };
  if (part === "dive") return { route: "live", id: id || null };
  if (part === "tasks" || part === "overview" || part === "chat" || isDetail(part)) {
    return { route: part, id: id || null };
  }
  const section = SETTINGS_SECTIONS.find(item => item.key === part);
  return { route: section?.key ?? "chat", id: section?.key === "settings-model" ? id || null : null };
}

export function App() {
  const [page, setPage] = useState(parseHash);
  const [panel, setPanel] = useState<"features" | "history" | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 760px)").matches);
  const { conversations, send, pendingTurn, applyTask } = useConversations();
  const workspace = useChatProjects();
  const [homeId, setHomeId] = useState(newId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileDrafts, setFileDrafts] = useState<Record<string, DraftFile[]>>({});
  const preparing = useRef(new Set<string>());
  const [storing, setStoring] = useState<Record<string, boolean>>({});
  const lastChat = useRef<string | null>(page.route === "chat" ? page.id : null);
  const lastTask = useRef<string | null>(null);
  const [catalog, setCatalog] = useState<ChatCatalog | null>(null);
  const [modelError, setModelError] = useState(false);
  const [choices, setChoices] = useState<Record<string, ChatSelection>>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const { route, id } = page;
  const chat = route === "chat";
  const detailId = (isDetail(route) ? id : null) ?? lastTask.current ?? tasks.at(-1)?.id;
  const conversation = conversations.find(c => c.id === id);
  const chatId = (chat ? id : lastChat.current) ?? homeId;
  const project = workspace.projectOf(chatId);
  const taskSessionId = /^task-([a-f0-9-]{36})$/.exec(chatId)?.[1];
  const taskLink = workspace.taskOf(chatId) ?? (taskSessionId ? { id: taskSessionId, turnId: undefined } : undefined);
  const draft = drafts[chatId] ?? "";
  const preferred = choices[chatId] ?? conversation?.turns.at(-1)?.selection;
  const profile = catalog?.profiles.find(p => p.id === preferred?.profileId &&
    selectableChatModels(p).includes(preferred.modelId));
  const fallback = catalog?.profiles.find(p => p.id === catalog.defaultId);
  const selected = profile && preferred ? {
    ...preferred,
    effort: chatThinkingEfforts(profile.protocol, preferred.modelId).find(level => level === preferred.effort),
  } : fallback ? { profileId: fallback.id, modelId: fallback.modelId } : undefined;

  useEffect(() => {
    let active = true;
    api.chatModels().then(r => { if (active) { setCatalog(r.json); setModelError(false); } })
      .catch(() => { if (active) setModelError(true); });
    return () => { active = false; };
  }, [route]);

  useEffect(() => {
    function hashChange() { setPage(parseHash()); setPanel(null); }
    const media = matchMedia("(max-width: 760px)");
    function resize() { setNarrow(media.matches); setPanel(p => p === "history" ? null : p); }
    window.addEventListener("hashchange", hashChange);
    media.addEventListener("change", resize);
    return () => {
      window.removeEventListener("hashchange", hashChange);
      media.removeEventListener("change", resize);
    };
  }, []);
  useEffect(() => {
    if (chat) lastChat.current = id;
    else if ((isDetail(route) || route === "tasks") && id) lastTask.current = id;
  }, [chat, route, id]);

  useEffect(() => {
    const background = shell.current;
    if (!panel || !background) return;
    const trigger = document.activeElement;
    background.inert = true;
    return () => {
      background.inert = false;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [panel]);

  function navigate(next: Route, nextId: string | null = null) {
    setPanel(null);
    location.hash = "#/" + next + (nextId ? "/" + nextId : "");
    setPage({ route: next, id: nextId });
  }

  const refresh = useCallback(async () => {
    try {
      const [t, o] = await Promise.all([api.tasks(), api.overview()]);
      setTasks(t.json.tasks ?? []);
      setOverview(o.json);
      setOnline(true);
    } catch { setOnline(false); }
  }, []);
  useEffect(() => {
    if (chat) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [chat, refresh]);

  function newChat(name: string) {
    const next = newId();
    workspace.moveChat(next, name);
    if (workspace.folded(name)) workspace.setFolded(name, false);
    navigate("chat", next);
  }
  function addressChat() {
    if (!id) { navigate("chat", chatId); setHomeId(newId()); }
  }
  const files = fileDrafts[chatId] ?? [];
  async function submit() {
    if (!selected || (!draft.trim() && !files.length) || pendingTurn(chatId) || preparing.current.has(chatId)) return;
    const originalHash = location.hash;
    preparing.current.add(chatId); setStoring(old => ({ ...old, [chatId]: true }));
    try {
      await storeFiles(files);
      void send(chatId, draft.trim() || "请查看附件。", selected, undefined, files.map(({ id, name }) => ({ id, name })));
      setDrafts(old => old[chatId] === draft ? { ...old, [chatId]: "" } : old);
      setFileDrafts(old => ({ ...old, [chatId]: (old[chatId] ?? []).filter(f => !files.some(sent => sent.id === f.id)) }));
      if (location.hash === originalHash) addressChat();
    } catch (e) { Toast.error(e instanceof Error ? e.message : "附件保存失败。"); }
    finally { preparing.current.delete(chatId); setStoring(old => ({ ...old, [chatId]: false })); }
  }
  const sidebarProps = {
    conversations, selected: chat ? id : null, blank: chat && !conversation, onNew: newChat,
    projects: workspace.projects, currentProject: project, projectOf: workspace.projectOf,
    folded: workspace.folded, onFold: workspace.setFolded,
    onCreate: (name: string) => { workspace.addProject(name); newChat(name); },
    onSelect: (next: string) => navigate("chat", next),
    onFeatures: () => setPanel("features"),
  };
  const meta = ROUTE_META[route];
  const openTask = (nextId: string) => navigate("live", nextId);
  return <div ref={shell} className="gy-shell">
    <ChatSidebar {...sidebarProps} collapsed={narrow || collapsed}
      onToggle={() => narrow ? setPanel("history") : setCollapsed(!collapsed)} />
    <SideSheet title={panel === "history" ? undefined : "设置与功能"} visible={panel !== null}
      className={panel === "history" ? "gy-history-sheet" : "gy-feature-sheet"} placement="left"
      aria-label={panel === "history" ? "会话列表" : "设置与功能"}
      afterVisibleChange={visible => { if (visible) document.querySelector<HTMLElement>(".gy-feature-list button, .gy-history-sheet .gy-toggle")?.focus(); }}
      closable={panel !== "history"} closeOnEsc width={panel === "history" ? "min(282px, 88vw)" : "min(360px, 94vw)"}
      bodyStyle={{ padding: 0 }} onCancel={() => setPanel(null)}>
      {panel === "history" ? <ChatSidebar {...sidebarProps} onToggle={() => setPanel(null)} /> :
        <nav className="gy-feature-list" aria-label="全部功能">
          {groups.map(group => <section key={group.title}><h2>{group.title}</h2>
            <div>{group.items.map(item => <button type="button" key={item.key}
              aria-current={route === item.key ? "page" : undefined}
              onClick={() => navigate(item.key, isDetail(item.key) ? detailId ?? null : null)}>
              {item.label}<IconChevronRight size="small" aria-hidden="true" />
            </button>)}</div>
          </section>)}
        </nav>}
    </SideSheet>
    <main className="gy-main">
      {chat ? <ChatPage key={chatId} conversation={conversation} pending={pendingTurn(chatId)} draft={draft}
        onDraft={value => setDrafts(old => ({ ...old, [chatId]: value }))} onSend={submit}
        catalog={catalog} selected={selected} modelError={modelError}
        projects={workspace.projects} project={project} taskLink={taskLink}
        onMove={name => {
          workspace.moveChat(chatId, name);
          if (workspace.folded(name)) workspace.setFolded(name, false);
          addressChat();
        }}
        onLink={next => {
          workspace.linkTask(chatId, next ? { id: next, turnId: conversation?.turns.at(-1)?.id } : undefined);
          addressChat();
        }}
        onSelectModel={s => setChoices(old => ({ ...old, [chatId]: s }))}
        files={files} storing={Boolean(storing[chatId])}
        onFiles={added => setFileDrafts(old => ({ ...old, [chatId]: [...(old[chatId] ?? []), ...added] }))}
        onRemoveFile={id => setFileDrafts(old => ({ ...old, [chatId]: (old[chatId] ?? []).filter(f => f.id !== id) }))}
        onApprovalSettings={() => navigate("settings-approval")}
        onTask={applyTask} onRetry={t => selected && void send(chatId, t.question, selected, t)} /> : <>
        <header className="gy-shell-header">
          <Button theme="borderless" type="tertiary" icon={<IconChevronLeft />} aria-label="返回会话" title="返回会话"
            onClick={() => navigate("chat", lastChat.current)} />
          <h1>{meta.title}</h1>
          <span className="gy-connection">{online === null ? "连接中…" : online ? "在线" : "离线"}</span>
        </header>
        <div className="gy-shell-content"><Suspense fallback={<span role="status">正在打开…</span>}>
          {route === "overview" && <OverviewPage overview={overview} onSelect={openTask} />}
          {route === "tasks" && <TasksPage tasks={tasks} onSelect={openTask} onRefresh={refresh}
            onCreated={task => { openTask(task); void refresh(); }} />}
          {isSettingsRoute(route) && <SettingsPage section={settingsSectionOf(route)} catalog={catalog} onCatalog={setCatalog} profileId={id} />}
          {isDetail(route) && <TaskDetailPage key={detailId} task={tasks.find(t => t.id === detailId) ?? null}
            tab={route} onTabChange={next => navigate(next, detailId ?? null)} onRefresh={refresh} />}
        </Suspense></div>
      </>}
    </main>
  </div>;
}
