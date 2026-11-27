import type { Finding, FindingSeverity, FindingValidation } from "./finding.js";

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type ReproductionStep = {
  number: number;
  title: string;
  body: string;
};

export type FindingReportFactRef = {
  id: string;
  title: string;
  summary: string;
  evidencePath?: string | null;
};

export type FindingReportIntentRef = {
  id: string;
  title: string;
  summary?: string;
  conclusion?: string | null;
};

export type FindingReportTrafficItem = {
  id: string;
  method: string;
  status: number;
  url: string;
  durationMs?: number;
  requestExcerpt?: string;
  responseExcerpt?: string;
};

export type FindingReportEvidenceItem = {
  path: string;
  sha256: string;
  role?: string;
  note?: string;
  excerpt?: string;
  linkMarkdown?: string;
};

export type FindingReportContext = {
  taskTitle?: string;
  taskTargets?: string[];
  generatedAt?: string;
  facts?: FindingReportFactRef[];
  intent?: FindingReportIntentRef | null;
  traffic?: FindingReportTrafficItem[];
  evidenceItems?: FindingReportEvidenceItem[];
  validations?: FindingValidation[];
};

export type VulnClassDescriptor = {
  code: string;
  label: string;
  typicalCause: string;
  typicalImpact: string;
  typicalFix: string;
};

const SEVERITY_CN: Record<FindingSeverity, string> = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
};

const STATUS_CN: Record<Finding["status"], string> = {
  tentative: "待验证线索",
  verified: "已复现",
  retested: "修复后复测",
  accepted: "风险已接受",
  retracted: "已撤回（误报）",
};

const QUALIFICATION_CN: Record<string, string> = {
  exploited: "完整危害已证实",
  confirmed: "漏洞特征已确认",
  unconfirmed: "待独立确认",
};

