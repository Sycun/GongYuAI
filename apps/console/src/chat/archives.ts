import type { TaskArchiveState } from "@gongyuai/contracts";
import { defaultProject } from "./projects";
import type { Conversation } from "./useConversations";

export type ArchiveScope = { kind: "project" | "chat" | "task"; id: string };

export function archiveKey(kind: "chat" | "project", id: string) {
  return `${kind}/${id}`;
}

export function taskIdForChat(id: string) {
  return /^task-([a-f0-9-]{36})$/.exec(id)?.[1];
}

export function taskChatId(taskId: string) {
  return `task-${taskId}`;
}

function taskTimestamp(task?: TaskArchiveState): number {
  const ts = Date.parse(task?.createdAt ?? task?.updatedAt ?? "");
  return Number.isFinite(ts) ? ts : 0;
}

export function mergeWorkspaceConversations({
  conversations,
  linkedChats,
  linkedTaskOf,
  tasks,
  submissions,
  activeChatId,
}: {
  conversations: Conversation[];
  linkedChats: Iterable<string>;
  linkedTaskOf: (id: string) => string | undefined;
  tasks: Map<string, TaskArchiveState>;
  submissions: Map<string, string>;
  activeChatId?: string | null;
}): Conversation[] {
  const knownChats = new Set(conversations.map(c => c.id));
  const coveredTasks = new Set<string>();
  const merged: Conversation[] = [...conversations];

  for (const chat of conversations) {
    for (const taskId of conversationTaskIds(chat, linkedTaskOf(chat.id), submissions)) {
      coveredTasks.add(taskId);
    }
  }

  const extraChatIds = new Set<string>(linkedChats);
  if (activeChatId && taskIdForChat(activeChatId)) extraChatIds.add(activeChatId);

  for (const id of extraChatIds) {
    if (knownChats.has(id)) continue;
    knownChats.add(id);
    const taskId = linkedTaskOf(id);
    if (taskId) coveredTasks.add(taskId);
    const task = taskId ? tasks.get(taskId) : undefined;
    merged.push({
      id,
      title: task?.name?.trim() || "关联任务",
      updated: taskTimestamp(task),
      turns: [],
    });
  }

  for (const task of [...tasks.values()].reverse()) {
    if (coveredTasks.has(task.id)) continue;
    const id = taskChatId(task.id);
    if (knownChats.has(id)) continue;
    knownChats.add(id);
    coveredTasks.add(task.id);
    merged.push({
      id,
      title: task.name.trim() || `任务 ${task.id.slice(0, 8)}`,
      updated: taskTimestamp(task),
      turns: [],
    });
  }

  return merged.sort((a, b) => b.updated - a.updated);
}

export function submissionTasks(tasks: Iterable<TaskArchiveState>) {
  const result = new Map<string, string>();
  for (const task of tasks) {
    if (task.submissionKey) result.set(task.submissionKey, task.id);
  }
  return result;
}

export function conversationTaskIds(chat: Conversation, linkedId: string | undefined, submissions: Map<string, string>) {
  const ids = new Set<string>();
  if (linkedId) ids.add(linkedId);
  for (const turn of chat.turns) {
    const id = turn.taskId || (turn.submissionKey ? submissions.get(turn.submissionKey) : undefined);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function workspaceArchives({ projects, conversations, projectOf, linkedTaskOf, tasks, localArchives, isSubmitting }: {
  projects: string[];
  conversations: Conversation[];
  projectOf: (id: string) => string;
  linkedTaskOf: (id: string) => string | undefined;
  tasks: Map<string, TaskArchiveState>;
  localArchives: Set<string>;
  isSubmitting: (id: string) => boolean;
}) {
  const submissions = submissionTasks(tasks.values());
  const archivedChats = new Set<string>();
  const chatsByProject = new Map(projects.map(name => [name, [] as Conversation[]]));
  for (const chat of conversations) {
    chatsByProject.get(projectOf(chat.id))?.push(chat);
    if (isSubmitting(chat.id)) continue;
    const taskIds = conversationTaskIds(chat, linkedTaskOf(chat.id), submissions);
    if (taskIds.length ? taskIds.every(id => Boolean(tasks.get(id)?.archivedAt)) : localArchives.has(archiveKey("chat", chat.id))) {
      archivedChats.add(chat.id);
    }
  }
  const archivedProjects = new Set<string>();
  for (const [project, chats] of chatsByProject) {
    if (project === defaultProject) continue;
    if (chats.length ? chats.every(chat => archivedChats.has(chat.id)) : localArchives.has(archiveKey("project", project))) {
      archivedProjects.add(project);
    }
  }
  return { archivedChats, archivedProjects, chatsByProject, submissions };
}
