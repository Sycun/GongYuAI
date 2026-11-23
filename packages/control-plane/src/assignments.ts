import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatThinkingEfforts, CreateTaskRequestSchema, isActiveTaskStatus, selectableChatModels,
  type AssignmentView, type ChatSelection, type ChatMessage, type TaskRecord } from "@gongyuai/contracts";
import { localProbes, openHistory, writeEvidenceFile, type CommandTicket } from "@gongyuai/history";
import type { ControlStore } from "./store.js";
import type { SettingsStore } from "./settings.js";
import { taskPaths } from "./paths.js";
import { validMessages } from "./chat-input.js";
import { requestCompletion, needsKey, responseText } from "./chat-provider.js";
import { reviewCommand, outOfScopeReason } from "./command-approval.js";

const execute = promisify(execFile);
const instructions = `你是工作区的任务处理器。完成最新布置的任务，前文和附件作为材料。只有问候或缺少可交付目标时返回 paused 并说明需要补充什么。仅返回一个 JSON：
{"kind":"result","text":"实际完成的文字、材料分析或交付物"}，只可基于提供的材料，不声称已执行外部操作；
{"kind":"local_check","check":"uname -m、uname -s、uname -r 或 date -u 中的一项"}，仅在任务确实需要获取本地系统信息时请求；
{"kind":"paused","reason":"缺少的材料或当前无法执行的具体操作"}。需要其他系统操作或外部目标时返回 paused，不用操作教程代替实际结果。`;
type Input = { requestId: string; messages: ChatMessage[]; selection: ChatSelection };
type AssignmentReply =
  | { kind: "result"; text: string }
  | { kind: "paused"; reason: string }
  | { kind: "local_check"; check: string }
  | { kind: "error"; message: string };

function interpretStructured(value: unknown): AssignmentReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "error", message: "任务模型未返回有效的结构化结果。" };
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "result") {
    if (typeof record.text === "string" && record.text.trim()) return { kind: "result", text: record.text };
    return { kind: "error", message: "任务模型没有提交可核验的结果。" };
  }
  if (record.kind === "paused") {
    if (typeof record.reason === "string") return { kind: "paused", reason: record.reason.slice(0, 1000) };
    return { kind: "error", message: "任务模型没有提交可核验的结果。" };
  }
  if (record.kind === "local_check") {
    const check = typeof record.check === "string" ? record.check.trim() : "";
    const probe = localProbes.find(item => item === check);
    if (probe) return { kind: "local_check", check: probe };
    return { kind: "error", message: "任务模型提交了无效的工具请求。" };
  }
  if (typeof record.kind === "string" || "check" in record || "command" in record || "tool" in record) {
    return { kind: "error", message: "任务模型提交了无效的工具请求。" };
  }
  return { kind: "error", message: "任务模型未返回有效的结构化结果。" };
}

// 完整的结构化对象仍按原语义处理。普通正文只作为文字结果，不能从中提取命令。
function interpretAssignmentReply(text: string): AssignmentReply {
  const trimmed = text.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return { kind: "error", message: "任务模型未返回结果。" };
  const fence = /^```([a-z0-9_-]*)[^\S\r\n]*([\s\S]*?)[^\S\r\n]*```$/i.exec(trimmed);
  if (!fence && !trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("```")) {
    return { kind: "result", text: trimmed };
  }
  if (!fence) {
    if (trimmed.startsWith("```")) return { kind: "error", message: "任务模型返回了截断的结构化对象。" };
    try { return interpretStructured(JSON.parse(trimmed)); }
    catch { return { kind: "error", message: "任务模型返回了截断的结构化对象。" }; }
  }
  const body = fence[2]!.trim();
  if (!body) return { kind: "error", message: "任务模型未返回结果。" };
  const structured = fence[1]!.toLowerCase() === "json" || body.startsWith("{") || body.startsWith("[");
  if (!structured) return { kind: "result", text: body };
  try { return interpretStructured(JSON.parse(body)); }
  catch { return { kind: "error", message: "任务模型返回了截断的结构化对象。" }; }
}

export class AssignmentService {
  private running = new Map<string, AbortController>();
  constructor(private store: ControlStore, private settings: SettingsStore) {}

  recoverInterrupted() {
    for (const task of this.store.activeTasks()) {
      if (!task.assignment) continue;
      const { ownerPid, ownerHost } = task.assignment;
      if (ownerPid && ownerHost === hostname()) {
        try { process.kill(ownerPid, 0); continue; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue; }
      } else if (ownerHost && ownerHost !== hostname()) continue;
      this.interrupt(task, "paused", "服务重启时任务中断，等待继续。");
    }
  }