const VULN_CLASS_KB: Record<string, Omit<VulnClassDescriptor, "code">> = {
  "CWE-89": {
    label: "SQL 注入",
    typicalCause: "数据访问层将外部可控参数直接拼接进 SQL 语句，缺少参数化预编译绑定或严格类型白名单校验。",
    typicalImpact: "攻击者可构造恶意 SQL 载荷绕过认证、读取或篡改数据库敏感业务数据，高权限配置下可能进一步读写文件或执行命令。",
    typicalFix: "全面改用参数化查询（Prepared Statements / 参数绑定），禁止字符串拼接 SQL；对排序字段/表名实施严格枚举白名单，并收敛数据库账户最小权限。",
  },
  "CWE-78": {
    label: "OS 命令注入",
    typicalCause: "后端将未净化的用户输入拼入系统 Shell 命令（如 system/exec/popen/sh -c），允许元字符截断或注入任意子命令。",
    typicalImpact: "可在目标主机/容器进程上下文直接执行任意操作系统命令（RCE），读取配置凭据、内网探测及进一步横向移动。",
    typicalFix: "避免调用 Shell 解释器，改用安全的原生库或参数数组形式（如 execFile/spawn 且 shell=false）；对输入参数执行严格字符集白名单校验并以最小权限运行服务。",
  },
  "CWE-94": {
    label: "代码注入 / 动态执行",
    typicalCause: "服务端将外部可控输入送入动态代码求值或配置指令注入通道（如 eval、模板表达式、FastCGI PHP_ADMIN_VALUE 等）。",
    typicalImpact: "攻击者可在应用运行时上下文执行任意服务端代码（RCE），完全控制应用进程并窃取运行环境敏感凭据。",
    typicalFix: "移除对不可信输入的动态代码求值逻辑；封闭内部协议端口或配置注入入口，使用安全解析器并限制运行态权限。",
  },
  "CWE-79": {
    label: "跨站脚本（XSS）",
    typicalCause: "前端或服务端模板将不可信数据未按输出上下文做 HTML/属性/脚本编码便直接渲染至页面 DOM。",
    typicalImpact: "可在受害者浏览器上下文执行任意脚本，窃取会话凭据、冒充用户发起敏感业务操作或投递钓鱼载荷。",
    typicalFix: "按输出上下文实施严格输出编码，禁用危险原语（如未经净化的 innerHTML / dangerouslySetInnerHTML），开启 HttpOnly Cookie 与严格 CSP 策略。",
  },
  "CWE-22": {
    label: "路径遍历 / 任意文件读取",
    typicalCause: "文件读取、下载或预览接口直接拼接用户传入的相对路径，未对规范化后的真实路径（realpath）校验基准目录边界，或存在编码/双写绕过。",
    typicalImpact: "可越界读取宿主机或容器内的敏感配置文件、源码、密钥及业务凭据，为进一步接管系统提供关键依据。",
    typicalFix: "使用对象标识映射替代直接传入文件路径；必须接收文件名时先取 basename 并经 realpath 规范化后强制校验位于允许的根目录内。",
  },
  "CWE-306": {
    label: "关键功能缺失身份认证",
    typicalCause: "敏感管理接口、内部 RPC/FastCGI 守护端口或高危业务动作直接暴露于可访问网络面，缺失前置身份认证与网络层访问控制。",
    typicalImpact: "未授权攻击者无需任何凭据即可直接调用高危功能或内部服务协议，导致远程命令执行、敏感信息泄露或系统接管。",
    typicalFix: "为所有敏感端点与内部协议强制接入统一认证鉴权；将 FastCGI/管理端口仅绑定至 127.0.0.1 或受控 Unix Socket（严格收敛文件权限），并通过防火墙/安全组隔离外部直连。",
  },
  "CWE-287": {
    label: "身份认证绕过 / 认证机制缺陷",
    typicalCause: "登录校验、会话令牌签发/验签（如弱密钥 JWT、逻辑短路、默认口令）存在实现缺陷，未能可靠核验请求者真实身份。",
    typicalImpact: "攻击者可伪造任意用户或管理员会话态，直接接管高权限账户并访问受保护功能。",
    typicalFix: "修复认证状态机与令牌验签逻辑，使用高熵随机密钥（通过安全凭据管理注入），禁用硬编码后门/弱口令并在服务端强制校验会话有效性。",
  },
  "CWE-284": {
    label: "访问控制不当",
    typicalCause: "服务端路由或资源访问缺少统一的权限拦截，或网关与后端路径解析不一致导致鉴权绕过。",
    typicalImpact: "低权限或匿名访问者可越界调用受限接口、读写受保护业务资源。",
    typicalFix: "在服务端业务层实施默认拒绝（Default Deny）的集中式访问控制，统一前后端路径规范化逻辑，不依赖前端隐藏或头部自报身份。",
  },
  "CWE-639": {
    label: "越权访问（IDOR / BOLA）",
    typicalCause: "接口仅校验登录态，未核对当前会话主体对目标业务对象 ID 的所有权或租户归属关系。",
    typicalImpact: "任意已登录用户可通过遍历或替换对象标识越权读取、修改或删除他人及跨租户敏感业务数据。",
    typicalFix: "在每次数据读写查询中强制绑定当前登录主体/租户上下文（如 WHERE id = ? AND owner_id = ?），对敏感操作执行独立的对象级权限校验。",
  },
  "CWE-434": {
    label: "危险类型文件任意上传",
    typicalCause: "上传接口仅依赖前端校验、Content-Type 或不完整的黑名单扩展名过滤，且上传目录具备脚本解析执行权限。",
    typicalImpact: "攻击者可上传 WebShell 或可执行脚本获取服务端远程代码执行权限（RCE），进而完全控制目标应用。",
    typicalFix: "采用严格扩展名白名单 + 文件魔数/内容校验；重命名存储文件为随机 UUID，将上传目录与脚本执行引擎彻底分离（静态对象存储并禁止脚本执行）。",
  },
  "CWE-918": {
    label: "服务端请求伪造（SSRF）",
    typicalCause: "服务端接收外部可控 URL 发起网络请求，未限制目标协议、未在连接层校验解析后的真实目标 IP 是否落入回环/私网/云元数据网段，或跟随了恶意重定向。",
    typicalImpact: "可借服务端身份探测隔离内网端口、访问本机未授权服务（如 Redis/FastCGI/元数据接口 169.254.169.254）并窃取云凭据或触发内网利用链。",
    typicalFix: "禁用非必要协议（仅允许 http/https），在自定义拨号器（Dialer）层面解析 DNS 后校验真实连接 IP 不属于内网/回环/链路本地地址，并禁止自动跟随未校验的 30x 重定向。",
  },
  "CWE-502": {
    label: "不安全的反序列化",
    typicalCause: "应用直接反序列化不可信的外部字节流或结构化对象（如 Pickle/PHP unserialize/Java ObjectInputStream/YAML unsafe load），触发魔术方法或 Gadget 链。",
    typicalImpact: "攻击者可构造恶意序列化载荷在服务端直接实现远程任意代码执行（RCE）。",
    typicalFix: "禁止对不可信输入执行原生对象反序列化，改用纯数据格式（如 JSON）配合严格 Schema 校验；确需使用时启用严格类白名单与完整性签名校验。",
  },
  "CWE-611": {
    label: "XML 外部实体注入（XXE）",
    typicalCause: "XML 解析器默认开启外部实体（DOCTYPE / ENTITY）加载与解析，未禁用外部 DTD。",
    typicalImpact: "可读取服务端任意本地文件、发起内网 SSRF 探测或造成解析器拒绝服务。",
    typicalFix: "在 XML 解析器配置中显式禁用 DOCTYPE 声明及外部通用/参数实体解析。",
  },
  "CWE-1321": {
    label: "原型链 / 对象属性链污染",
    typicalCause: "深度合并或按路径赋值函数（如 lodash.merge / pydash.set_）未拦截 __proto__、constructor.prototype、__globals__、__init__ 等特殊属性链或存在转义绕过。",
    typicalImpact: "攻击者可篡改运行时全局类属性、环境变量、模板上下文或鉴权标志，导致权限绕过、逻辑篡改乃至远程代码执行（RCE）。",
    typicalFix: "升级存在绕过缺陷的工具库版本，在路径解析后（消除转义符之后）严格拦截以双下划线或原型属性命名的键名，改用无原型的安全键值容器或显式字段赋值。",
  },
  "CWE-798": {
    label: "硬编码敏感凭据",
    typicalCause: "源码、镜像构建脚本、前端静态包或配置文件中直接硬编码 API 密钥、数据库口令、JWT 签名密钥或高权限账户凭据。",
    typicalImpact: "攻击者一旦读取源码/客户端资源即可获取有效凭据，直接越过边界防线访问核心数据或管理后台。",
    typicalFix: "立即轮换吊销已泄露凭据，彻底移除代码与镜像历史中的明文秘密，改由密钥管理系统（Vault / KMS / 运行时受保护环境变量）动态注入。",
  },
  "CWE-200": {
    label: "敏感信息泄露",
    typicalCause: "调试模式未关闭、备份/源码/元数据端点未隔离或异常响应直接暴露详细栈追踪、路径与环境参数。",
    typicalImpact: "泄露内部架构路径、组件精确版本、密钥片段或业务敏感记录，显著降低后续纵深利用门槛。",
    typicalFix: "生产环境关闭调试回显与目录浏览，清理或隔离备份/诊断端点，对外统一返回脱敏错误信息并最小化响应字段。",
  },
  "AUTHZ-BOLA": {
    label: "对象级越权访问（BOLA / IDOR）",
    typicalCause: "接口未在服务端核验当前请求主体对目标业务对象的所有权或访问授权。",
    typicalImpact: "可横向越权读写其他用户或租户的敏感业务记录。",
    typicalFix: "在数据访问层强制校验对象所属用户/租户与当前认证身份一致。",
  },
  "AUTHZ-BFLA": {
    label: "功能级越权访问（BFLA）",
    typicalCause: "管理或高权限业务路由缺失角色/权限级鉴权中间件。",
    typicalImpact: "普通低权限用户可直接调用管理级功能接口，执行高危管理操作。",
    typicalFix: "在服务端路由网关与控制器层统一实施基于角色的最小权限校验（RBAC/ABAC）。",
  },
};

