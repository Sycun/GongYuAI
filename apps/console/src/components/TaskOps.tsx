import { useEffect, useState } from "react";
import { Button, Card, Tag, TextArea } from "@douyinfe/semi-ui";
import { probe, type Probe } from "../api";
import { consultLabel, jobOutcomeLabel, lateResultLabel } from "../workspace/model";
import { probeMessage } from "../workspace/useProbe";

type Receipt = {
  deliveryKey: string;
  status: string;
  deliveredBy: string;
  at: string;
  note?: string;
};
type Job = {
  id: string;
  label?: string;
  status?: string;
  kind?: string;
  lateResult?: boolean;
  error?: string | null;
  receiptKey?: string;
  inputs?: Array<{ path?: string; sha256?: string | null }>;
  artifacts?: Array<{ path?: string; sha256?: string }>;
  receipts?: Receipt[];
};
type Consult = {
  id: string;
  question: string;
  status?: string;
  blocking?: boolean;
  releasedAt?: string | null;
  options?: string[];
  answer?: string | null;
  answeredBy?: string | null;
  relatedJobId?: string | null;
};

export function TaskOps({ taskId, focus }: { taskId: string; focus?: Record<string, string> }) {
  const [jobs, setJobs] = useState<Probe<{ jobs?: Job[] }> | null>(null);
  const [consults, setConsults] = useState<Probe<{ consults?: Consult[] }> | null>(null);
  const [handoff, setHandoff] = useState<Probe<Record<string, unknown>> | null>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState(focus?.consult ?? "");
  const [draft, setDraft] = useState("");
  const [savedAnswer, setSavedAnswer] = useState<Consult | null>(null);
  const [receipts, setReceipts] = useState<Record<string, Receipt[]>>({});

  useEffect(() => {
    if (focus?.consult) setPicked(focus.consult);
  }, [focus?.consult]);

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const pull = async () => {
      const [jobState, consultState] = await Promise.all([
        probe<{ jobs?: Job[] }>(`/tasks/${encodeURIComponent(taskId)}/jobs?receipts=1`, controller.signal),
        probe<{ consults?: Consult[] }>(`/tasks/${encodeURIComponent(taskId)}/consults`, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setJobs(jobState);
      setConsults(consultState);
      if (jobState.ok) {
        const next: Record<string, Receipt[]> = {};
        for (const job of jobState.json.jobs ?? []) next[job.id] = job.receipts ?? [];
        setReceipts((prev) => ({ ...next, ...prev, ...next }));
      }
      timer = window.setTimeout(() => void pull(), 8000);
    };
    void pull();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [taskId, reload]);

  useEffect(() => {
    const controller = new AbortController();
    setHandoff(null);
    void probe<Record<string, unknown>>(`/tasks/${encodeURIComponent(taskId)}/handoff`, controller.signal).then((result) => {
      if (!controller.signal.aborted) setHandoff(result);
    });
    return () => controller.abort();
  }, [taskId, reload]);

  useEffect(() => {
    const id = focus?.consult || (focus?.section === "consults" ? "consults" : "");
    if (!id) return;
    document.getElementById(id === "consults" ? "consults" : `consult-${id}`)?.scrollIntoView({ block: "center" });
  }, [focus?.consult, focus?.section, consults]);

  async function readReceipts(jobId: string) {
    const result = await probe<{ job?: Job; receipts?: Receipt[] }>(`/tasks/${encodeURIComponent(taskId)}/jobs/${encodeURIComponent(jobId)}`);
    if (!result.ok) return result;
    setReceipts((prev) => ({ ...prev, [jobId]: result.json.receipts ?? [] }));
    return result;
  }

  async function run(jobId: string, action: "retry" | "cancel" | "read") {
    const key = `${jobId}:${action}`;
    setBusy(key);
    setNote("");
    if (action === "read") {
      const result = await readReceipts(jobId);
      setBusy("");
      if (!result) return;
      if (result.kind === "unregistered") setNote("当前控制面没有这项作业操作。");
      else if (!result.ok) setNote(result.error || "请求失败");
      else setNote(`已回读作业 ${jobId} 的回执 ${result.json.receipts?.length ?? 0} 条。`);
      return;
    }
    const path = `/tasks/${encodeURIComponent(taskId)}/jobs/${encodeURIComponent(jobId)}/${action}`;
    const result = await probe(path, undefined, { method: "POST" });
    setBusy("");
    if (result.kind === "unregistered") setNote("当前控制面没有这项作业操作。");
    else if (!result.ok) setNote(result.error || "请求失败");
    else setReload((value) => value + 1);
  }

  async function confirmReceipt(job: Job) {
    if (!job.receiptKey) {
      setNote("这条作业没有服务端投递键，不能确认回执。");
      return;
    }
    const path = `/tasks/${encodeURIComponent(taskId)}/jobs/${encodeURIComponent(job.id)}/receipt`;
    setBusy(`${job.id}:ack`);
    setNote(`实际请求：POST ${path}`);
    const result = await probe<{ receipt?: Receipt }>(path, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deliveryKey: job.receiptKey,
        deliveredBy: "operator",
        note: "控制台确认这条作业回执",
      }),
    });
    setBusy("");
    if (!result.ok) {
      setNote(result.error || "确认回执失败");
      return;
    }
    const again = await readReceipts(job.id);
    const saved = again && again.ok ? again.json.receipts ?? [] : [];
    setNote(`已回读 ${saved.length} 条回执。服务端记录的投递键：${saved.map((item) => item.deliveryKey).join("、") || result.json.receipt?.deliveryKey || "未返回"}`);
  }

  async function submitAnswer() {
    const item = (consults?.ok ? consults.json.consults ?? [] : []).find((row) => row.id === picked);
    if (!item) {
      setNote("请先选中原问题。");
      return;
    }
    if (!draft.trim()) {
      setNote("请输入答复。");
      return;
    }
    const path = `/tasks/${encodeURIComponent(taskId)}/consults/${encodeURIComponent(item.id)}/answer`;
    setBusy("answer");
    setNote(`实际请求：POST ${path}`);
    const result = await probe<{ consult?: Consult }>(path, undefined, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: draft.trim(), answeredBy: "operator", injectHint: true }),
    });
    setBusy("");
    if (!result.ok) {
      setNote(result.error || "提交答复失败");
      return;
    }
    const again = await probe<{ consults?: Consult[] }>(`/tasks/${encodeURIComponent(taskId)}/consults`);
    setConsults(again);
    const fresh = again.ok ? (again.json.consults ?? []).find((row) => row.id === item.id) ?? null : null;
    setSavedAnswer(fresh);
    setNote(fresh
      ? `已回读。状态：${consultLabel(fresh)}。服务端保存的答复：${fresh.answer || "未返回"}`
      : "提交已返回，但回读没有找到这条问题。");
  }

  const jobRows = jobs?.ok ? jobs.json.jobs ?? [] : [];
  const consultRows = consults?.ok ? consults.json.consults ?? [] : [];
  const highlighted = focus?.consult;
  const selected = consultRows.find((item) => item.id === picked) ?? null;

  return (
    <div className="gy-ops">
      {highlighted && <p role="status">正在查看待答问题 {highlighted}。下面是这条任务里读到的求助，而不是只打开任务首页。</p>}
      {focus?.section === "consults" && !highlighted && <p role="status">今日工作只给出了待答数量。请在下面选中原问题，再输入答复并提交。</p>}
      <Card title="作业" style={{ background: "var(--semi-color-bg-1)", marginBottom: 12 }}>
        {!jobs?.ok && <p role="status">{probeMessage(jobs, "")}</p>}
        {jobs?.ok && !jobRows.length && <p role="status">已有任务，暂无作业。</p>}
        {jobRows.map((job) => {
          const rows = receipts[job.id] ?? job.receipts ?? [];
          return (
            <article key={job.id} id={`job-${job.id}`} className={focus?.job === job.id ? "gy-focus-row" : ""}>
              <header>
                <b>{job.label || job.id}</b>
                <Tag>{jobOutcomeLabel(job.status)}</Tag>
                {lateResultLabel(job.lateResult) && <Tag color="orange">{lateResultLabel(job.lateResult)}</Tag>}
              </header>
              <p>{job.kind || "类型未记录"}{job.error ? ` · ${job.error}` : ""}</p>
              {!!job.inputs?.length && <p>输入：{job.inputs.map((item) => item.path).filter(Boolean).join("、")}</p>}
              {!!job.artifacts?.length && <p>产物：{job.artifacts.map((item) => item.path).filter(Boolean).join("、")}</p>}
              {job.status === "unknown" && <p>状态未知。可以核对回执，或按接口手动重试。</p>}
              <div>
                <span className="gy-op-target">操作对象：作业 {job.id}
                  <Button size="small" loading={busy === `${job.id}:read`} onClick={() => void run(job.id, "read")}>{busy === `${job.id}:read` ? "正在请求" : "核对回执"}</Button>
                </span>
                <span className="gy-op-target">操作对象：作业 {job.id}
                  <Button size="small" loading={busy === `${job.id}:ack`} disabled={!job.receiptKey} onClick={() => void confirmReceipt(job)}>{busy === `${job.id}:ack` ? "正在请求" : "确认回执"}</Button>
                </span>
                {(job.status === "unknown" || job.status === "failed") && (
                  <Button size="small" loading={busy === `${job.id}:retry`} onClick={() => void run(job.id, "retry")}>{busy === `${job.id}:retry` ? "正在请求" : "手动重试"}</Button>
                )}
                {jobs?.ok && job.status !== "succeeded" && job.status !== "canceled" && (
                  <Button size="small" type="danger" loading={busy === `${job.id}:cancel`} onClick={() => void run(job.id, "cancel")}>{busy === `${job.id}:cancel` ? "正在请求" : `中断作业 ${job.label || job.id.slice(0, 8)}`}</Button>
                )}
              </div>
              {rows.length === 0 ? <p role="status">回执：回读后还没有记录。</p> : rows.map((receipt) => (
                <p key={receipt.deliveryKey}>回执 {receipt.deliveryKey} · 状态 {receipt.status} · {receipt.deliveredBy} · {receipt.at}{receipt.note ? ` · ${receipt.note}` : ""}</p>
              ))}
            </article>
          );
        })}
        {jobs?.kind === "unregistered" && <p>当前控制面只提供任务级暂停、停止、继续和开始，这里不显示中断单个作业。</p>}
        {note && <p role="status">{note}</p>}
      </Card>
      <Card title="待答问题" style={{ background: "var(--semi-color-bg-1)", marginBottom: 12 }}>
        <div id="consults">
        {!consults?.ok && <p role="status">{probeMessage(consults, "")}</p>}
        {consults?.ok && !consultRows.length && <p role="status">没有待答或已记录的求助。</p>}
        {consultRows.map((item) => (
          <article key={item.id} id={`consult-${item.id}`} className={highlighted === item.id || picked === item.id ? "gy-focus-row" : ""}>
            <header>
              <label>
                <input type="radio" name={`consult-${taskId}`} checked={picked === item.id} onChange={() => { setPicked(item.id); setSavedAnswer(null); }} />
                {" "}{consultLabel(item)}
              </label>
              {item.releasedAt && <Tag color="orange">阻塞已解除，仍待答</Tag>}
            </header>
            <p>原问题：{item.question}</p>
            {!!item.options?.length && <p>选项：{item.options.join("、")}</p>}
            {item.answer && <p>服务端保存的答复：{item.answer}{item.answeredBy ? ` · ${item.answeredBy}` : ""} · 状态 {consultLabel(item)}</p>}
          </article>
        ))}
        {selected && (
          <form onSubmit={(event) => { event.preventDefault(); void submitAnswer(); }}>
            <p>正在答复：{selected.question}</p>
            <TextArea aria-label="答复" value={draft} onChange={setDraft} autosize={{ minRows: 3, maxRows: 8 }} />
            <Button htmlType="submit" loading={busy === "answer"} style={{ marginTop: 8 }}>提交答复</Button>
          </form>
        )}
        {savedAnswer && <p role="status">回读结果：状态 {consultLabel(savedAnswer)}。服务端保存的答复：{savedAnswer.answer || "未返回"}</p>}
        </div>
      </Card>
      <Card title="交接包" style={{ background: "var(--semi-color-bg-1)" }}>
        <p>按当前时间读取。页面不传未来时间，也不把交接包挂到四图的刷新上。</p>
        <Button size="small" onClick={() => setReload((value) => value + 1)}>按当前时间重新读取</Button>
        {!handoff?.ok && <p role="status">{probeMessage(handoff, "")}</p>}
        {handoff?.ok && <pre className="gy-mono">{JSON.stringify(handoff.json, null, 2)}</pre>}
      </Card>
    </div>
  );
}
