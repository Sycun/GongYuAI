export type ReportHeading = { level: number; text: string; id: string };

/** 从 Markdown 提取标题生成目录；id 用序号保证唯一，避免同名标题锚点冲突。 */
export function extractHeadings(markdown: string): ReportHeading[] {
  const out: ReportHeading[] = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let index = 0;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue;
    out.push({ level: match[1].length, text, id: `gy-report-h-${index++}` });
  }
  return out;
}

export type CodeToken = { text: string; type: "comment" | "string" | "number" | "keyword" | "plain" };

const KEYWORDS: Record<string, Set<string>> = {
  bash: new Set(["curl", "wget", "grep", "sed", "awk", "sudo", "ssh", "scp", "nmap", "cat", "echo", "export", "cd", "ls", "python", "python3", "pip", "git", "docker", "kubectl", "nc", "ncat", "socat", "chmod", "chown", "find", "tar", "base64", "openssl", "sqlmap", "ffuf", "gobuster", "hydra", "john", "hashcat"]),
  http: new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "HTTP/1.1", "HTTP/2", "Host:", "Content-Type:", "Authorization:", "Cookie:", "Content-Length:"]),
  json: new Set(["true", "false", "null"]),
};

const TOKEN_RE = /(#.*$|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w:.-]*)|(\s+|.)/gm;

/** 轻量代码着色：注释 / 字符串 / 数字 / 关键字，其余原样。纯函数，便于单测。 */
export function highlightTokens(code: string, lang?: string): CodeToken[] {
  const keywords = KEYWORDS[(lang ?? "").toLowerCase()] ?? KEYWORDS.bash;
  const tokens: CodeToken[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(code)) !== null) {
    const [full, comment, str, num, word] = match;
    if (!full) continue;
    if (comment != null) tokens.push({ text: full, type: "comment" });
    else if (str != null) tokens.push({ text: full, type: "string" });
    else if (num != null) tokens.push({ text: full, type: "number" });
    else if (word != null && keywords.has(word)) tokens.push({ text: full, type: "keyword" });
    else tokens.push({ text: full, type: "plain" });
  }
  return tokens;
}

/** 严重性排序权重，用于台账默认排序（严重在前）。 */
export const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };