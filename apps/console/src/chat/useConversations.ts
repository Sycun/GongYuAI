import type { ChatSelection } from "@gongyuai/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toast } from "@douyinfe/semi-ui";
import { newId } from "./id";
import { readFiles, type FileRef } from "./attachments";
import type { ApprovalReceipt, AssignmentView, ChatMessage } from "@gongyuai/contracts/chat-input";
import { submitAssignment } from "./transport";

export type Turn = {
  id: string; conversationId: string; created: number;
  question: string; answer: string; error?: string; selection?: ChatSelection; attachments?: FileRef[]; review?: ApprovalReceipt; replyModel?: string; submissionKey?: string; taskId?: string; taskStatus?: string;
};
export type Conversation = { id: string; title: string; updated: number; turns: Turn[] };

const prefix = "gongyuai.chat.turn.v1.";

function parseTurn(value: string | null): Turn | null {
  try {
    const t = JSON.parse(value ?? "null");
    return t && typeof t.id === "string" && typeof t.conversationId === "string"
      && Number.isFinite(t.created) && Number.isFinite(new Date(t.created).getTime()) && typeof t.question === "string" && typeof t.answer === "string"
      && (t.error === undefined || typeof t.error === "string") ? t : null;
  } catch { return null; }
}

function readTurns(): Record<string, Turn> {
  const turns: Record<string, Turn> = {};
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      const turn = parseTurn(localStorage.getItem(key));
      if (turn && key === prefix + turn.id) turns[turn.id] = turn;
    }
  } catch { /* Browsers with storage disabled can still chat in memory. */ }
  return turns;
}

export function useConversations() {
  const [turns, setTurns] = useState(readTurns);
  const requests = useRef(new Map<string, { turnId: string; controller: AbortController }>());
  const storageWarning = useRef(false);
  useEffect(() => {
    function sync(e: StorageEvent) {
      if (e.storageArea !== localStorage || (e.key !== null && !e.key.startsWith(prefix))) return;
      const saved = readTurns();
      setTurns(previous => {
        for (const { turnId } of requests.current.values()) {
          if (previous[turnId]) saved[turnId] = previous[turnId];
        }
        return saved;
      });
    }
    const pending = requests.current;
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("storage", sync);
      for (const { controller } of pending.values()) controller.abort();
    };
  }, []);

  const conversations = useMemo(() => {
    const grouped = new Map<string, Conversation>();
    for (const t of Object.values(turns).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) {
      const c = grouped.get(t.conversationId) ?? {
        id: t.conversationId, title: t.question.replace(/\s+/g, " ").slice(0, 48), updated: t.created, turns: [],
      };
      c.turns.push(t);
      c.updated = t.created;
      grouped.set(c.id, c);
    }
    return [...grouped.values()].sort((a, b) => b.updated - a.updated);
  }, [turns]);

  function update(turn: Turn, persist: boolean) {
    const snapshot = { ...turn };
    setTurns(previous => ({ ...previous, [turn.id]: snapshot }));
    if (persist) {
      try { localStorage.setItem(prefix + turn.id, JSON.stringify(snapshot)); }
      catch {
        if (!storageWarning.current) Toast.warning("浏览器无法保存对话，刷新后可能丢失。");
        storageWarning.current = true;
      }
    }
  }

  const applyTask = useCallback((turn: Turn, view: AssignmentView) => {
    if (turn.taskId && view.taskId !== turn.taskId) return;
    const reason = view.reason || undefined;
    if (turn.taskId === view.taskId && turn.taskStatus === view.status && turn.answer === (view.result ?? "") && turn.error === reason) return;
    update({ ...turn, taskId: view.taskId, taskStatus: view.status, replyModel: view.model,
      answer: view.result ?? "", error: reason }, true);
  }, []);

  async function send(id: string, question: string, selection: ChatSelection, retry?: Turn, attachments?: FileRef[]) {
    if (!question.trim() || requests.current.has(id)) return;
    const conversation = conversations.find(c => c.id === id);
    const turn: Turn = {
      id: retry?.id ?? newId(), conversationId: id, created: retry?.created ?? Date.now(),
      question: question.trim(), answer: "", selection, attachments: retry?.attachments ?? attachments,
    };
    const controller = new AbortController();
    requests.current.set(id, { turnId: turn.id, controller });
    turn.submissionKey = turn.id;
    update(turn, true);
    try {
      const messages: ChatMessage[] = [];
      for (const t of conversation?.turns ?? []) {
        if (t.id === retry?.id) break;
        if (t.answer && !t.error) messages.push(
          { role: "user", content: t.question, attachments: await readFiles(t.attachments) },
          { role: "assistant", content: t.answer });
      }
      messages.push({ role: "user", content: turn.question, attachments: await readFiles(turn.attachments) });
      const view = await submitAssignment(turn.id, messages, selection, controller.signal);
      turn.taskId = view.taskId; turn.taskStatus = view.status; turn.replyModel = view.model;
      turn.answer = view.result ?? ""; turn.error = view.reason;
    } catch (err) {
      turn.error = controller.signal.aborted ? "已停止回复" :
        err instanceof TypeError ? "无法连接任务服务，请检查连接后重试。" :
        err instanceof Error ? err.message : "任务提交失败，请重试。";
    } finally {
      requests.current.delete(id);
      update(turn, true);
    }
  }
  function cancel(id: string) {
    requests.current.get(id)?.controller.abort();
  }
  return {
    conversations, send, applyTask, cancel,
    pendingTurn: (id: string) => requests.current.get(id)?.turnId,
  };
}