export function describeVulnClass(vulnClass: string): VulnClassDescriptor {
  const normalized = vulnClass.trim().toUpperCase();
  const exact = VULN_CLASS_KB[normalized];
  if (exact) return { code: vulnClass.trim(), ...exact };
  const cweMatch = /CWE-\d+/i.exec(normalized)?.[0]?.toUpperCase();
  if (cweMatch && VULN_CLASS_KB[cweMatch]) {
    return { code: vulnClass.trim(), ...VULN_CLASS_KB[cweMatch] };
  }
  return {
    code: vulnClass.trim() || "未分类",
    label: vulnClass.trim() || "安全缺陷",
    typicalCause: "目标组件在输入边界校验、身份鉴权或安全配置层面存在缺陷，使不可信请求能够突破预期安全边界。",
    typicalImpact: "攻击者可利用该缺陷破坏目标资产的机密性、完整性或可用性，需结合受影响资产重要程度优先处置。",
    typicalFix: "针对受影响入口补齐服务端输入校验、最小权限访问控制与安全配置加固，并在修复后基于封存复现步骤执行回归复测。",
  };
}

/** Extract a top-level `## <Heading>` section from Markdown while ignoring fenced code blocks. */
export function extractReportSection(report: string, headings: readonly string[]): string {
  if (!report.trim() || headings.length === 0) return "";
  const wanted = new Set(headings.map((h) => h.trim().toLowerCase()));
  const lines = report.split(/\r?\n/);
  let inFence = false;
  let capturing = false;
  const collected: string[] = [];

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (capturing) collected.push(line);
      continue;
    }
    if (!inFence) {
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      if (h2) {
        const headingText = h2[1]!.trim().toLowerCase();
        if (capturing) break;
        if (wanted.has(headingText)) {
          capturing = true;
          continue;
        }
      }
    }
    if (capturing) collected.push(line);
  }
  return collected.join("\n").trim();
}

