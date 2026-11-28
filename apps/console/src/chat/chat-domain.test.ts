import assert from "node:assert/strict";
import test from "node:test";
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES, type TaskArchiveState } from "@gongyuai/contracts";
import {
  archiveKey,
  conversationTaskIds,
  mergeWorkspaceConversations,
  submissionTasks,
  taskChatId,
  taskIdForChat,
  workspaceArchives,
} from "./archives";
import { prepareFile } from "./attachments";
import { defaultProject, defaultProjectLabel, isDuplicateProjectName, projectLabel, projectName } from "./projects";
import type { Conversation } from "./useConversations";

test("projects naming and duplicate guards protect the default workspace", () => {
  assert.equal(projectName(defaultProject, "Custom"), defaultProjectLabel);
  assert.equal(projectLabel(defaultProject), defaultProjectLabel);
  assert.equal(projectLabel("p-1", defaultProjectLabel), `${defaultProjectLabel}（自建项目）`);
  assert.equal(projectLabel("p-2", " 内网评估 "), "内网评估");

  const active = [defaultProject, "p-2"];
  const nameOf = (id: string) => (id === "p-2" ? "内网评估" : defaultProjectLabel);
  assert.equal(isDuplicateProjectName("", active, nameOf), false);
  assert.equal(isDuplicateProjectName("GongYuAI", active, nameOf), true);
  assert.equal(isDuplicateProjectName(defaultProjectLabel, active, nameOf), true);
  assert.equal(isDuplicateProjectName("内网评估", active, nameOf), true);
  assert.equal(isDuplicateProjectName("新专项", active, nameOf), false);
});

test("archives merges linked tasks, resolves submission keys, and computes archived chats/projects", () => {
  const uuid1 = "11111111-1111-4111-8111-111111111111";
  const uuid2 = "22222222-2222-4222-8222-222222222222";
  assert.equal(taskIdForChat(taskChatId(uuid1)), uuid1);
  assert.equal(taskIdForChat("chat-plain"), undefined);

  const tasks = new Map<string, TaskArchiveState>([
    [
      uuid1,
      {
        id: uuid1,
        name: "边界扫描",
        status: "completed",
        submissionKey: "sub-1",
        createdAt: "2026-11-28T01:00:00Z",
        updatedAt: "2026-11-28T01:10:00Z",
        archivedAt: "2026-11-28T02:00:00Z",
      },
    ],
    [
      uuid2,
      {
        id: uuid2,
        name: "未关联CLI任务",
        status: "running",
        createdAt: "2026-11-28T03:00:00Z",
        updatedAt: "2026-11-28T03:05:00Z",
        archivedAt: null,
      },
    ],
  ]);

  const submissions = submissionTasks(tasks.values());
  const conv1: Conversation = {
    id: "c-1",
    title: "会话一",
    updated: 100,
    turns: [{ id: "turn-1", submissionKey: "sub-1", user: "scan", files: [] } as never],
  };
  assert.deepEqual(conversationTaskIds(conv1, undefined, submissions), [uuid1]);

  const merged = mergeWorkspaceConversations({
    conversations: [conv1],
    linkedChats: [],
    linkedTaskOf: () => undefined,
    tasks,
    submissions,
  });
  // uuid1 is already covered by conv1 via submissionKey; uuid2 is synthesized as task-<uuid2> and sorted first
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, taskChatId(uuid2));
  assert.equal(merged[1]?.id, "c-1");

  const arch = workspaceArchives({
    projects: [defaultProject, "proj-archived", "proj-empty"],
    conversations: merged,
    projectOf: (id) => (id === "c-1" ? "proj-archived" : defaultProject),
    linkedTaskOf: (id) => taskIdForChat(id),
    tasks,
    localArchives: new Set([archiveKey("project", "proj-empty")]),
    isSubmitting: () => false,
  });
  assert.equal(arch.archivedChats.has("c-1"), true);
  assert.equal(arch.archivedChats.has(taskChatId(uuid2)), false);
  assert.equal(arch.archivedProjects.has("proj-archived"), true);
  assert.equal(arch.archivedProjects.has("proj-empty"), true);
  assert.equal(arch.archivedProjects.has(defaultProject), false);
});

test("prepareFile validates UTF-8 text, base64-encodes images, and rejects unsafe or oversized attachments", async () => {
  const txt = new File(["# 范围说明\ntarget=example.test\n"], "scope.md", { type: "text/markdown" });
  const draftTxt = await prepareFile(txt);
  assert.equal(draftTxt.payload.mediaType, "text/plain");
  assert.match(draftTxt.payload.data, /target=example\.test/);

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = new File([pngBytes], "proof.PNG", { type: "image/png" });
  const draftPng = await prepareFile(png);
  assert.equal(draftPng.payload.mediaType, "image/png");
  assert.deepEqual(Buffer.from(draftPng.payload.data, "base64"), Buffer.from(pngBytes));

  const badExt = new File(["MZ"], "payload.exe");
  await assert.rejects(() => prepareFile(badExt), /请选择 UTF-8 文本或 PNG/);

  const nulText = new File([new Uint8Array([0x61, 0x00, 0x62])], "nul.txt");
  await assert.rejects(() => prepareFile(nulText), /含有二进制内容/);

  const badUtf8 = new File([new Uint8Array([0xff, 0xfe, 0xfd])], "bad.log");
  await assert.rejects(() => prepareFile(badUtf8), /不是 UTF-8 文本/);

  const hugeTxt = new File([new Uint8Array(MAX_TEXT_BYTES + 1).fill(0x61)], "huge.txt");
  await assert.rejects(() => prepareFile(hugeTxt), /限 128 KiB/);

  const hugeImg = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "huge.webp");
  await assert.rejects(() => prepareFile(hugeImg), /限 1 MiB/);
});
