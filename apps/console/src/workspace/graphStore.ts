import { useSyncExternalStore } from "react";
import type { ViewName } from "./model";

export type Viewport = { x: number; y: number; k: number };
export type GraphSlot = { selectedId: string | null; viewport: Viewport; kinds: string[] | null };

const slots = new Map<string, GraphSlot>();
const listeners = new Set<() => void>();

function keyOf(taskId: string, view: ViewName) {
  return `${taskId}:${view}`;
}

export function graphSlot(taskId: string, view: ViewName): GraphSlot {
  const key = keyOf(taskId, view);
  const existing = slots.get(key);
  if (existing) return existing;
  const created: GraphSlot = { selectedId: null, viewport: { x: 16, y: 16, k: 1 }, kinds: null };
  slots.set(key, created);
  return created;
}

export function setGraphSlot(taskId: string, view: ViewName, patch: Partial<GraphSlot>) {
  const prev = graphSlot(taskId, view);
  const next = { ...prev, ...patch };
  slots.set(keyOf(taskId, view), next);
  for (const listener of listeners) listener();
}

export function subscribeGraph(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGraphSlot(taskId: string, view: ViewName): GraphSlot {
  return useSyncExternalStore(subscribeGraph, () => graphSlot(taskId, view), () => graphSlot(taskId, view));
}

const remembered = "gy-graph-task";

export function rememberGraphTask(taskId: string) {
  try { sessionStorage.setItem(remembered, taskId); } catch { /* 会话存储不可用时仍可在本次选择。 */ }
}

export function rememberedGraphTask(): string | null {
  try { return sessionStorage.getItem(remembered); } catch { return null; }
}