function summarizeStepTitle(rawLine: string, stepNo: number): { title: string; keepInBody: boolean } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { title: `复现步骤 ${stepNo}`, keepInBody: false };

  // Explicit `标题：正文` where the prefix looks like a natural Chinese/English title (not URL/env/command).
  const colonMatch = /^([^`=:;<>|\\/]{2,28})[：:]\s+(.+)$/s.exec(trimmed);
  if (colonMatch && !/^(?:http|https|tcp|curl|nmap|env|python|sqlmap|POST|GET|PUT|DELETE)\b/i.test(colonMatch[1]!)) {
    return { title: colonMatch[1]!.trim(), keepInBody: true };
  }

  // Command / action line with `→` or `->` outcome annotation: summarize cleanly while preserving full command in body.
  const arrowParts = trimmed.split(/\s*(?:→|->)\s*/);
  if (arrowParts.length >= 2 && trimmed.length > 52) {
    const action = arrowParts[0]!.trim();
    const result = arrowParts.slice(1).join(" → ").trim();
    const cmdMatch = /^(?:env\s+.*?\s+)?([a-zA-Z0-9_.-]+)\b/.exec(action);
    const shortResult = result.length > 36 ? `${result.slice(0, 36)}…` : result;
    if (cmdMatch && /^(?:nmap|curl|cgi-fcgi|sqlmap|python3?|ffuf|httpx|nuclei|nc|socat|ssh|redis-cli)$/i.test(cmdMatch[1]!)) {
      return { title: `执行 ${cmdMatch[1]} 验证 → ${shortResult}`, keepInBody: true };
    }
    const shortAction = action.length > 26 ? `${action.slice(0, 26)}…` : action;
    return { title: `${shortAction} → ${shortResult}`, keepInBody: true };
  }

  if (trimmed.length <= 56 && !trimmed.includes("\n") && !/[`$();|]/.test(trimmed)) {
    return { title: trimmed, keepInBody: false };
  }

  const preview = trimmed.split(/\r?\n/)[0]!.trim();
  return {
    title: preview.length > 48 ? `${preview.slice(0, 48)}…` : preview,
    keepInBody: true,
  };
}

/**
 * Parse reproduction text or an ARTEX-style report into structured numbered steps.
 * Handles `### 步骤 1：...`, `1) ...`, `1. ...`, `步骤 1: ...`, while never splitting inside code fences.
 */
