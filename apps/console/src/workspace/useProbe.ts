import { useEffect, useState } from "react";
import { probe, type Probe } from "../api";

export function useProbe<T>(path: string | null, reload = 0): Probe<T> | null {
  const [state, setState] = useState<Probe<T> | null>(null);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState(null);
    void probe<T>(path, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState(result);
    });
    return () => controller.abort();
  }, [path, reload]);
  return state;
}

export function probeMessage(state: Probe<unknown> | null, empty: string): string | null {
  if (!state) return "正在读取";
  if (state.kind === "unregistered") return "当前控制面未注册这个接口";
  if (state.kind === "forbidden") return "无权查看";
  if (state.kind === "failed" || state.kind === "aborted") return state.kind === "aborted" ? "正在读取" : `读取失败：${state.error}`;
  return empty;
}
