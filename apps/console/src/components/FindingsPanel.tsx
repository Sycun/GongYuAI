import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button, Card, Collapsible, Empty, Input, SideSheet, Space, Spin, Table, Tag, TextArea, Toast, Typography,
} from "@douyinfe/semi-ui";
import { IconCopy, IconDownload, IconRefresh, IconShield } from "@douyinfe/semi-icons";
import type { EngagementAudit, FindingRetest, FindingValidation, TrafficRecord } from "@gongyuai/contracts";
import { api, probe, type FindingRecord, type TaskRecord } from "../api";
import {
  FINDING_SEVERITY_LABEL, FINDING_STATUS_LABEL, FINDING_QUALIFICATION_LABEL,
  effectiveQualification, findingQualificationColor, findingSeverityColor, findingStatusColor, shortId,
} from "../labels";
import { formatDateTime } from "../time";
import { DeliveryScorecard } from "./DeliveryScorecard";
import { ReconcilePanel } from "./ReconcilePanel";
import { ReportMarkdown } from "./ReportMarkdown";
import { RetestsSection } from "./RecordSections";
import { SEVERITY_ORDER } from "./reportFormat";
import { buildRawRequest, buildRawResponse, formatBytes, formatDuration, httpStatusColor } from "./trafficFormat";

const VERDICT_LABEL: Record<string, string> = {
  confirmed: "独立确认", refuted: "已推翻", inconclusive: "无法判定", "out-of-scope": "超出授权",
};
const VERDICT_COLOR: Record<string, "green" | "red" | "grey" | "orange"> = {
  confirmed: "green", refuted: "red", inconclusive: "grey", "out-of-scope": "orange",
};
const METHOD_LABEL: Record<string, string> = {
  "evidence-only": "证据核验", replay: "重放", "control-compare": "对照比较", manual: "人工",
};

