import {
  deriveFindingSections,
  extractReportSection,
  renderFindingsSummaryMarkdown,
  renderSingleFindingMarkdown,
  selectableChatModels,
  type ChatProfile,
  type Fact,
  type Finding,
  type FindingReportContext,
  type FindingReportEvidenceItem,
  type FindingReportTrafficItem,
  type TaskRecord,
  type TrafficRecord,
} from "@gongyuai/contracts";
import { queryFromSearchParams, readTrafficBody } from "@gongyuai/exec";
import { readEvidenceBytes, type HistoryStore } from "@gongyuai/history";
import { needsKey, requestCompletion, responseText } from "./chat-provider.js";
import { taskPaths } from "./paths.js";
import type { SettingsStore } from "./settings.js";

const REPORTER_SYSTEM_PROMPT = `你是授权渗透测试系统中的**专业漏洞报告撰写专家**（对标 ARTEX 报告标准）。你不执行任何探测或利用动作，唯一职责是基于提供的真实取证材料，为当前漏洞撰写一份**结构化、可独立复现、面向工程修复的详细漏洞报告（Markdown）**。

━━ 必须严格遵循的章节结构（仅输出章节正文，不要加一级标题 #）━━
## 概述
一句话清晰说明是什么漏洞、位于哪个资产/接口/服务端口、攻击者可借此达成什么实际效果。

## 影响与危害
结合目标服务定位与实际验证回显，说明漏洞可造成的最坏安全后果（如远程代码执行、数据库拖库、越权读写、内网横向突破、敏感凭据泄露等），并给出当前严重等级判断的客观理由。

## 受影响范围
列出受影响的资产地址、协议/端口/URL 端点、关键参数、已识别的组件及版本、以及利用所需的前置权限或网络条件。

## 复现步骤
必须使用明确编号的三级标题展开：\`### 步骤 1：<动作标题>\`、\`### 步骤 2：<动作标题>\`……
- 每一步写清：**操作目的**、**输入请求/命令/参数**、**实际响应或回显结果**、**对应证据来源**；
- 不要把多个独立阶段揉成一段；如有已关联的真实 HTTP 请求/响应或命令输出，在对应步骤用代码块贴出关键报文或命令。

## 证据
贴出证明漏洞真实成立的关键命令输出、敏感回显、响应特征或封存证据原文片段（使用代码块，标注对应证据路径或流量 ID）。

## PoC
给出可直接运行/复用的完整利用命令、curl 请求或脚本代码块，并简述执行方式；若上方复现步骤已包含完整单行命令，仍在此集中给出最简可复核 PoC。

## 根因分析
从代码实现、协议设计或运维配置层面深入剖析漏洞成因（例如：FastCGI 9000 端口未限制监听地址且无认证导致 PHP_ADMIN_VALUE 配置注入、SQL 字符串拼接缺预编译绑定、对象访问缺失归属校验等）。

## 修复建议
分「近期缓解措施」与「根治加固方案」给出具体、可落地的工程整改建议（具体到配置项、代码改法、网络隔离策略或最小权限收敛），严禁空泛套话。

━━ 铁律 ━━
1. **100% 基于真实证据**：所有端点、参数、命令、数据包、回显与组件版本必须来自输入材料；材料中未验证的细节如实标注“待进一步确认”，严禁编造请求报文、响应头、CVE 编号或未发生的利用结果。
2. **全程中文专业表述**（命令、代码、HTTP 报文、路径与 CWE/CVE 标识保持英文原样），精炼严谨，不复述提示词。`;

function isLikelyPrintableText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.08;
}

function formatRawHttpHead(
  firstLine: string,
  headers: Record<string, string | string[]> | undefined,
  body: string,
): string {
  const lines = [firstLine];
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers).slice(0, 20)) {
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
    }
  }
  if (body.trim()) {
    lines.push("", body.trim());
  }
  return lines.join("\n");
}

