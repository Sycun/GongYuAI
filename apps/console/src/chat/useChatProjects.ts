import { useEffect, useState } from "react";
import { Toast } from "@douyinfe/semi-ui";
import { defaultProject } from "./projects";

const prefix = "gongyuai.chat.workspace.v1.";
export type TaskLink = { id: string; turnId?: string };

function readWorkspace() {
  const values = new Map<string, string>();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) values.set(key.slice(prefix.length), localStorage.getItem(key) ?? "");
    }
  } catch { /* Storage may be disabled. */ }
  return values;
}

export function useChatProjects() {
  const [values, setValues] = useState(readWorkspace);
  useEffect(() => {
    function sync(e: StorageEvent) {
      if (e.storageArea === localStorage && (e.key === null || e.key.startsWith(prefix))) {
        setValues(readWorkspace());
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function save(key: string, value: string) {
    setValues(previous => new Map(previous).set(key, value));
    try { localStorage.setItem(prefix + key, value); }
    catch { Toast.warning("浏览器无法保存本次设置，刷新后可能丢失。"); }
  }

  const projects = [defaultProject, ...[...values.keys()].filter(k => k.startsWith("project/"))
    .map(k => k.slice("project/".length)).filter(name => name && name !== defaultProject)
    .sort((a, b) => a.localeCompare(b, "zh-CN"))];
  function taskOf(chatId: string): TaskLink | undefined {
    try {
      const link = JSON.parse(values.get("task/" + chatId) || "null");
      if (typeof link?.id === "string" && link.id && (link.turnId === undefined || typeof link.turnId === "string")) return link;
    } catch { /* Ignore an unreadable link without affecting chat history. */ }
  }
  function archivedEntries(raw?: string) {
    try {
      const decoded: unknown = JSON.parse(raw ?? "[]");
      if (Array.isArray(decoded)) return new Set(decoded.filter((key): key is string => typeof key === "string"));
    } catch { /* Ignore malformed archive preferences. */ }
    return new Set<string>();
  }
  const linkedChats = [...values.keys()].filter(key => key.startsWith("task/"))
    .map(key => key.slice("task/".length)).filter(id => taskOf(id));
  return {
    projects, linkedChats, taskOf,
    archives: archivedEntries(values.get("archives")),
    setArchives: (keys: string[], archived: boolean) => {
      let saved = values.get("archives");
      try { saved = localStorage.getItem(prefix + "archives") ?? saved; } catch { /* Keep in-memory state. */ }
      const entries = archivedEntries(saved);
      for (const key of keys) {
        if (archived) entries.add(key);
        else entries.delete(key);
      }
      save("archives", JSON.stringify([...entries]));
    },
    projectOf: (chatId: string) => values.get("belongs/" + chatId) || defaultProject,
    folded: (name: string) => values.get("fold/" + name) === "1",
    setFolded: (name: string, folded: boolean) => save("fold/" + name, folded ? "1" : "0"),
    addProject: (name: string) => save("project/" + name, name),
    moveChat: (chatId: string, name: string) => save("belongs/" + chatId, name),
    linkTask: (chatId: string, link?: TaskLink) => save("task/" + chatId, JSON.stringify(link ?? null)),
  };
}