  async accept(body: unknown) {
    const input = body as Partial<Input> | null;
    if (!input || typeof input.requestId !== "string" || !/^[a-f\d]{32}$/.test(input.requestId) ||
        !validMessages(input.messages) || !input.selection || typeof input.selection.modelId !== "string") throw new Error("任务、附件或模型选择无效。");
    const { requestId, messages, selection } = input;
    const submission: Input = { requestId, messages, selection };
    const inputHash = createHash("sha256").update(JSON.stringify(submission)).digest("hex");
    const previous = this.store.findSubmission(requestId);
    if (previous) {
      if (previous.assignment?.inputHash !== inputHash) throw new Error("提交标识已用于不同的任务。");
      return this.view(previous);
    }
    const profile = this.settings.chatProfiles().find(p => p.id === selection.profileId);
    if (!profile || !selectableChatModels(profile).includes(selection.modelId)) throw new Error("所选任务模型不可用。");
    if (selection.effort !== undefined && !chatThinkingEfforts(profile.protocol, selection.modelId).includes(selection.effort)) throw new Error("模型不支持所选思考强度。");
    const hasImage = messages.some(m => m.attachments?.some(f => f.mediaType !== "text/plain"));
    const model = (hasImage && profile.visionModelId) || selection.modelId;
    const title = messages.at(-1)!.content.trim().replace(/\s+/g, " ").slice(0,100) || "处理附件";
    let task: TaskRecord;
    try { task = this.store.createTask(CreateTaskRequestSchema.parse({
      name: title, auth: { capability: "observe", authorizationNote: "工作区任务，限提交的材料和本地只读检查", targets: ["local:submitted-materials"] },
      goals: [{ id: "deliver", title: "提交任务结果", description: title, evidencePatterns: ["task-result.md"] }],
    }), { requestId, inputHash, model }); }
    catch (err) {
      const other = this.store.findSubmission(requestId);
      if (other?.assignment?.inputHash === inputHash) return this.view(other);
      throw err;
    }
    try {
      writeFileSync(join(task.dataDir, "assignment-input.json"), JSON.stringify(submission), { mode: 0o600 });
      const paths = taskPaths(task.dataDir);
      const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
      try {
        history.seedGoals(task.id, task.goals);
        history.seedAssetsFromAuth(task.id, task.auth);
      } finally {
        history.close();
      }
      this.start(task);
    } catch (err) { this.interrupt(task, "failed", err instanceof Error ? err.message : "无法保存任务材料"); }
    return this.view(this.store.get(task.id)!);
  }

  view(task: TaskRecord): AssignmentView {
    let result: string | undefined;
    if (task.status === "completed") result = readFileSync(join(task.dataDir, "evidence", "task-result.md"), "utf8");
    return { taskId: task.id, status: task.status, model: task.assignment!.model, result,
      reason: task.error ?? undefined, commandReview: task.commandReview };
  }

  private readableResult(task: TaskRecord, result: string) {
    let receipt: AssignmentView;
    try { receipt = this.view({ ...task, status: "completed" }); }
    catch { throw new Error("任务结果已写入，但回执无法读回。"); }
    if (receipt.taskId !== task.id || receipt.status !== "completed" || receipt.result !== result) {
      throw new Error("任务结果已写入，但回执无法读回。");
    }
  }

  interrupt(task: TaskRecord, status: "stopped" | "paused" | "failed", reason: string) {
    this.running.get(task.id)?.abort();
    this.running.delete(task.id);
    task.status = status; task.error = reason;
    if (status === "paused") task.pausedAt = new Date().toISOString();
    else task.finishedAt = new Date().toISOString();
    this.store.save(task);
    return task;
  }

  start(task: TaskRecord) {
    if (!task.assignment || task.status === "completed" || task.status === "running" || this.running.has(task.id)) return task;
    const controller = new AbortController();
    this.running.set(task.id, controller);
    task.status = "running"; task.startedAt ??= new Date().toISOString(); task.pausedAt = null; task.finishedAt = null; task.error = null;
    task.assignment.ownerPid = process.pid; task.assignment.ownerHost = hostname();
    // 任务重新运行：旧的待确认命令只绑定上一次调用，标记过期。
    if (task.commandReview?.decision === "waiting") {
      task.commandReview = { ...task.commandReview, decision: "expired", reason: "任务已重新运行，该次待确认命令已过期。" };
    }
    task.fence++; this.store.save(task);
    void this.run(task, controller).catch(err => {
      if (this.current(task, controller)) this.interrupt(task, "failed", err instanceof Error ? err.message : "任务处理失败");
    }).finally(() => { if (this.running.get(task.id) === controller) this.running.delete(task.id); });
    return task;
  }

