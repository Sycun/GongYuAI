import { useState } from "react";
import { Button, Dropdown, Input } from "@douyinfe/semi-ui";
import { IconArchive, IconChevronDown, IconChevronRight, IconChevronUp, IconFolder, IconCommentStroked, IconPlus, IconSearchStroked, IconSettingStroked, IconSidebar, IconUndo } from "@douyinfe/semi-icons";
import type { ArchiveScope } from "../chat/archives";
import type { Conversation } from "../chat/useConversations";

export function BrandMark() {
  return <span className="gy-brand-mark" aria-hidden="true"><i /><b /></span>;
}

type Props = {
  conversations: Conversation[]; selected: string | null; collapsed?: boolean; blank: boolean;
  projects: string[]; currentProject: string; projectOf: (id: string) => string;
  archivedChats: Set<string>; archivedProjects: Set<string>; showArchived: boolean;
  archiveBusy: boolean; onArchive: (scope: ArchiveScope, archived: boolean) => void;
  onShowArchived: (show: boolean) => void;
  folded: (name: string) => boolean; onFold: (name: string, folded: boolean) => void;
  onCreate: (name: string) => void; onNew: (project: string) => void;
  onToggle: () => void; onSelect: (id: string) => void; onFeatures: () => void;
  attention?: Record<string, boolean>;
};

export function ChatSidebar({ conversations, selected, collapsed, blank, projects, currentProject, projectOf,
  archivedChats, archivedProjects, showArchived, archiveBusy, onArchive, onShowArchived,
  folded, onFold, onCreate, onNew, onToggle, onSelect, onFeatures, attention }: Props) {
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const filter = query.trim().toLocaleLowerCase();
  const existingName = projects.includes(name.trim());
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
    const matches = project.toLocaleLowerCase().includes(filter);
    return { project, items: matches ? items : items.filter(c => c.title.toLocaleLowerCase().includes(filter)), matches,
      archived: archivedProjects.has(project) };
  }).filter(group => (group.matches && group.archived === showArchived) || group.items.length);

  function startChat(project: string) {
    setQuery("");
    onNew(project);
  }

  const activeProjects = projects.filter(project => !archivedProjects.has(project));
  const canChooseProject = activeProjects.length > 1;
  const newChatButton = <Button className="gy-new-chat" icon={<IconPlus />} aria-label="新建会话"
    disabled={archiveBusy || !activeProjects.length}
    title={!activeProjects.length ? "请先新建项目或取消项目归档" : canChooseProject ? "选择项目后新建会话" : "新建会话"}
    onClick={canChooseProject ? undefined : () => startChat(activeProjects[0] ?? currentProject)}>
    {!collapsed && <>
      新建会话{canChooseProject && <IconChevronDown className="gy-new-chat-caret" size="small" aria-hidden="true" />}
    </>}
  </Button>;

  return <aside aria-label="会话侧栏" className={'gy-chat-sidebar' + (collapsed ? " gy-collapsed" : "")}>
    <div className="gy-sidebar-top">
      <div className="gy-brand"><BrandMark /><span>GongYu<span className="gy-brand-ai">AI</span></span></div>
      <Button className="gy-toggle" theme="borderless" type="tertiary" icon={<IconSidebar />}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle} />
    </div>
    {canChooseProject && !archiveBusy ? <Dropdown trigger="click" position="bottomLeft" role="presentation" clickToHide motion={false}
      render={<Dropdown.Menu className="gy-new-chat-projects" aria-label="选择项目">
        {activeProjects.map(project => <Dropdown.Item key={project} icon={<IconFolder aria-hidden="true" />}
          onClick={() => startChat(project)}><span title={project}>{project}</span></Dropdown.Item>)}
      </Dropdown.Menu>}>
      {newChatButton}
    </Dropdown> : newChatButton}
    {!collapsed && <section className="gy-history" aria-label="工作区会话">
      <div className="gy-history-heading"><span>{showArchived ? "已归档" : "项目"}</span><div>
        <Button theme="borderless" type="tertiary" size="small" icon={<IconPlus />}
          disabled={archiveBusy} aria-label="新建项目" title="新建项目" aria-expanded={creating}
          onClick={() => { setCreating(!creating); setName(""); }} />
        <Button theme="borderless" type="tertiary" size="small" icon={<IconSearchStroked />}
          aria-label="搜索会话" title="搜索项目或会话" aria-expanded={search} onClick={() => { setSearch(!search); setQuery(""); }} />
        <Button theme={showArchived ? "light" : "borderless"} type={showArchived ? "primary" : "tertiary"}
          size="small" icon={<IconArchive />} aria-label="查看已归档" aria-pressed={showArchived}
          title={showArchived ? "返回项目" : "查看已归档"}
          onClick={() => { onShowArchived(!showArchived); setQuery(""); setCreating(false); }} />
      </div></div>
      {creating && <form className="gy-create-project" onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || existingName || archiveBusy) return;
        onCreate(name.trim()); setCreating(false); setQuery(""); setName("");
      }}>
        <Input autoFocus maxLength={80} aria-label="项目名称" placeholder="项目名称" value={name} onChange={setName}
          onKeyDown={event => { if (event.key === "Escape") setCreating(false); }} />
        <Button htmlType="submit" size="small" disabled={!name.trim() || existingName || archiveBusy}>创建</Button>
        {existingName && <small role="status">已有同名项目</small>}
      </form>}
      {search && <Input className="gy-history-search" autoFocus showClear aria-label="搜索项目或会话"
        placeholder="搜索项目或会话" value={query} onChange={setQuery} />}
      <div className="gy-history-list">
        {visible.length === 0 && <p className="gy-history-empty">{filter ? "没有匹配的项目或会话" : showArchived ? "暂无归档" : "暂无活跃项目"}</p>}
        {visible.map(({ project, items, archived }) => {
          const expanded = !!filter || !folded(project);
          const currentBlank = !showArchived && !archived && blank && currentProject === project && !filter;
          return <section key={project} className="gy-project-group">
            <div className="gy-project-heading">
              <button type="button" className="gy-project-row" aria-expanded={expanded} title={project}
                aria-label={project} disabled={!!filter} onClick={() => onFold(project, expanded)}>
                {expanded ? <IconChevronDown size="small" /> : <IconChevronRight size="small" />}
                <IconFolder /><span>{project}</span>
              </button>
              {!showArchived && <Button className="gy-project-new" theme="borderless" type="tertiary" size="small" icon={<IconPlus />} disabled={archiveBusy}
                aria-label={`在「${project}」中新建会话`} title={`在「${project}」中新建会话`}
                onClick={() => startChat(project)} />}
              {archived === showArchived && <Button className="gy-sidebar-archive" theme="borderless" type="tertiary" size="small"
                disabled={archiveBusy} icon={archived ? <IconUndo /> : <IconArchive />}
                aria-label={`${archived ? "取消归档项目" : "归档项目"}「${project}」`}
                title={archived ? "取消项目及其会话、任务的归档" : "归档项目及其会话、任务"}
                onClick={() => onArchive({ kind: "project", id: project }, !archived)} />}
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
