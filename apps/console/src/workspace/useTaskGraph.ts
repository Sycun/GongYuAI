import { useEffect, useSyncExternalStore } from "react";
import { loadGraph } from "./loadGraphs";
import type { GraphState, ViewName } from "./model";

const cache = new Map<string, GraphState>();
const listeners = new Set<() => void>();
const loading: GraphState = { kind: "loading" };
const waiting: GraphState = { kind: "waiting" };

function keyOf(taskId: string, view: ViewName) {
  return `${taskId}:${view}`;
}

function publish(taskId: string, view: ViewName, state: GraphState) {
  cache.set(keyOf(taskId, view), state);
  for (const listener of listeners) listener();
}

export function discardMemoryCache() {
  for (const key of [...cache.keys()]) {
    if (key.endsWith(":memory")) cache.delete(key);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(taskId: string | null, view: ViewName): GraphState {
  if (!taskId) return waiting;
  const cached = cache.get(keyOf(taskId, view));
  if (view === "memory" && cached && (cached.kind === "ready" || cached.kind === "empty")) {
    return { kind: "unavailable", message: "已丢弃此前缓存的记忆图。页面只展示服务端这次的访问决定。" };
  }
  return cached ?? loading;
}

export function useTaskGraph(taskId: string | null, view: ViewName, enabled: boolean, intervalMs = 0): GraphState {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot(taskId, view),
    () => snapshot(taskId, view),
  );
  useEffect(() => {
    if (!enabled || !taskId) return;
    const requested = taskId;
    const controller = new AbortController();
    let timer = 0;
    const pull = async () => {
      const next = await loadGraph(requested, view, controller.signal);
      if (controller.signal.aborted || next.kind === "loading") return;
      publish(requested, view, next);
      if (intervalMs > 0 && !controller.signal.aborted) timer = window.setTimeout(() => void pull(), intervalMs);
    };
    void pull();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [taskId, view, enabled, intervalMs]);
  return state;
}