  close() {
    for (const id of this.running.keys()) {
      const task = this.store.get(id);
      if (task) this.interrupt(task, "paused", "任务处理器已关闭，等待继续。");
    }
  }

  private current(task: TaskRecord, controller: AbortController) {
    if (controller.signal.aborted || this.running.get(task.id) !== controller) return false;
    const live = this.store.get(task.id);
    return live?.fence === task.fence && live.status === "running";
  }
  private async run(task: TaskRecord, controller: AbortController) {
    const input: Input = JSON.parse(readFileSync(join(task.dataDir, "assignment-input.json"), "utf8"));
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    const profile = this.settings.chatProfiles().find(p => p.id === input.selection.profileId);
    const prompt = input.messages.at(-1)!.content.trim();
    const explicit = /^(?:执行命令|本地命令)\s*[:：]\s*([\s\S]+)$/.exec(prompt);
    let command = explicit?.[1]?.trim() ?? localProbes.find(probe => probe === prompt);
    let result: string | undefined;
    if (!command) {
      if (!profile || needsKey(profile)) throw new Error("任务模型未配置或不可用。");
      const model = task.assignment!.model;
      const effort = model === input.selection.modelId ? input.selection.effort : undefined;
      const legacy = profile.id === "existing" && !this.settings.get().chatProfiles.some(p => p.id === "existing");
      const response = await requestCompletion(profile, { modelId: model, effort }, input.messages, signal,
        { system: instructions, stream: false, base: legacy ? profile.baseUrl.replace(/\/+$/, "") : undefined });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`任务模型返回 HTTP ${response.status}`); }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new Error("任务模型返回了无法读取的响应。"); }
      const text = responseText(profile.protocol, payload);
      if (typeof text !== "string" || !text.trim()) {
        const providerError = Boolean(payload && typeof payload === "object" && "error" in payload && payload.error);
        throw new Error(providerError ? "任务模型返回错误。" : "任务模型未返回结果。");
      }
      const reply = interpretAssignmentReply(text);
      if (!this.current(task, controller)) return;
      if (reply.kind === "error") {
        writeFileSync(join(task.dataDir, "assignment-model-reply.txt"), text.slice(0, 8192), { mode: 0o600 });
        throw new Error(reply.message);
      }
      if (reply.kind === "paused") { this.interrupt(task, "paused", reply.reason); return; }
      if (reply.kind === "local_check") command = reply.check;
      else result = reply.text;
    }
    if (command) {
      const probe = localProbes.find(p => p === command);
      const mode = this.settings.get().chatApproval.confirmation;
      const reviewId = input.requestId + "-" + task.fence;
      const action = { tool: "shell", summary: probe ?? "自定义命令（参数已隐藏）", localProbe: probe,
        digest: createHash("sha256").update(command).digest("hex") };
      const ticket: CommandTicket = { task: task.id, id: reviewId, fence: task.fence, at: Date.now(), action };
      // 先判断「能否执行」：超出任务授权范围或执行器支持范围直接拦截，不调模型、不等待。
      if (!probe) {
        task.commandReview = { id: reviewId, fence: task.fence, tool: "shell", summary: action.summary,
          at: new Date().toISOString(), reason: outOfScopeReason, decision: "block", model: "", mode };
        this.interrupt(task, "paused", outOfScopeReason); return;
      }
      // 再应用「谁来确认」：逐次确认不调审批模型，落待审记录等用户在会话内处理。
      if (mode === "manual") {
        this.interrupt(task, "paused", `等待你确认命令：${probe}`);
        task.commandReview = { id: reviewId, fence: task.fence, tool: "shell", summary: probe,
          at: new Date().toISOString(), reason: `任务请求执行本地检查「${probe}」，等待你确认。`, decision: "waiting", model: "", mode: "manual" };
        this.store.save(task); return;
      }
      const review = await reviewCommand(this.settings, ticket, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      if (!this.current(task, controller)) return;
      if (review.decision !== "allow") {
        task.commandReview = { id: review.id, fence: task.fence, tool: "shell", summary: probe, at: review.at,
          reason: review.reason, decision: review.decision === "unavailable" ? "unavailable" : "block",
          model: review.model, mode: "auto" };
        this.interrupt(task, "paused", review.reason); return;
      }
      const done = await this.runProbe(task, probe, signal);
      if (!this.current(task, controller)) return;
      task.commandReview = { id: review.id, fence: task.fence, tool: "shell", summary: probe,
        at: review.at, reason: `已执行本地检查「${probe}」。`, decision: done.error ? "failed" : "executed",
        model: review.model, mode: "auto", outcome: done.error ?? done.output };
      this.store.save(task);
      if (done.error) throw new Error(`本地检查执行失败：${done.error}`);
      result = done.output!;
    }
    if (!this.current(task, controller)) return;
    if (!result) throw new Error("任务未产生可保存的结果");
    await this.completeWithResult(task, result);
  }

  /** 执行一条白名单本地检查；返回输出或失败原因。 */
  private async runProbe(task: TaskRecord, probe: string, signal: AbortSignal): Promise<{ output?: string; error?: string }> {
    const [bin, arg] = probe.split(" ");
    try {
      const r = await execute(bin === "date" ? "/bin/date" : "/usr/bin/uname", [arg!],
        { signal, timeout: 5000, cwd: task.dataDir, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
      return { output: r.stdout.trim() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 结果落证据、判定目标并完结任务；用户允许后与自动放行共用。 */
  private async completeWithResult(task: TaskRecord, result: string) {
    const paths = taskPaths(task.dataDir);
    const history = openHistory({ dbPath: paths.historyDb, evidenceDir: paths.evidenceDir });
    try {
      history.seedGoals(task.id, task.goals);
      writeEvidenceFile(paths.evidenceDir, "task-result.md", result);
      const checked = history.assertGoal(task.id, "deliver", ["task-result.md"]);
      if (!checked.ok) throw new Error(checked.reason);
      task.goals = history.listGoals(task.id);
    } finally { history.close(); }
    this.readableResult(task, result);
    this.store.finishTask(task, "completed", null);
  }

  /** 会话内「允许本次 / 拒绝本次」：只绑定当前任务这一次调用，重复点击只处理第一次。 */
  async decideCommand(taskId: string, allow: boolean): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const review = task.commandReview;
    if (!review || review.decision !== "waiting" || review.fence !== task.fence) {
      throw new Error("没有等待确认的命令，或该命令已处理、已过期。");
    }
    const probe = localProbes.find(p => p === review.summary);
    if (!probe) {
      review.decision = "block"; review.reason = outOfScopeReason;
      this.interrupt(task, "paused", outOfScopeReason);
      return task;
    }
    if (!allow) {
      review.decision = "rejected"; review.reason = "你拒绝了本次执行，任务保持暂停。";
      this.interrupt(task, "paused", `用户拒绝执行命令：${probe}`);
      return task;
    }
    // 先同步翻转终态再执行：并发或重复点击只会执行一次。
    review.decision = "executed"; review.outcome = "已允许本次执行，正在执行…";
    task.error = null; this.store.save(task);
    const done = await this.runProbe(task, probe, AbortSignal.timeout(5000));
    if (done.error) {
      review.decision = "failed"; review.outcome = done.error; review.reason = done.error;
      this.interrupt(task, "failed", `本地检查执行失败：${done.error}`);
      return task;
    }
    review.outcome = done.output!;
    this.store.save(task);
    await this.completeWithResult(task, done.output!);
    return this.store.get(taskId)!;
  }

  /** 审批模型不可用后的重试入口：就地对同一命令重新送审，通过即执行。 */
  private readonly retrying = new Set<string>();
  async retryCommand(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    const review = task.commandReview;
    if (!review || review.decision !== "unavailable" || review.fence !== task.fence) {
      throw new Error("只有审批模型不可用的命令可以重试。");
    }
    if (this.retrying.has(taskId)) throw new Error("该命令正在重试，请稍候。");
    const probe = localProbes.find(p => p === review.summary);
    if (!probe) throw new Error("该命令不在执行器支持范围内。");
    this.retrying.add(taskId);
    try {
      const ticket: CommandTicket = { task: task.id, id: review.id, fence: task.fence, at: Date.now(),
        action: { tool: "shell", summary: probe, localProbe: probe,
          digest: createHash("sha256").update(probe).digest("hex") } };
      const next = await reviewCommand(this.settings, ticket, AbortSignal.timeout(30_000));
      if (next.decision === "allow") {
        await this.decideFromRetry(task, review, probe);
      } else {
        task.commandReview = { ...review, at: next.at, reason: next.reason, model: next.model,
          decision: next.decision === "unavailable" ? "unavailable" : "block" };
        this.store.save(task);
      }
      return task;
    } finally { this.retrying.delete(taskId); }
  }

  private async decideFromRetry(task: TaskRecord, review: NonNullable<TaskRecord["commandReview"]>, probe: string) {
    review.decision = "executed"; review.outcome = "审批通过，正在执行…";
    task.error = null; this.store.save(task);
    const done = await this.runProbe(task, probe, AbortSignal.timeout(5000));
    if (done.error) {
      review.decision = "failed"; review.outcome = done.error; review.reason = done.error;
      this.interrupt(task, "failed", `本地检查执行失败：${done.error}`);
      return;
    }
    review.outcome = done.output!;
    this.store.save(task);
    await this.completeWithResult(task, done.output!);
  }
}