function loadTrafficExcerpts(task: TaskRecord, finding: Finding, maxItems = 8): FindingReportTrafficItem[] {
  try {
    const params = new URLSearchParams({ findingId: finding.id, limit: String(maxItems) });
    const page = queryFromSearchParams(task.dataDir, task.id, params);
    const rows: TrafficRecord[] = page.traffic ?? [];
    return rows.map((row) => {
      let reqBody = "";
      let resBody = "";
      if (row.reqBodyBlob) {
        try {
          reqBody = readTrafficBody(task.dataDir, row.id, "req", 0, 1800).body;
        } catch {
          /* ignore missing blob */
        }
      }
      if (row.resBodyBlob) {
        try {
          resBody = readTrafficBody(task.dataDir, row.id, "res", 0, 1800).body;
        } catch {
          /* ignore missing blob */
        }
      }
      const url = row.url || `http://${row.host}${row.path}`;
      const reqExcerpt = formatRawHttpHead(
        `${row.method} ${row.path || "/"} HTTP/1.1\nHost: ${row.host}`,
        row.reqHeaders,
        reqBody,
      );
      const resExcerpt = formatRawHttpHead(
        `HTTP/1.1 ${row.status || 0}`,
        row.resHeaders,
        resBody,
      );
      return {
        id: row.id,
        method: row.method,
        status: row.status,
        url,
        durationMs: row.durationMs,
        requestExcerpt: reqExcerpt,
        responseExcerpt: resExcerpt,
      };
    });
  } catch {
    return [];
  }
}

function loadEvidenceItems(task: TaskRecord, history: HistoryStore, finding: Finding): FindingReportEvidenceItem[] {
  const paths = taskPaths(task.dataDir);
  return finding.evidence.map((entry) => {
    let excerpt: string | undefined;
    try {
      const sealed = history.readProofVersion(task.id, entry.sha256);
      const bytes =
        sealed ??
        (/^(http|oast|tool):/.test(entry.path) ? null : readEvidenceBytes(paths.evidenceDir, entry.path));
      if (bytes && isLikelyPrintableText(bytes)) {
        const text = bytes.subarray(0, 2400).toString("utf8").trim();
        if (text) {
          excerpt = bytes.length > 2400 ? `${text}\n…（已截断，原件共 ${bytes.length} 字节）` : text;
        }
      }
    } catch {
      /* ignore unreadable evidence */
    }
    return {
      path: entry.path,
      sha256: entry.sha256,
      role: entry.role,
      note: entry.note,
      ...(excerpt ? { excerpt } : {}),
    };
  });
}

export function buildFindingReportContext(
  task: TaskRecord,
  history: HistoryStore,
  finding: Finding,
): FindingReportContext {
  const allFacts = history.listFacts(task.id);
  const byId = new Map(allFacts.map((f) => [f.id, f]));
  const picked = new Map<string, Fact>();
  for (const fid of finding.factIds) {
    const f = byId.get(fid);
    if (f) picked.set(f.id, f);
  }
  if (finding.intentId) {
    for (const f of allFacts) {
      if (f.intentId === finding.intentId && !picked.has(f.id) && picked.size < 6) {
        picked.set(f.id, f);
      }
    }
  }
  const intent = finding.intentId ? history.getIntent(task.id, finding.intentId) : null;
  const validations = history.listFindingValidations(task.id, finding.id);
  const evidenceItems = loadEvidenceItems(task, history, finding);
  const traffic = loadTrafficExcerpts(task, finding);

  return {
    taskTitle: task.name,
    taskTargets: task.auth.targets,
    generatedAt: new Date().toISOString(),
    facts: [...picked.values()].map((f) => ({
      id: f.id,
      title: f.title,
      summary: f.summary,
      evidencePath: f.evidencePath,
    })),
    intent: intent
      ? { id: intent.id, title: intent.title, summary: intent.summary, conclusion: intent.conclusion }
      : null,
    traffic,
    evidenceItems,
    validations,
  };
}

export function buildTaskFindingsSummaryMarkdown(task: TaskRecord, history: HistoryStore, includeTentative = false): string {
  const findings = history.listFindings(task.id);
  const contextByFindingId = new Map<string, FindingReportContext>();
  for (const f of findings) {
    if (f.status === "retracted") continue;
    if (!includeTentative && !["verified", "retested", "accepted"].includes(f.status)) continue;
    contextByFindingId.set(f.id, buildFindingReportContext(task, history, f));
  }
  return renderFindingsSummaryMarkdown(findings, {
    taskId: task.id,
    taskTitle: task.name,
    targets: task.auth.targets,
    generatedAt: new Date().toISOString(),
    includeTentative,
    contextByFindingId,
  });
}