export function parseReproductionSteps(input: {
  report?: string;
  repro?: string;
  fallback?: string;
}): ReproductionStep[] {
  const reportRepro = input.report
    ? extractReportSection(input.report, ["复现步骤", "测试过程", "复现过程"])
    : "";
  const source = (reportRepro || input.repro || "").trim();
  if (!source) {
    const fb = (input.fallback ?? "").trim();
    return fb ? [{ number: 1, title: "验证与复现记录", body: fb }] : [];
  }

  const lines = source.split(/\r?\n/);
  let inFence = false;
  type RawChunk = { num: number; explicitHeading: boolean; headerRest: string; restLines: string[] };
  const chunks: RawChunk[] = [];
  let prefaceLines: string[] = [];

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (chunks.length > 0) chunks[chunks.length - 1]!.restLines.push(line);
      else prefaceLines.push(line);
      continue;
    }
    if (!inFence) {
      const h3 = /^\s*###\s*(?:步骤|Step)\s*(\d+)\s*[.、:：)）-]?\s*(.*)$/i.exec(line);
      if (h3) {
        chunks.push({
          num: Number(h3[1]),
          explicitHeading: true,
          headerRest: h3[2]!.trim(),
          restLines: [],
        });
        continue;
      }
      const numbered = /^\s*(?:(?:步骤|Step)\s*(\d+)\s*[.、:：)）]\s*|(\d+)\s*[)）.、]\s+)(.+)$/i.exec(line);
      if (numbered) {
        const n = Number(numbered[1] ?? numbered[2]);
        chunks.push({
          num: n,
          explicitHeading: false,
          headerRest: numbered[3]!.trim(),
          restLines: [],
        });
        continue;
      }
    }
    if (chunks.length > 0) chunks[chunks.length - 1]!.restLines.push(line);
    else prefaceLines.push(line);
  }

  if (chunks.length === 0) {
    return [{ number: 1, title: "复现操作与验证过程", body: source }];
  }

  const preface = prefaceLines.join("\n").trim();
  return chunks.map((chunk, idx) => {
    const rest = chunk.restLines.join("\n").trim();
    if (chunk.explicitHeading) {
      const title = chunk.headerRest || `复现步骤 ${chunk.num}`;
      const body = idx === 0 && preface ? `${preface}\n\n${rest}`.trim() : rest;
      return { number: chunk.num || idx + 1, title, body };
    }
    const derived = summarizeStepTitle(chunk.headerRest, chunk.num || idx + 1);
    const combinedBody = derived.keepInBody
      ? [chunk.headerRest, rest].filter(Boolean).join("\n")
      : rest || chunk.headerRest;
    const body = idx === 0 && preface ? `${preface}\n\n${combinedBody}`.trim() : combinedBody;
    return {
      number: chunk.num || idx + 1,
      title: derived.title,
      body,
    };
  });
}

export type DerivedFindingSections = {
  summary: string;
  impact: string;
  affectedScope: string;
  rootCause: string;
  rootCauseSource: "recorded" | "report" | "context" | "class-baseline";
  fix: string;
  fixSource: "recorded" | "report" | "class-baseline";
  poc: string;
  steps: ReproductionStep[];
};

export function deriveFindingSections(
  finding: Finding,
  ctx?: FindingReportContext,
): DerivedFindingSections {
  const report = finding.report ?? "";
  const kb = describeVulnClass(finding.vulnClass);
  const sevLabel = SEVERITY_CN[finding.severity] ?? finding.severity;

  const repOverview = extractReportSection(report, ["概述", "漏洞概述"]);
  const repImpact = extractReportSection(report, ["影响与危害", "危害分析", "影响"]);
  const repScope = extractReportSection(report, ["受影响范围", "影响范围", "前置条件"]);
  const repRootCause = extractReportSection(report, ["根因分析", "成因与技术细节", "漏洞成因"]);
  const repFix = extractReportSection(report, ["修复建议", "整改建议", "加固建议"]);
  const repPoc = extractReportSection(report, ["PoC", "漏洞利用代码"]);

  const location = finding.endpoint ? `${finding.asset}（${finding.endpoint}）` : finding.asset;
  const summary =
    finding.summary?.trim() ||
    repOverview ||
    `目标资产 ${location} 存在经实测验证的【${sevLabel}】级别漏洞「${finding.title}」（类别：${kb.code} · ${kb.label}）。`;

  const affectedScope =
    finding.affectedScope?.trim() ||
    repScope ||
    [
      `- **目标资产**：\`${finding.asset}\``,
      finding.endpoint ? `- **受影响端点 / 服务**：\`${finding.endpoint}\`` : null,
      `- **漏洞分类**：\`${kb.code}\`（${kb.label}）`,
      finding.cvss ? `- **CVSS 评估**：\`${finding.cvss}\`` : null,
    ]
      .filter(Boolean)
      .join("\n");

  const impact =
    finding.impact?.trim() ||
    repImpact ||
    `**定级判断：${sevLabel}（${finding.severity.toUpperCase()}${finding.cvss ? ` · CVSS ${finding.cvss}` : ""}）**。${kb.typicalImpact}`;

  let rootCause = "";
  let rootCauseSource: DerivedFindingSections["rootCauseSource"] = "class-baseline";
  if (finding.rootCause?.trim()) {
    rootCause = finding.rootCause.trim();
    rootCauseSource = "recorded";
  } else if (repRootCause) {
    rootCause = repRootCause;
    rootCauseSource = "report";
  } else {
    const contextNotes: string[] = [];
    if (ctx?.intent?.conclusion?.trim()) {
      contextNotes.push(`- **关联验证结论（${ctx.intent.title}）**：${ctx.intent.conclusion.trim()}`);
    }
    for (const fact of (ctx?.facts ?? []).slice(0, 3)) {
      if (fact.summary?.trim()) {
        contextNotes.push(`- **关联取证记录（${fact.title}）**：${fact.summary.trim()}`);
      }
    }
    if (contextNotes.length > 0) {
      rootCause = `${contextNotes.join("\n")}\n\n**机理归因（${kb.code} · ${kb.label}）**：${kb.typicalCause}`;
      rootCauseSource = "context";
    } else {
      rootCause = `结合复现链路与服务特征（${location}），该问题归属 **${kb.code}（${kb.label}）**：${kb.typicalCause}`;
      rootCauseSource = "class-baseline";
    }
  }

  let fix = "";
  let fixSource: DerivedFindingSections["fixSource"] = "class-baseline";
  if (finding.fix?.trim()) {
    fix = finding.fix.trim();
    fixSource = "recorded";
  } else if (repFix) {
    fix = repFix;
    fixSource = "report";
  } else {
    fix = kb.typicalFix;
    fixSource = "class-baseline";
  }

  const poc = finding.pocCurl?.trim() || repPoc || "";
  const steps = parseReproductionSteps({
    report,
    repro: finding.repro,
    fallback: poc,
  });

  return {
    summary,
    impact,
    affectedScope,
    rootCause,
    rootCauseSource,
    fix,
    fixSource,
    poc,
    steps,
  };
}

