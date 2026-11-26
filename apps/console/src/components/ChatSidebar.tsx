import { useEffect, useState } from "react";
import { Button, Input } from "@douyinfe/semi-ui";
import {
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCommentStroked,
  IconFolder,
  IconPlus,
  IconSearchStroked,
  IconSettingStroked,
  IconSidebar,
  IconUndo,
} from "@douyinfe/semi-icons";
import type { ArchiveScope } from "../chat/archives";
import { defaultProject } from "../chat/projects";
import type { Conversation } from "../chat/useConversations";

export function BrandMark() {
  return <span className="gy-brand-mark" aria-hidden="true"><i /><b /></span>;
}

function WorkbenchTargetIcon() {
  return (
    <svg className="semi-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1V3.2M8 12.8V15M1 8H3.2M12.8 8H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function OverviewPulseIcon() {
  return (
    <svg className="semi-icon" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 8.5H4.2L6.1 4.2L8.4 12L10.5 6.8L11.8 8.5H14.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Props = {
  conversations: Conversation[]; selected: string | null; collapsed?: boolean; blank: boolean;
  projects: string[]; currentProject: string; projectOf: (id: string) => string; projectLabel: (id: string) => string;
  archivedChats: Set<string>; archivedProjects: Set<string>; showArchived: boolean;
  archiveBusy: boolean; onArchive: (scope: ArchiveScope, archived: boolean) => void;
  onShowArchived: (show: boolean) => void;
  folded: (name: string) => boolean; onFold: (name: string, folded: boolean) => void;
  onCreateProject: () => void; onNew: (project: string) => void;
  onToggle: () => void; onSelect: (id: string) => void; onFeatures: () => void;
  attention?: Record<string, boolean>;
  activeRoute?: string;
  isTaskDetailRoute?: boolean;
  activeTaskCount?: number;
  onNavigateWorkbench?: (route: "tasks" | "overview") => void;
};

export function ChatSidebar({
  conversations, selected, collapsed, blank, projects, currentProject, projectOf, projectLabel,
  archivedChats, archivedProjects, showArchived, archiveBusy, onArchive, onShowArchived,
  folded, onFold, onCreateProject, onNew, onToggle, onSelect, onFeatures, attention,
  activeRoute, isTaskDetailRoute, activeTaskCount = 0, onNavigateWorkbench,
}: Props) {
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const filter = query.trim().toLocaleLowerCase();
  useEffect(() => setQuery(""), [showArchived]);
  const grouped = new Map<string, Conversation[]>();
  for (const chat of conversations) {
    if (archivedChats.has(chat.id) !== showArchived) continue;
    const project = projectOf(chat.id);
    const items = grouped.get(project) ?? [];
    items.push(chat);
    grouped.set(project, items);
  }
  const visible = projects.map(project => {
    const items = grouped.get(project) ?? [];
    const label = projectLabel(project);
    const matches = label.toLocaleLowerCase().includes(filter)
      || (project === defaultProject && project.toLocaleLowerCase().includes(filter));
    return { project, label, items: matches ? items : items.filter(c => c.title.toLocaleLowerCase().includes(filter)), matches,
      archived: archivedProjects.has(project) };
  }).filter(group => (group.matches && group.archived === showArchived) || group.items.length);

  function startChat(project: string) {
    setQuery("");
    onNew(project);
  }

  const tasksActive = activeRoute === "tasks" || Boolean(isTaskDetailRoute);
  const overviewActive = activeRoute === "overview";

  return <aside aria-label="会话侧栏" className={"gy-chat-sidebar" + (collapsed ? " gy-collapsed" : "")}>
    <div className="gy-sidebar-top">
      <div className="gy-brand"><BrandMark /><span>GongYu<span className="gy-brand-ai">AI</span></span></div>
      <Button className="gy-toggle" theme="borderless" type="tertiary" icon={<IconSidebar />}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle} />
    </div>
    <Button className="gy-new-chat" icon={<IconPlus aria-hidden="true" />} aria-label="新建会话"
      disabled={archiveBusy} title="在默认对话区新建会话" onClick={() => startChat(defaultProject)}>
      {!collapsed && "新建会话"}
    </Button>
    {onNavigateWorkbench && (
      <nav className="gy-workbench-nav" aria-label="作战工作台快捷入口">
        <button
          type="button"
          className="gy-workbench-btn"
          aria-label="任务工作台"
          aria-current={tasksActive ? "page" : undefined}
          title={activeTaskCount > 0 ? `任务工作台（${activeTaskCount} 个运行中）` : "任务工作台（意图图谱与实战深潜）"}
          onClick={() => onNavigateWorkbench("tasks")}
        >
          <WorkbenchTargetIcon />
          {!collapsed && <span className="gy-workbench-label">任务工作台</span>}
          {activeTaskCount > 0 && (
            <span className="gy-task-badge" aria-label={`${activeTaskCount} 个运行中任务`}>
              {collapsed ? "" : activeTaskCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className="gy-workbench-btn"
          aria-label="态势总览"
          aria-current={overviewActive ? "page" : undefined}
          title="态势总览（活跃任务与守护恢复）"
          onClick={() => onNavigateWorkbench("overview")}
        >
          <OverviewPulseIcon />
          {!collapsed && <span className="gy-workbench-label">态势总览</span>}
        </button>
      </nav>
    )}
    {!collapsed && <section className="gy-history" aria-label="工作区会话">
      <div className="gy-history-heading"><span>{showArchived ? "已归档" : "项目"}</span><div>
        <Button theme="borderless" type="tertiary" size="small" icon={<IconPlus />}
          disabled={archiveBusy} aria-label="新建项目" title="新建项目" aria-haspopup="dialog"
          onClick={() => { setQuery(""); onCreateProject(); }} />
        <Button theme="borderless" type="tertiary" size="small" icon={<IconSearchStroked />}
          aria-label="搜索会话" title="搜索项目或会话" aria-expanded={search} onClick={() => { setSearch(!search); setQuery(""); }} />
        <Button theme={showArchived ? "light" : "borderless"} type={showArchived ? "primary" : "tertiary"}
          size="small" icon={<IconArchive />} aria-label="查看已归档" aria-pressed={showArchived}
          title={showArchived ? "返回项目" : "查看已归档"}
          onClick={() => onShowArchived(!showArchived)} />
      </div></div>
      {search && <Input className="gy-history-search" autoFocus showClear aria-label="搜索项目或会话"
        placeholder="搜索项目或会话" value={query} onChange={setQuery} />}
      <div className="gy-history-list">
        {visible.length === 0 && <p className="gy-history-empty">{filter ? "没有匹配的项目或会话" : showArchived ? "暂无归档" : "暂无活跃项目"}</p>}
        {visible.map(({ project, label, items, archived }) => {
          const expanded = !!filter || !folded(project);
          const currentBlank = !showArchived && !archived && blank && currentProject === project && !filter;
          return <section key={project} className="gy-project-group">
            <div className="gy-project-heading">
              <button type="button" className="gy-project-row" aria-expanded={expanded} title={label}
                aria-label={label} disabled={!!filter} onClick={() => onFold(project, expanded)}>
                {expanded ? <IconChevronDown size="small" /> : <IconChevronRight size="small" />}
                <IconFolder /><span>{label}</span>
              </button>
              {project !== defaultProject && archived === showArchived && <Button className="gy-sidebar-archive" theme="borderless" type="tertiary" size="small"
                disabled={archiveBusy} icon={archived ? <IconUndo /> : <IconArchive />}
                aria-label={`${archived ? "取消归档项目" : "归档项目"}「${label}」`}
                title={archived ? "取消项目及其会话、任务的归档" : "归档项目及其会话、任务"}
                onClick={() => onArchive({ kind: "project", id: project }, !archived)} />}
              {!showArchived && <Button className="gy-project-new" theme="borderless" type="tertiary" size="small" icon={<IconPlus />} disabled={archiveBusy}
                aria-label={`在「${label}」中新建会话`} title={`在「${label}」中新建会话`}
                onClick={() => startChat(project)} />}
            </div>
            {expanded && <div className="gy-session-tree">
              {currentBlank && <div className="gy-current-blank" aria-current="page"><IconCommentStroked />新会话</div>}
              {!currentBlank && !items.length && <p className="gy-history-empty">尚无会话</p>}
              {items.map(c => <div key={c.id} className="gy-session-row">
                <button type="button" className="gy-history-item" title={c.title}
                  aria-current={selected === c.id ? "page" : undefined} onClick={() => onSelect(c.id)}>
                  <IconCommentStroked aria-hidden="true" /><span className="gy-history-title">{c.title}</span>
                  <i className={attention?.[c.id] ? "gy-unread" : "gy-unread is-quiet"} aria-label={attention?.[c.id] ? "有新进展" : undefined} />
                </button>
                <Button className="gy-sidebar-archive" theme="borderless" type="tertiary" size="small"
                  disabled={archiveBusy} icon={showArchived ? <IconUndo /> : <IconArchive />}
                  aria-label={`${showArchived ? "取消归档会话" : "归档会话"}「${c.title}」`}
                  title={showArchived ? "取消会话及其任务的归档" : "归档会话及其任务"}
                  onClick={() => onArchive({ kind: "chat", id: c.id }, !showArchived)} />
              </div>)}
            </div>}
          </section>;
        })}
      </div>
    </section>}
    <footer className="gy-sidebar-footer"><button type="button" className="gy-features-toggle"
      aria-haspopup="dialog" aria-label="设置与功能" title="设置与功能" onClick={onFeatures}>
      <IconSettingStroked />{!collapsed && <><span>设置与功能</span><IconChevronUp /></>}
    </button></footer>
  </aside>;
}
