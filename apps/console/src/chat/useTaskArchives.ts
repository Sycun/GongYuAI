import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskArchiveState } from "@gongyuai/contracts";
import { api } from "../api";

export function useTaskArchives(enabled: boolean) {
  const [records, setRecords] = useState<Map<string, TaskArchiveState> | null>(null);
  const version = useRef(0);
  const refresh = useCallback(async () => {
    const reading = ++version.current;
    const { json } = await api.taskArchives();
    const next = new Map(json.tasks.map(task => [task.id, task]));
    if (version.current === reading) setRecords(next);
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const poll = () => { if (!document.hidden) void refresh().catch(() => {}); };
    poll();
    const timer = window.setInterval(poll, 4000);
    document.addEventListener("visibilitychange", poll);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
  }, [enabled, refresh]);

  async function change(taskIds: string[], archived: boolean) {
    const { json } = await api.setTaskArchives(taskIds, archived);
    ++version.current;
    setRecords(previous => {
      const next = new Map(previous);
      for (const task of json.tasks) next.set(task.id, task);
      return next;
    });
  }

  return { records, refresh, change };
}
