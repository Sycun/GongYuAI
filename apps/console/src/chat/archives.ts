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