function stripOuterFence(code: string): string {
  const trimmed = code.trim();
  const m = /^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

/**
 * Render a complete ARTEX-style single-finding Markdown report.
 * When `finding.report` is already persisted (e.g. written by worker or AI reporter),
 * wraps it with the authoritative metadata header and sealed evidence/validation ledger;
 * otherwise synthesizes the full structured report from verified finding artifacts.
 */
export function renderSingleFindingMarkdown(
  finding: Finding,
  ctx?: FindingReportContext,
  opts?: { headingBase?: 1 | 3 },
): string {
  const base = opts?.headingBase ?? 1;
  const hTop = "#".repeat(base);
  const hSec = "#".repeat(base + 1);
  const hStep = "#".repeat(base + 2);
  const kb = describeVulnClass(finding.vulnClass);
  const sevLabel = SEVERITY_CN[finding.severity] ?? finding.severity;
  const statusLabel = STATUS_CN[finding.status] ?? finding.status;
  const qualLabel = finding.qualification ? QUALIFICATION_CN[finding.qualification] ?? finding.qualification : null;
  const sections = deriveFindingSections(finding, ctx);

  const lines: string[] = [
    `${hTop} [${finding.severity.toUpperCase()} · ${sevLabel}] ${finding.title}`,
    "",
    `- **漏洞编号**：\`${finding.id}\``,
    `- **严重等级**：${sevLabel}（\`${finding.severity}\`${finding.cvss ? ` · CVSS \`${finding.cvss}\`` : ""}）`,
    `- **状态与定级**：${statusLabel}${qualLabel ? ` · ${qualLabel}` : ""}`,
    `- **漏洞类别**：\`${kb.code}\`（${kb.label}）`,
    `- **涉及资产**：\`${finding.asset}\`${finding.endpoint ? ` · **端点**：\`${finding.endpoint}\`` : ""}`,
  ];
  if (finding.verifiedAt) {
    lines.push(`- **复现时间**：${finding.verifiedAt}${finding.verifiedBy ? `（验证节点：\`${finding.verifiedBy}\`）` : ""}`);
  }
  if (ctx?.generatedAt && base === 1) {
    lines.push(`- **报告生成时间**：${ctx.generatedAt}`);
  }
  lines.push("");

  if (finding.report?.trim()) {
    const adjusted = base === 1
      ? finding.report.trim()
      : finding.report
          .trim()
          .replace(/^(#{2,4})\s+/gm, (_m, hashes: string) => `${"#".repeat(Math.min(6, hashes.length + (base - 1)))} `);
    lines.push(adjusted, "");
  } else {
    lines.push(`${hSec} 概述`, "", sections.summary, "");
    lines.push(`${hSec} 影响与危害`, "", sections.impact, "");
    lines.push(`${hSec} 受影响范围`, "", sections.affectedScope, "");

    lines.push(`${hSec} 复现步骤`, "");
    if (sections.steps.length === 0) {
      lines.push("暂无结构化复现步骤记录。", "");
    } else {
      for (const [idx, step] of sections.steps.entries()) {
        lines.push(`${hStep} 步骤 ${step.number}：${step.title}`, "");
        if (step.body) {
          if (step.body.includes("```")) {
            lines.push(step.body, "");
          } else {
            lines.push("```text", step.body, "```", "");
          }
        }
        const boundTx = ctx?.traffic?.[idx];
        if (boundTx && sections.steps.length <= (ctx?.traffic?.length ?? 0)) {
          lines.push(`> 关联请求：\`${boundTx.method} ${boundTx.url}\` → HTTP \`${boundTx.status}\``, "");
        }
      }
    }

    if (sections.poc) {
      lines.push(`${hSec} PoC`, "");
      if (sections.poc.includes("```")) {
        lines.push(sections.poc, "");
      } else {
        lines.push("```bash", stripOuterFence(sections.poc), "```", "");
      }
    }

    lines.push(`${hSec} 根因分析`, "", sections.rootCause, "");
    lines.push(`${hSec} 修复建议`, "", sections.fix, "");
  }

  // Always append authoritative sealed evidence & traffic audit trail if not already verbatim in report.
  const evidenceItems: FindingReportEvidenceItem[] = ctx?.evidenceItems ?? finding.evidence.map((e) => ({
    path: e.path,
    sha256: e.sha256,
    role: e.role,
    note: e.note,
  }));
  if (evidenceItems.length > 0) {
    lines.push(`${hSec} 封存证据清单`, "");
    for (const item of evidenceItems) {
      const roleNote = [item.role ? `用途=${item.role}` : "", item.note ?? ""].filter(Boolean).join(" · ");
      if (item.linkMarkdown) {
        lines.push(`- ${item.linkMarkdown}${roleNote ? `（${roleNote}）` : ""}`);
      } else {
        lines.push(`- \`${item.path}\` · SHA-256 \`${item.sha256}\`${roleNote ? `（${roleNote}）` : ""}`);
      }
      if (item.excerpt?.trim()) {
        lines.push("", "```text", item.excerpt.trim(), "```", "");
      }
    }
    lines.push("");
  }

  if (ctx?.traffic && ctx.traffic.length > 0) {
    lines.push(`${hSec} 关联流量证据（${ctx.traffic.length} 条）`, "");
    for (const [idx, tx] of ctx.traffic.slice(0, 10).entries()) {
      lines.push(`${idx + 1}. \`${tx.method} ${tx.url}\` → 状态码 \`${tx.status}\`${tx.durationMs != null ? `（${tx.durationMs} ms）` : ""} · ID \`${tx.id}\``);
      if (tx.requestExcerpt?.trim()) {
        lines.push("", "```http", tx.requestExcerpt.trim(), "```");
      }
      if (tx.responseExcerpt?.trim()) {
        lines.push("", "```http", tx.responseExcerpt.trim(), "```");
      }
    }
    if (ctx.traffic.length > 10) {
      lines.push(`- … 另有 ${ctx.traffic.length - 10} 条关联流量可在「流量记录」面板按漏洞过滤查看。`);
    }
    lines.push("");
  }

  if (ctx?.validations !== undefined) {
    const independent = ctx.validations.filter((v) => v.independent);
    const latest = independent.at(-1);
    lines.push(`${hSec} 独立复核结论`, "");
    if (!latest) {
      lines.push("- 尚未完成独立复核（高危/严重结论建议在交付前由独立验证节点或操作员复核确认）。", "");
    } else {
      lines.push(
        `- **最新结论**：\`${latest.verdict}\` · 复核者 \`${latest.validator}\` · 方法 \`${latest.method}\` · 时间 ${latest.createdAt}`,
      );
      if (latest.note) lines.push(`- **复核说明**：${latest.note}`);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Render an ARTEX-style multi-finding summary report (`# 渗透测试漏洞发现汇总报告`).
 */
export function renderFindingsSummaryMarkdown(
  findings: readonly Finding[],
  opts?: {
    taskId?: string;
    taskTitle?: string;
    targets?: readonly string[];
    generatedAt?: string;
    includeTentative?: boolean;
    contextByFindingId?: ReadonlyMap<string, FindingReportContext>;
  },
): string {
  const active = findings.filter((f) =>
    opts?.includeTentative
      ? f.status !== "retracted"
      : f.status === "verified" || f.status === "retested" || f.status === "accepted",
  );
  const sorted = [...active].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.createdAt.localeCompare(a.createdAt),
  );
  const tentativeCount = findings.filter((f) => f.status === "tentative").length;
  const counts: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of sorted) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const lines: string[] = [
    `# 渗透测试漏洞发现报告${opts?.taskTitle ? ` — ${opts.taskTitle}` : ""}`,
    "",
  ];
  if (opts?.taskId) lines.push(`- **任务编号**：\`${opts.taskId}\``);
  if (opts?.targets?.length) lines.push(`- **测试范围**：${opts.targets.map((t) => `\`${t}\``).join("、")}`);
  lines.push(`- **生成时间**：${opts?.generatedAt ?? new Date().toISOString()}`);
  lines.push(`- **已确认漏洞总数**：**${sorted.length}** 个${tentativeCount && !opts?.includeTentative ? `（另有 ${tentativeCount} 条待验证线索未计入正式交付）` : ""}`);
  lines.push(
    "",
    "## 风险统计摘要",
    "",
    "| 严重等级 | 数量 | 占比 |",
    "| --- | ---: | ---: |",
  );
  for (const sev of ["critical", "high", "medium", "low", "info"] as const) {
    const n = counts[sev];
    const pct = sorted.length > 0 ? `${Math.round((n / sorted.length) * 100)}%` : "0%";
    lines.push(`| ${SEVERITY_CN[sev]}（${sev.toUpperCase()}） | ${n} | ${pct} |`);
  }
  lines.push("");

  if (sorted.length === 0) {
    lines.push("## 漏洞明细", "", "_当前无已确认复现的可交付漏洞。_", "");
    return lines.join("\n");
  }

  lines.push(
    "## 漏洞总览清单",
    "",
    "| # | 严重性 | 漏洞名称 | 涉及资产 / 端点 | 类别 | 状态 | 证据数 |",
    "| ---: | --- | --- | --- | --- | --- | ---: |",
  );
  for (const [idx, f] of sorted.entries()) {
    const safeTitle = f.title.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    const loc = `${f.asset}${f.endpoint ? ` · ${f.endpoint}` : ""}`.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
    lines.push(
      `| ${idx + 1} | ${SEVERITY_CN[f.severity]} | ${safeTitle} | \`${loc}\` | \`${f.vulnClass}\` | ${STATUS_CN[f.status]} | ${f.evidence.length} |`,
    );
  }
  lines.push("", "## 漏洞详细报告", "");

  for (const [idx, f] of sorted.entries()) {
    const ctx = opts?.contextByFindingId?.get(f.id);
    const block = renderSingleFindingMarkdown(f, ctx, { headingBase: 3 });
    const numberedBlock = block.replace(/^### /, `### ${idx + 1}. `);
    lines.push(numberedBlock.trimEnd(), "", "---", "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function findingSafeFilename(finding: Pick<Finding, "id" | "severity" | "title" | "vulnClass">): string {
  const raw = `${finding.severity}_${finding.title || finding.vulnClass}_${finding.id.slice(0, 8)}`;
  const cleaned = raw
    .replace(/[^\p{Script=Han}\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, 100);
  return `${cleaned || `finding_${finding.id.slice(0, 8)}`}.md`;
}

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

/** Render UTF-8 BOM CSV for Excel/table export (ARTEX `FindingsCSV` parity). */
export function findingsToCsv(findings: readonly Finding[]): string {
  const active = [...findings]
    .filter((f) => f.status !== "retracted")
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.createdAt.localeCompare(a.createdAt),
    );
  const header = ["ID", "严重等级", "标题", "类别", "状态", "定级", "资产", "端点", "CVSS", "复现时间", "证据数量", "流量数量", "概述"];
  const rows = [header.map(csvCell).join(",")];
  for (const f of active) {
    const overview = deriveFindingSections(f).summary.replace(/\s+/g, " ").trim();
    rows.push(
      [
        f.id,
        SEVERITY_CN[f.severity] ?? f.severity,
        f.title,
        f.vulnClass,
        STATUS_CN[f.status] ?? f.status,
        f.qualification ?? "",
        f.asset,
        f.endpoint ?? "",
        f.cvss ?? "",
        f.verifiedAt ?? f.createdAt,
        String(f.evidence.length),
        String(f.trafficIds?.length ?? 0),
        overview,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