function resolveReporterModel(settings: SettingsStore): { profile: ChatProfile; modelId: string; base?: string } | null {
  const catalog = settings.chatCatalog();
  const profiles = settings.chatProfiles();
  const preferred = profiles.find((p) => p.id === catalog.defaultId) ?? profiles[0];
  if (preferred) {
    const modelId = preferred.modelId || selectableChatModels(preferred)[0] || "";
    if (modelId && !needsKey(preferred)) {
      const legacy = preferred.id === "existing" && !settings.get().chatProfiles.some((p) => p.id === "existing");
      return {
        profile: preferred,
        modelId,
        ...(legacy ? { base: preferred.baseUrl.replace(/\/+$/, "") } : {}),
      };
    }
  }
  const workerModel = settings.get().model;
  const apiKey = workerModel.apiKey || process.env.OPENAI_API_KEY || "";
  const baseUrl = workerModel.baseUrl || process.env.OPENAI_BASE_URL || "";
  const modelId = workerModel.modelId || process.env.GY_MODEL || "";
  if (baseUrl && modelId && (apiKey || !/^https:\/\/api\.openai\.com/i.test(baseUrl))) {
    return {
      profile: {
        id: "worker-fallback",
        name: "Worker Model",
        protocol: "openai",
        baseUrl,
        apiKey,
        modelId,
        models: [modelId],
      },
      modelId,
      base: baseUrl.replace(/\/+$/, ""),
    };
  }
  return null;
}

