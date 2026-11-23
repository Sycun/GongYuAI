import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { chatThinkingEfforts, selectableChatModels } from "@gongyuai/contracts/chat-model-options";
import { Button, Input, Popover } from "@douyinfe/semi-ui";
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconLayers, IconSearch, IconTick } from "@douyinfe/semi-icons";
import type { ChatCatalog, ChatSelection, ThinkingEffort } from "@gongyuai/contracts";

type Props = {
  catalog: ChatCatalog | null;
  selected?: ChatSelection;
  open: boolean;
  onOpen: (open: boolean) => void;
  onSelect: (selection: ChatSelection) => void;
};

export const effortLabels: Record<ThinkingEffort | "default", string> = {
  default: "默认", off: "关闭", minimal: "最低", low: "低", medium: "中",
  high: "高", xhigh: "极高", max: "最高",
};

export function ChatModelPicker({ catalog, selected, open, onOpen, onSelect }: Props) {
  const [pane, setPane] = useState<"root" | "model" | "effort">("root");
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const returnRow = useRef("model");
  const profile = catalog?.profiles.find(p => p.id === selected?.profileId);
  const efforts = profile && selected ? chatThinkingEfforts(profile.protocol, selected.modelId) : [];
  const effort = selected?.effort ?? "default";
  const groups = (catalog?.profiles ?? []).map(p => ({
    id: p.id, name: p.name, models: selectableChatModels(p),
  }));
  const showSearch = groups.reduce((n, group) => n + group.models.length, 0) > 4;
  const filter = search.trim().toLowerCase();
  const visible = groups.map(group => ({ ...group, models: group.models.filter(id =>
    !filter || (group.name + " " + id).toLowerCase().includes(filter)),
  })).filter(group => group.models.length);

  useLayoutEffect(() => {
    if (!open) { setPane("root"); setSearch(""); return; }
    function focusRow() {
      const list = menu.current;
      if (!list) return;
      const input = pane === "model" && matchMedia("(pointer: fine)").matches ? list.querySelector("input") : null;
      const row = pane === "root" ? list.querySelector<HTMLElement>(`[data-pane="${returnRow.current}"]:enabled`)
        : list.querySelector<HTMLElement>('[aria-checked="true"]');
      (input ?? row ?? list.querySelector<HTMLElement>("button:enabled"))?.focus();
    }
    if (menu.current) { focusRow(); return; }
    const frame = requestAnimationFrame(focusRow);
    return () => cancelAnimationFrame(frame);
  }, [open, pane]);

  function close() { onOpen(false); trigger.current?.focus(); }
  function back() { setSearch(""); setPane("root"); }
  function keyboard(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" || (e.key === "Tab" && e.shiftKey) || (e.key === "ArrowLeft" && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault(); e.stopPropagation();
      if (pane === "root") close(); else back();
    }
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.nativeEvent.isComposing) {
      e.preventDefault();
      menu.current?.querySelector<HTMLButtonElement>("button[data-row]")?.click();
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button[data-row]:enabled") ?? []);
      if (!rows.length) return;
      e.preventDefault();
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      rows[index === -1 ? (step === 1 ? 0 : rows.length - 1) : (index + step + rows.length) % rows.length]?.focus();
    }
  }

  const content = <div className="gy-model-menu" ref={menu} onKeyDown={keyboard} aria-label="模型与思考强度">
    {pane === "root" ? <>
      <button type="button" data-row data-pane="model" disabled={!catalog?.profiles.length}
        onClick={() => { returnRow.current = "model"; setPane("model"); }}>
        <b>模型</b><span>{selected?.modelId ?? "选择模型"}</span><IconChevronRight />
      </button>
      <button type="button" data-row data-pane="effort" disabled={!efforts.length}
        onClick={() => { returnRow.current = "effort"; setPane("effort"); }}>
        <b>思考强度</b><span>{effortLabels[effort]}</span>{efforts.length > 0 && <IconChevronRight />}
      </button>

    </> : <>
      <Button className="gy-menu-back" theme="borderless" type="tertiary" icon={<IconChevronLeft />}
        aria-label="返回模型菜单" onClick={back}>{pane === "model" ? "选择模型" : "思考强度"}</Button>
      {pane === "model" && showSearch && <Input size="small" prefix={<IconSearch />} aria-label="搜索模型"
        placeholder="搜索模型或服务商" value={search} onChange={setSearch} />}
      <div role="radiogroup" aria-label={pane === "model" ? "可选模型" : "思考强度"} className="gy-menu-scroll">
        {pane === "model" ? visible.map(group => <div key={group.id}>
          <h3>{group.name}</h3>
          {group.models.map(modelId => <button type="button" data-row role="radio" key={modelId}
            aria-checked={selected?.profileId === group.id && selected.modelId === modelId}
            onClick={() => {
              if (selected?.profileId !== group.id || selected.modelId !== modelId) onSelect({ profileId: group.id, modelId });
              close();
            }}>{modelId}<IconTick aria-hidden="true" /></button>)}
        </div>) : selected && (["default", ...efforts] as const).map(level =>
          <button type="button" data-row role="radio" aria-checked={effort === level} key={level}
            onClick={() => { onSelect({ ...selected, effort: level === "default" ? undefined : level }); close(); }}>
            {effortLabels[level]}<IconTick aria-hidden="true" />
          </button>)}
        {pane === "model" && !visible.length && <p role="status">没有匹配的模型</p>}
      </div>
    </>}
  </div>;
  return <Popover trigger="custom" visible={open} returnFocusOnClose={false} position="topLeft" motion={false} spacing={6}
    className="gy-model-popup" content={content} onClickOutSide={() => onOpen(false)}>
    <button type="button" ref={trigger} className="gy-model-picker" aria-haspopup="dialog" aria-expanded={open}
      aria-label="选择任务模型与思考强度" onClick={() => onOpen(!open)} onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); onOpen(true); }
        if (e.key === "Escape") onOpen(false);
      }}>
      <IconLayers aria-hidden="true" /><span>{selected?.modelId ?? "选择模型"}</span>
      <small>{effortLabels[effort]}</small><IconChevronDown size="small" aria-hidden="true" />
    </button>
  </Popover>;
}
