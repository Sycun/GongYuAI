import { useState } from "react";
import { Button, Input } from "@douyinfe/semi-ui";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconFolder, IconCommentStroked, IconPlus, IconSearchStroked, IconSettingStroked, IconSidebar } from "@douyinfe/semi-icons";
import type { Conversation } from "../chat/useConversations";

export function BrandMark() {
  return <span className="gy-brand-mark" aria-hidden="true"><i /><b /></span>;
}

type Props = {
  conversations: Conversation[]; selected: string | null; collapsed?: boolean; blank: boolean;
  projects: string[]; currentProject: string; projectOf: (id: string) => string;
  folded: (name: string) => boolean; onFold: (name: string, folded: boolean) => void;
  onCreate: (name: string) => void; onNew: (project: string) => void;
  onToggle: () => void; onSelect: (id: string) => void; onFeatures: () => void;
  attention?: Record<string, boolean>;
};

export function ChatSidebar({ conversations, selected, collapsed, blank, projects, currentProject, projectOf,
  folded, onFold, onCreate, onNew, onToggle, onSelect, onFeatures, attention }: Props) {
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const filter = query.trim().toLocaleLowerCase();
  const existingName = projects.includes(name.trim());
  const grouped = new Map<string, Conversation[]>();
  for (const chat of conversations) {
    const project = projectOf(chat.id);
    const items = grouped.get(project) ?? [];
    items.push(chat);
    grouped.set(project, items);
  }
  const visible = projects.map(project => {
    const items = grouped.get(project) ?? [];
    const matches = project.toLocaleLowerCase().includes(filter);
    return { project, items: matches ? items : items.filter(c => c.title.toLocaleLowerCase().includes(filter)), matches };
  }).filter(group => group.matches || group.items.length);
  return <aside aria-label="会话侧栏" className={'gy-chat-sidebar' + (collapsed ? " gy-collapsed" : "")}>
    <div className="gy-sidebar-top">
      <div className="gy-brand"><BrandMark /><span>GongYu<span className="gy-brand-ai">AI</span></span></div>
      <Button className="gy-toggle" theme="borderless" type="tertiary" icon={<IconSidebar />}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggle} />
    </div>
    <Button className="gy-new-chat" icon={<IconPlus />} onClick={() => { setQuery(""); onNew(currentProject); }} aria-label="新建会话" title="新建会话">
      {collapsed ? null : "新建会话"}
    </Button>
    {!collapsed && <section className="gy-history" aria-label="工作区会话">
      <div className="gy-history-heading"><span>项目</span><div>
        <Button theme="borderless" type="tertiary" size="small" icon={<IconPlus />}
          aria-label="新建项目" title="新建项目" aria-expanded={creating}
          onClick={() => { setCreating(!creating); setName(""); }} />
        <Button theme="borderless" type="tertiary" size="small" icon={<IconSearchStroked />}
          aria-label="搜索会话" title="搜索项目或会话" aria-expanded={search} onClick={() => { setSearch(!search); setQuery(""); }} />
      </div></div>
      {creating && <form className="gy-create-project" onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || existingName) return;
        onCreate(name.trim()); setCreating(false); setQuery(""); setName("");
      }}>
        <Input autoFocus maxLength={80} aria-label="项目名称" placeholder="项目名称" value={name} onChange={setName}
          onKeyDown={event => { if (event.key === "Escape") setCreating(false); }} />
        <Button htmlType="submit" size="small" disabled={!name.trim() || existingName}>创建</Button>
        {existingName && <small role="status">已有同名项目</small>}
      </form>}
      {search && <Input className="gy-history-search" autoFocus showClear aria-label="搜索项目或会话"
        placeholder="搜索项目或会话" value={query} onChange={setQuery} />}
      <div className="gy-history-list">
        {visible.length === 0 && <p className="gy-history-empty">没有匹配的项目或会话</p>}
        {visible.map(({ project, items }) => {
          const expanded = !!filter || !folded(project);
          const currentBlank = blank && currentProject === project && !filter;
          return <section key={project} className="gy-project-group">
            <div className="gy-project-heading">
              <button type="button" className="gy-project-row" aria-expanded={expanded} title={project}
                aria-label={project} disabled={!!filter} onClick={() => onFold(project, expanded)}>
                {expanded ? <IconChevronDown size="small" /> : <IconChevronRight size="small" />}
                <IconFolder /><span>{project}</span>
              </button>
            </div>
            {expanded && <div className="gy-session-tree">
              {currentBlank && <div className="gy-current-blank" aria-current="page"><IconCommentStroked />新会话</div>}
              {!currentBlank && !items.length && <p className="gy-history-empty">尚无会话</p>}
              {items.map(c => <button type="button" key={c.id} className="gy-history-item" title={c.title}
                aria-current={selected === c.id ? "page" : undefined} onClick={() => onSelect(c.id)}>
                <IconCommentStroked aria-hidden="true" /><span className="gy-history-title">{c.title}</span>
                <i className={attention?.[c.id] ? "gy-unread" : "gy-unread is-quiet"} aria-label={attention?.[c.id] ? "有新进展" : undefined} />
              </button>)}
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