type Props = {
  taskId: string;
  findings: FindingRecord[];
  goals: TaskRecord["goals"];
  focusFinding?: string;
  refreshKey?: number;
  onRefresh: () => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function FindingsPanel({ taskId, findings, goals, focusFinding, refreshKey = 0, onRefresh }: Props) {
  const [mode, setMode] = useState<"ledger" | "report">("ledger");
  const [audit, setAudit] = useState<EngagementAudit | null>(null);
  const [validations, setValidations] = useState<FindingValidation[]>([]);
  const [retests, setRetests] = useState<FindingRetest[]>([]);
  const [reportText, setReportText] = useState("");
  const [evidenceFiles, setEvidenceFiles] = useState<Array<{ path: string; size: number; mtime: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(focusFinding ?? null);
  const [busyValidation, setBusyValidation] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [observationsOpen, setObservationsOpen] = useState(false);
  const [looseOpen, setLooseOpen] = useState(false);

  useEffect(() => {
    if (focusFinding) setSelectedId(focusFinding);
  }, [focusFinding]);

  const loadSide = useCallback(async () => {
    const [auditRes, valRes, deliveryRes, evRes, p14Res] = await Promise.allSettled([
      api.getAudit(taskId),
      api.getValidations(taskId),
      api.delivery(taskId),
      api.evidence(taskId),
      api.getTaskP14(taskId),
    ]);
    if (auditRes.status === "fulfilled") setAudit(auditRes.value.json);
    if (valRes.status === "fulfilled") setValidations(valRes.value.json.validations ?? []);
    if (evRes.status === "fulfilled") setEvidenceFiles(evRes.value.json.files ?? []);
    if (p14Res.status === "fulfilled") setRetests(p14Res.value.json.retests ?? []);
    if (deliveryRes.status === "fulfilled") {
      const summary = deliveryRes.value.json.summary ?? "";
      let original = "";
      if (deliveryRes.value.json.hasReport) {
        try { original = (await api.report(taskId)).text; } catch { /* 报告缺失时只展示摘要 */ }
      }
      setReportText(original ? `${summary}\n\n## 留存报告\n\n${original}` : summary);
    }
  }, [taskId]);

  useEffect(() => { void loadSide(); }, [loadSide, refreshKey]);

  const active = useMemo(() => findings.filter((f) => f.status !== "retracted"), [findings]);
  const sorted = useMemo(
    () => [...active].sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0) || b.createdAt.localeCompare(a.createdAt)),
    [active],
  );
  const severityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of active) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return counts;
  }, [active]);

  const independentConfirmed = useCallback(
    (fid: string) => validations.some((v) => v.findingId === fid && v.independent && v.verdict === "confirmed"),
    [validations],
  );
  const coverage = useMemo(() => {
    const confirmed = active.filter((f) => independentConfirmed(f.id)).length;
    return { confirmed, total: active.length, rate: active.length ? confirmed / active.length : null };
  }, [active, independentConfirmed]);

  const observations = audit?.observations ?? [];
  const warnCount = observations.filter((o) => o.severity === "warn").length;
  const hasBusinessGoal = goals.some((g) => g.kind === "business-reconcile" || Boolean(g.business));
  const selected = findings.find((f) => f.id === selectedId) ?? null;

  const runValidation = useCallback(async (fid: string, force = false) => {
    setBusyValidation(fid);
    try {
      const before = new Set(validations.filter((v) => v.findingId === fid).map((v) => v.id));
      const { json } = await api.validateRun(taskId, fid, force);
      let settled = false;
      for (let i = 0; i < 20 && !settled; i++) {
        await sleep(2000);
        const { json: fresh } = await api.getValidations(taskId, fid);
        if ((fresh.validations ?? []).some((v) => !before.has(v.id))) { settled = true; break; }
        const jobRes = await probe<{ job?: { status?: string } }>(
          `/tasks/${encodeURIComponent(taskId)}/jobs/${encodeURIComponent(json.jobId)}`,
        );
        const status = jobRes.ok ? jobRes.json.job?.status : undefined;
        if (status === "succeeded" || status === "failed" || status === "canceled") settled = true;
      }
      const final = await api.getValidations(taskId);
      setValidations(final.json.validations ?? []);
      Toast.success("复核流程已结束，台账已刷新");
      onRefresh();
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : "复核请求失败");
    } finally {
      setBusyValidation(null);
    }
  }, [taskId, validations, onRefresh]);

  const batchValidate = useCallback(async () => {
    const targets = sorted.filter(
      (f) => (f.severity === "high" || f.severity === "critical") && !independentConfirmed(f.id),
    );
    if (!targets.length) { Toast.info("高危/严重漏洞均已有独立确认"); return; }
    setBatchBusy(true);
    try {
      for (const f of targets) await runValidation(f.id, false);
    } finally {
      setBatchBusy(false);
    }
  }, [sorted, independentConfirmed, runValidation]);

  const exportReport = () => {
    const blob = new Blob([reportText], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${shortId(taskId)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reloadEvidence = async () => {
    const ev = await api.evidence(taskId);
    setEvidenceFiles(ev.json.files ?? []);
  };

  return (
    <div className="gy-findings">
      <Card className="gy-findings-overview" style={{ background: "var(--semi-color-bg-1)" }}>
        <div className="gy-findings-overview-top">
          <Space wrap spacing={8}>
            {(["critical", "high", "medium", "low", "info"] as const).map((s) =>
              severityCounts[s] ? (
                <Tag key={s} color={findingSeverityColor(s)} size="small">
                  {FINDING_SEVERITY_LABEL[s]} {severityCounts[s]}
                </Tag>
              ) : null,
            )}
            <Tag color={coverage.rate != null && coverage.rate >= 1 ? "green" : "orange"} size="small">
              独立复核 {coverage.confirmed}/{coverage.total}
              {coverage.rate != null ? `（${Math.round(coverage.rate * 100)}%）` : ""}
            </Tag>
          </Space>
          <Space spacing={8}>
            <Button size="small" theme={mode === "ledger" ? "solid" : "light"} type={mode === "ledger" ? "primary" : "tertiary"} onClick={() => setMode("ledger")}>
              漏洞台账
            </Button>
            <Button size="small" theme={mode === "report" ? "solid" : "light"} type={mode === "report" ? "primary" : "tertiary"} onClick={() => setMode("report")}>
              报告预览
            </Button>
            {mode === "report" && (
              <Button size="small" icon={<IconDownload />} onClick={exportReport} disabled={!reportText.trim()}>导出</Button>
            )}
          </Space>
        </div>
        {observations.length > 0 && (
          <div className="gy-findings-observations">
            <button type="button" className="gy-findings-observations-toggle" onClick={() => setObservationsOpen((v) => !v)} aria-expanded={observationsOpen}>
              <IconShield />
              <span>观察员告警 {observations.length} 条{warnCount ? `（${warnCount} 条需关注）` : ""}</span>
              <span className="gy-findings-observations-chevron">{observationsOpen ? "收起" : "展开"}</span>
            </button>
            <Collapsible isOpen={observationsOpen}>
              <ul className="gy-findings-observations-list">
                {observations.map((o) => (
                  <li key={o.key}>
                    <Tag size="small" color={o.severity === "warn" ? "red" : "blue"}>{o.severity === "warn" ? "关注" : "提示"}</Tag>
                    <span>{o.text}</span>
                  </li>
                ))}
              </ul>
            </Collapsible>
          </div>
        )}
      </Card>

      {mode === "report" ? (
        <div className="gy-findings-report">
          <DeliveryScorecard taskId={taskId} refreshKey={refreshKey} />
          {hasBusinessGoal && <ReconcilePanel taskId={taskId} onDone={onRefresh} />}
          <Card style={{ background: "var(--semi-color-bg-1)" }}>
            {reportText ? <ReportMarkdown text={reportText} /> : <Empty title="暂无报告" description="任务收口后生成交付报告。" />}
          </Card>
        </div>
      ) : (
        <Card
          title={`漏洞台账 · ${active.length} 条`}
          style={{ background: "var(--semi-color-bg-1)" }}
          headerExtraContent={
            <Button size="small" icon={<IconRefresh />} loading={batchBusy} disabled={Boolean(busyValidation)} onClick={() => void batchValidate()}>
              批量复核高危/严重
            </Button>
          }
        >
          {sorted.length === 0 ? (
            <Empty title="暂无漏洞" description="发现线索会进入台账；复现并封存证据后转为已复现。" />
          ) : (
            <Table
              size="small"
              rowKey="id"
              pagination={sorted.length > 20 ? { pageSize: 20 } : false}
              dataSource={sorted}
              onRow={(record) => ({ onClick: () => setSelectedId((record as FindingRecord).id), style: { cursor: "pointer" } })}
              columns={[
                { title: "严重性", dataIndex: "severity", width: 90, render: (s: string) => <Tag color={findingSeverityColor(s)} size="small">{FINDING_SEVERITY_LABEL[s] ?? s}</Tag> },
                { title: "标题", dataIndex: "title", ellipsis: true },
                { title: "资产 / 端点", dataIndex: "asset", width: 260, render: (v: string, r: FindingRecord) => <Typography.Text style={{ fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-all" }}>{v}{r.endpoint ? ` · ${r.endpoint}` : ""}</Typography.Text> },
                { title: "类别", dataIndex: "vulnClass", width: 120 },
                { title: "定级", dataIndex: "qualification", width: 120, render: (_: unknown, r: FindingRecord) => { const q = effectiveQualification(r); return <Tag color={findingQualificationColor(q)} size="small">{FINDING_QUALIFICATION_LABEL[q]}</Tag>; } },
                { title: "状态", dataIndex: "status", width: 100, render: (s: string) => <Tag color={findingStatusColor(s)} size="small">{FINDING_STATUS_LABEL[s] ?? s}</Tag> },
                { title: "复核", dataIndex: "id", width: 80, render: (id: string) => independentConfirmed(id) ? <Tag color="green" size="small">已确认</Tag> : <Tag color="grey" size="small">待复核</Tag> },
                { title: "证据", dataIndex: "evidence", width: 60, render: (e: FindingRecord["evidence"]) => e.length },
              ]}
            />
          )}
        </Card>
      )}

      <Card className="gy-findings-loose" style={{ background: "var(--semi-color-bg-1)" }}>
        <button type="button" className="gy-findings-observations-toggle" onClick={() => setLooseOpen((v) => !v)} aria-expanded={looseOpen}>
          <span>零散证据与材料导入{evidenceFiles.length ? `（${evidenceFiles.length} 份文件）` : ""}</span>
          <span className="gy-findings-observations-chevron">{looseOpen ? "收起" : "展开"}</span>
        </button>
        <Collapsible isOpen={looseOpen}>
          <LooseEvidence taskId={taskId} files={evidenceFiles} findings={findings} onReload={reloadEvidence} onRefresh={onRefresh} />
        </Collapsible>
      </Card>

      <SideSheet
        title={selected ? selected.title : "漏洞详情"}
        visible={Boolean(selected)}
        width={760}
        placement="right"
        onCancel={() => setSelectedId(null)}
        bodyStyle={{ padding: "16px 20px", overflow: "auto" }}
      >
        {selected && (
          <FindingDrawer
            taskId={taskId}
            finding={selected}
            validations={validations.filter((v) => v.findingId === selected.id)}
            retests={retests.filter((r) => r.findingId === selected.id)}
            busy={busyValidation === selected.id || batchBusy}
            onValidate={(force) => void runValidation(selected.id, force)}
          />
        )}
      </SideSheet>
    </div>
  );
}

function FindingDrawer({ taskId, finding, validations, retests, busy, onValidate }: {
  taskId: string;
  finding: FindingRecord;
  validations: FindingValidation[];
  retests: FindingRetest[];
  busy: boolean;
  onValidate: (force: boolean) => void;
}) {
  const [traffic, setTraffic] = useState<TrafficRecord[] | null>(null);
  const [evidenceBodies, setEvidenceBodies] = useState<Record<string, string>>({});
  const q = effectiveQualification(finding);

  useEffect(() => {
    let cancelled = false;
    setTraffic(null);
    setEvidenceBodies({});
    if (finding.trafficIds?.length || finding.id) {
      api.traffic(taskId, { findingId: finding.id, limit: 20 })
        .then(({ json }) => { if (!cancelled) setTraffic(json.traffic ?? []); })
        .catch(() => { if (!cancelled) setTraffic([]); });
    }
    for (const entry of finding.evidence) {
      if (/^(http|oast|tool):/.test(entry.path)) continue;
      api.evidenceFile(taskId, entry.path)
        .then((r) => { if (!cancelled) setEvidenceBodies((prev) => ({ ...prev, [entry.path]: r.text })); })
        .catch((e) => { if (!cancelled) setEvidenceBodies((prev) => ({ ...prev, [entry.path]: `读取失败：${e instanceof Error ? e.message : String(e)}` })); });
    }
    return () => { cancelled = true; };
  }, [taskId, finding.id]);

  const copyPoc = async () => {
    const poc = finding.pocCurl || finding.repro || "";
    if (!poc) { Toast.info("暂无可复制的 PoC"); return; }
    try { await navigator.clipboard.writeText(poc); Toast.success("已复制 PoC"); }
    catch (e) { Toast.error(e instanceof Error ? e.message : "复制失败"); }
  };

  return (
    <div className="gy-finding-drawer">
      <Space wrap spacing={8} style={{ marginBottom: 12 }}>
        <Tag color={findingSeverityColor(finding.severity)}>{FINDING_SEVERITY_LABEL[finding.severity] ?? finding.severity}</Tag>
        <Tag color={findingQualificationColor(q)}>{FINDING_QUALIFICATION_LABEL[q]}</Tag>
        <Tag color={findingStatusColor(finding.status)}>{FINDING_STATUS_LABEL[finding.status] ?? finding.status}</Tag>
        <Tag color="grey">{finding.vulnClass}</Tag>
      </Space>
      <Typography.Paragraph type="tertiary" size="small" style={{ margin: "0 0 12px", wordBreak: "break-all" }}>
        {finding.asset}{finding.endpoint ? ` · ${finding.endpoint}` : ""}
        {finding.cvss ? ` · CVSS ${finding.cvss}` : ""}
        {finding.verifiedAt ? ` · 复现于 ${formatDateTime(finding.verifiedAt, true)}` : ""}
        {finding.verifiedBy ? ` · ${finding.verifiedBy}` : ""}
      </Typography.Paragraph>

      <Section title="成因与技术细节">
        {finding.rootCause ? <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}>{finding.rootCause}</Typography.Paragraph>
          : <Typography.Text type="tertiary" size="small">未记录成因分析。</Typography.Text>}
      </Section>

      <Section title="分步复现与 PoC" extra={<Button size="small" icon={<IconCopy />} onClick={() => void copyPoc()}>一键复制 PoC</Button>}>
        {finding.repro ? <pre className="gy-mono gy-finding-block">{finding.repro}</pre>
          : <Typography.Text type="tertiary" size="small">未记录复现步骤。</Typography.Text>}
        {finding.pocCurl && <pre className="gy-mono gy-finding-block">{finding.pocCurl}</pre>}
      </Section>

      <Section title={`关联 HTTP 流量${traffic ? ` · ${traffic.length}` : ""}`}>
        {traffic == null ? <Spin size="small" /> : traffic.length === 0 ? (
          <Typography.Text type="tertiary" size="small">暂无关联流量。</Typography.Text>
        ) : (
          <div className="gy-finding-traffic">
            {traffic.map((row) => <TrafficPreview key={row.id} taskId={taskId} row={row} />)}
          </div>
        )}
      </Section>

      <Section title={`证据原件 · ${finding.evidence.length}`}>
        {finding.evidence.length === 0 ? (
          <Typography.Text type="tertiary" size="small">暂无封存证据（线索阶段）。</Typography.Text>
        ) : finding.evidence.map((entry) => (
          <div key={entry.path} className="gy-finding-evidence">
            <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{entry.path}</Typography.Text>
            <Typography.Text type="tertiary" size="small"> SHA-256 {entry.sha256.slice(0, 16)}…{entry.role ? ` · ${entry.role}` : ""}</Typography.Text>
            {/^(http|oast|tool):/.test(entry.path) ? null : evidenceBodies[entry.path] != null ? (
              entry.path.endsWith(".md")
                ? <div className="gy-finding-evidence-md"><ReportMarkdown text={evidenceBodies[entry.path]} /></div>
                : <pre className="gy-mono gy-finding-block">{evidenceBodies[entry.path]}</pre>
            ) : <Typography.Text type="tertiary" size="small"> 正在读取原件…</Typography.Text>}
          </div>
        ))}
      </Section>

      <Section title="影响与修复建议">
        {finding.impact ? <Typography.Paragraph style={{ margin: "0 0 8px", whiteSpace: "pre-wrap" }}><strong>影响：</strong>{finding.impact}</Typography.Paragraph> : null}
        {finding.fix ? <Typography.Paragraph style={{ margin: 0, whiteSpace: "pre-wrap" }}><strong>修复：</strong>{finding.fix}</Typography.Paragraph> : null}
        {!finding.impact && !finding.fix && <Typography.Text type="tertiary" size="small">未记录影响与修复建议。</Typography.Text>}
      </Section>

      {retests.length > 0 && (
        <Section title={`修复后复测 · ${retests.length}`}>
          <RetestsSection rows={retests} />
        </Section>
      )}

      <Section title="独立复核" extra={
        <Space spacing={8}>
          <Button size="small" theme="solid" type="primary" loading={busy} onClick={() => onValidate(false)}>一键复核</Button>
          <Button size="small" loading={busy} onClick={() => onValidate(true)}>强制重核</Button>
        </Space>
      }>
        {validations.length === 0 ? (
          <Typography.Text type="tertiary" size="small">尚无独立复核；高危/严重交付前应由另一执行节点或操作员确认。</Typography.Text>
        ) : (
          <Table
            size="small" rowKey="id" pagination={false} dataSource={validations}
            columns={[
              { title: "结论", dataIndex: "verdict", width: 100, render: (v: string) => <Tag color={VERDICT_COLOR[v] ?? "grey"} size="small">{VERDICT_LABEL[v] ?? v}</Tag> },
              { title: "方法", dataIndex: "method", width: 100, render: (v: string) => METHOD_LABEL[v] ?? v },
              { title: "复核者", dataIndex: "validator", width: 140 },
              { title: "独立", dataIndex: "independent", width: 60, render: (v: boolean) => v ? "是" : "否" },
              { title: "时间", dataIndex: "createdAt", width: 160, render: (v: string) => formatDateTime(v, true) },
              { title: "说明", dataIndex: "note", ellipsis: true },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="gy-finding-section">
      <div className="gy-finding-section-head">
        <Typography.Text strong size="small">{title}</Typography.Text>
        {extra}
      </div>
      {children}
    </section>
  );
}

function TrafficPreview({ taskId, row }: { taskId: string; row: TrafficRecord }) {
  const [open, setOpen] = useState(false);
  const [req, setReq] = useState("");
  const [res, setRes] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (row.reqBodyBlob) api.trafficBlob(taskId, row.id, "req", 0, 4096).then(({ json }) => { if (!cancelled) setReq(json.body); }).catch(() => {});
    if (row.resBodyBlob) api.trafficBlob(taskId, row.id, "res", 0, 4096).then(({ json }) => { if (!cancelled) setRes(json.body); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, taskId, row.id]);
  return (
    <div className="gy-finding-traffic-row">
      <button type="button" className="gy-finding-traffic-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Tag size="small" color="blue">{row.method}</Tag>
        <Tag size="small" color={httpStatusColor(row.status)}>{row.status || "—"}</Tag>
        <span className="gy-finding-traffic-path" title={row.path}>{row.host}{row.path}</span>
        <span className="gy-finding-traffic-meta">{formatDuration(row.durationMs)}{row.resBodyBlob ? ` · ${formatBytes(row.resBodyBlob.size)}` : ""}</span>
      </button>
      <Collapsible isOpen={open}>
        <div className="gy-finding-traffic-raw">
          <pre className="gy-mono gy-finding-block">{buildRawRequest(row, req)}</pre>
          <pre className="gy-mono gy-finding-block">{buildRawResponse(row, res)}</pre>
        </div>
      </Collapsible>
    </div>
  );
}

function LooseEvidence({ taskId, files, findings, onReload, onRefresh }: {
  taskId: string;
  files: Array<{ path: string; size: number; mtime: string }>;
  findings: FindingRecord[];
  onReload: () => Promise<void>;
  onRefresh: () => void;
}) {
  const referenced = useMemo(() => new Set(findings.flatMap((f) => f.evidence.map((e) => e.path))), [findings]);
  const loose = files.filter((f) => !referenced.has(f.path));
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ path: string; body: string } | null>(null);

  const importMaterial = async () => {
    if (!path.trim() || !content.trim()) { Toast.error("请填写材料路径与内容"); return; }
    setBusy(true);
    try {
      const { json } = await api.writeEvidence(taskId, { path: path.trim(), content });
      Toast.success(`已写入 ${json.path}（${json.replaced ? "替换" : "新增"}）`);
      setPath(""); setContent("");
      await onReload(); onRefresh();
    } catch (e) { Toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="gy-loose-evidence">
      <Typography.Paragraph type="tertiary" size="small" style={{ margin: "8px 0" }}>
        未关联漏洞的证据文件与原始材料导入兜底入口；已挂到漏洞的证据请在漏洞详情里查看。
      </Typography.Paragraph>
      {loose.length === 0 ? <Empty description="暂无零散证据" style={{ padding: 16 }} /> : (
        <div className="gy-loose-list">
          {loose.map((f) => (
            <div key={f.path} className="gy-loose-row">
              <Typography.Text code size="small" style={{ wordBreak: "break-all" }}>{f.path}</Typography.Text>
              <Typography.Text type="tertiary" size="small"> {f.size} 字节</Typography.Text>
              <Button size="small" theme="borderless" onClick={async () => {
                try { const r = await api.evidenceFile(taskId, f.path); setPreview({ path: f.path, body: r.text }); }
                catch (e) { Toast.error(e instanceof Error ? e.message : String(e)); }
              }}>预览</Button>
            </div>
          ))}
        </div>
      )}
      {preview && (
        <Card title={preview.path} style={{ marginTop: 8 }} headerExtraContent={<Button size="small" onClick={() => setPreview(null)}>关闭</Button>}>
          <pre className="gy-mono gy-finding-block">{preview.body}</pre>
        </Card>
      )}
      <div className="gy-loose-import">
        <Input aria-label="材料路径" placeholder="evidence/ 下相对路径，例如 assets/baseline.csv" value={path} onChange={setPath} style={{ marginBottom: 8 }} />
        <TextArea aria-label="材料内容" placeholder="utf8 文本内容" value={content} onChange={setContent} autosize={{ minRows: 3, maxRows: 8 }} />
        <Button theme="solid" loading={busy} onClick={() => void importMaterial()} style={{ marginTop: 8 }}>导入/替换材料</Button>
      </div>
    </div>
  );
}