function normalizeGeneratedMarkdown(raw: string): string {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const outerFence = /^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i.exec(cleaned);
  if (outerFence) cleaned = outerFence[1]!.trim();
  // Drop accidental top-level `# ...` title if the model included one, since renderSingleFindingMarkdown adds it.
  cleaned = cleaned.replace(/^#\s+[^\r\n]+\r?\n+/, "").trim();
  return cleaned;
}

export async function generateFindingDetailedReport(opts: {
  settings: SettingsStore;
  task: TaskRecord;
  history: HistoryStore;
  finding: Finding;
  signal?: AbortSignal;
}): Promise<{
  finding: Finding;
  markdown: string;
  context: FindingReportContext;
  source: "llm" | "synthesized";
  model?: string;
  warning?: string;
}> {
  const { settings, task, history, finding } = opts;
  const context = buildFindingReportContext(task, history, finding);
  const resolved = resolveReporterModel(settings);

  const fallbackSynthesize = (warning?: string) => {
    const derived = deriveFindingSections(finding, context);
    const bodyLines: string[] = [
      "## 概述",
      "",
      derived.summary,
      "",
      "## 影响与危害",
      "",
      derived.impact,
      "",
      "## 受影响范围",
      "",
      derived.affectedScope,
      "",
      "## 复现步骤",
      "",
    ];
    for (const step of derived.steps) {
      bodyLines.push(`### 步骤 ${step.number}：${step.title}`, "");
      if (step.body) {
        bodyLines.push(step.body.includes("```") ? step.body : `\`\`\`text\n${step.body}\n\`\`\``, "");
      }
    }
    if (derived.poc) {
      bodyLines.push("## PoC", "", derived.poc.includes("```") ? derived.poc : `\`\`\`bash\n${derived.poc}\n\`\`\``, "");
    }
    bodyLines.push("## 根因分析", "", derived.rootCause, "", "## 修复建议", "", derived.fix);
    const synthesizedBody = bodyLines.join("\n").trim();
    const updated =
      history.updateFindingReport(task.id, finding.id, {
        summary: finding.summary || derived.summary,
        affectedScope: finding.affectedScope || derived.affectedScope,
        rootCause: finding.rootCause || derived.rootCause,
        impact: finding.impact || derived.impact,
        fix: finding.fix || derived.fix,
        report: synthesizedBody,
      }) ?? finding;
    return {
      finding: updated,
      markdown: renderSingleFindingMarkdown(updated, context),
      context,
      source: "synthesized" as const,
      ...(warning ? { warning } : {}),
    };
  };

  if (!resolved) {
    return fallbackSynthesize("未检测到可用大模型配置，已基于封存证据与 CWE 知识基线生成结构化报告。");
  }

  const promptPayload = {
    task: {
      id: task.id,
      title: task.name,
      targets: task.auth.targets,
    },
    finding: {
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      vulnClass: finding.vulnClass,
      cvss: finding.cvss,
      status: finding.status,
      qualification: finding.qualification ?? null,
      asset: finding.asset,
      endpoint: finding.endpoint,
      summary: finding.summary ?? "",
      affectedScope: finding.affectedScope ?? "",
      rootCause: finding.rootCause ?? "",
      repro: finding.repro,
      pocCurl: finding.pocCurl ?? "",
      impact: finding.impact,
      fix: finding.fix,
      verifiedAt: finding.verifiedAt,
      verifiedBy: finding.verifiedBy,
    },
    relatedIntent: context.intent,
    relatedFacts: context.facts,
    sealedEvidence: (context.evidenceItems ?? []).map((item) => ({
      path: item.path,
      sha256: item.sha256,
      role: item.role,
      excerpt: item.excerpt ?? "（非文本或仅哈希引用）",
    })),
    associatedHttpTraffic: (context.traffic ?? []).map((tx, idx) => ({
      order: idx + 1,
      id: tx.id,
      method: tx.method,
      status: tx.status,
      url: tx.url,
      request: tx.requestExcerpt,
      response: tx.responseExcerpt,
    })),
    validations: (context.validations ?? []).map((v) => ({
      verdict: v.verdict,
      method: v.method,
      validator: v.validator,
      independent: v.independent,
      note: v.note,
    })),
  };

  const signal = opts.signal ?? AbortSignal.timeout(90_000);
  try {
    const response = await requestCompletion(
      resolved.profile,
      { modelId: resolved.modelId },
      [
        {
          role: "user",
          content: `请根据以下真实漏洞取证记录撰写完整的结构化详细漏洞报告（Markdown）：\n\n\`\`\`json\n${JSON.stringify(promptPayload, null, 2)}\n\`\`\``,
        },
      ],
      signal,
      {
        system: REPORTER_SYSTEM_PROMPT,
        stream: false,
        ...(resolved.base ? { base: resolved.base } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return fallbackSynthesize(`模型服务返回 HTTP ${response.status}，已回退为确定性结构化报告。`);
    }
    const rawText = responseText(resolved.profile.protocol, await response.json());
    const reportBody = typeof rawText === "string" ? normalizeGeneratedMarkdown(rawText) : "";
    if (!reportBody || reportBody.length < 40) {
      return fallbackSynthesize("模型返回内容为空，已回退为确定性结构化报告。");
    }

    const genSummary = extractReportSection(reportBody, ["概述"]);
    const genImpact = extractReportSection(reportBody, ["影响与危害", "影响"]);
    const genScope = extractReportSection(reportBody, ["受影响范围"]);
    const genRootCause = extractReportSection(reportBody, ["根因分析"]);
    const genFix = extractReportSection(reportBody, ["修复建议"]);

    const updated =
      history.updateFindingReport(task.id, finding.id, {
        ...(genSummary ? { summary: genSummary } : {}),
        ...(genScope ? { affectedScope: genScope } : {}),
        ...(genRootCause ? { rootCause: genRootCause } : {}),
        ...(genImpact ? { impact: genImpact } : {}),
        ...(genFix ? { fix: genFix } : {}),
        report: reportBody,
      }) ?? finding;

    return {
      finding: updated,
      markdown: renderSingleFindingMarkdown(updated, context),
      context,
      source: "llm",
      model: resolved.modelId,
    };
  } catch (err) {
    return fallbackSynthesize(
      `模型调用失败（${err instanceof Error ? err.message : String(err)}），已回退为确定性结构化报告。`,
    );
  }
}
