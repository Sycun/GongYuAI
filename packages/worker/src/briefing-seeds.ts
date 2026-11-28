import type { WorkerManifest } from "@gongyuai/contracts";

/**
 * P18 — grey-box delegation seeds.
 *
 * Real engagements often start with client-provided identities (`工号`, test
 * accounts, demo tokens) and explicit business entry points. This pure extractor
 * pulls them out of `auth.roe` / `auth.authorizationNote` / goal descriptions so
 * the first Explore turn verifies the known account instead of blind guessing.
 * Extraction is best-effort hints, never authorization.
 */

export type BriefingAccount = { label: string; hint: string };
export type BriefingSeeds = { accounts: BriefingAccount[]; endpoints: string[] };

const MAX_ACCOUNTS = 6;
const MAX_ENDPOINTS = 8;

const ACCOUNT_PATTERNS: Array<{ label: string; re: RegExp; user: number; pass?: number }> = [
  { label: "账号/密码", re: /账\s*号\s*[:：]\s*([^\s,，;；)）]+)\s*[,，;；\s]+密\s*码\s*[:：]\s*([^\s,，;；)）]+)/g, user: 1, pass: 2 },
  { label: "用户/口令", re: /(?:用户名|用户)\s*[:：]\s*([^\s,，;；)）]+)\s*[,，;；\s]+(?:密码|口令)\s*[:：]\s*([^\s,，;；)）]+)/g, user: 1, pass: 2 },
  { label: "工号", re: /工\s*号\s*[:：]?\s*([A-Za-z0-9_-]{2,32})(?:\s*[,，/／;；]?\s*(?:密码|口令)\s*[:：]?\s*([^\s,，;；)）]+))?/g, user: 1, pass: 2 },
  { label: "测试账号", re: /(?:测试账号|测试用户|演示账号|demo\s*account)\s*[:：]\s*([^\s,，;；)）]+)(?:\s*[,，/／;；]?\s*(?:密码|口令)\s*[:：]?\s*([^\s,，;；)）]+))?/gi, user: 1, pass: 2 },
  { label: "user/pass", re: /\b(?:user(?:name)?)\s*[:=]\s*([^\s,;)]+)[\s,;]+pass(?:word)?\s*[:=]\s*([^\s,;)]+)/gi, user: 1, pass: 2 },
];

const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/-]{8,}=*)/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>()（）]+/g;
const PATH_PATTERN = /(?:^|[\s（(【[,，;；])(\/[A-Za-z0-9][A-Za-z0-9._~/-]{1,120})/g;

function clean(value: string): string {
  return value.replace(/[。，,;；:：、)\]】）"'<>]+$/g, "").trim();
}

function maskToken(token: string): string {
  const head = token.slice(0, 6);
  return `${head}…（${token.length} 字符，按委托给定 Token 直接使用，禁止写进 Fact/聊天）`;
}

function collectTexts(manifest: WorkerManifest): string[] {
  const texts: string[] = [];
  if (manifest.auth.roe) texts.push(manifest.auth.roe);
  if (manifest.auth.authorizationNote) texts.push(manifest.auth.authorizationNote);
  for (const goal of manifest.goals ?? []) {
    texts.push(`${goal.title} ${goal.description}`);
  }
  return texts.filter((text) => text.trim().length > 0);
}

export function extractBriefingSeeds(manifest: WorkerManifest): BriefingSeeds {
  const accounts: BriefingAccount[] = [];
  const endpoints: string[] = [];
  const seenAccounts = new Set<string>();
  const seenEndpoints = new Set<string>();
  const addAccount = (label: string, user: string, pass?: string): void => {
    const account = clean(user);
    if (!account) return;
    const password = pass ? clean(pass) : "";
    const hint = password ? `${account} / ${password}` : account;
    const key = hint.toLowerCase();
    if (seenAccounts.has(key)) return;
    seenAccounts.add(key);
    accounts.push({ label, hint });
  };

  for (const text of collectTexts(manifest)) {
    for (const { label, re, user, pass } of ACCOUNT_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        addAccount(label, match[user] ?? "", pass === undefined ? undefined : match[pass]);
      }
    }
    BEARER_PATTERN.lastIndex = 0;
    let bearer: RegExpExecArray | null;
    while ((bearer = BEARER_PATTERN.exec(text)) !== null) {
      const token = clean(bearer[1] ?? "");
      if (!token) continue;
      const key = `Bearer::${token}`;
      if (seenAccounts.has(key)) continue;
      seenAccounts.add(key);
      accounts.push({ label: "Bearer", hint: maskToken(token) });
    }
  }

  for (const text of collectTexts(manifest)) {
    URL_PATTERN.lastIndex = 0;
    let url: RegExpExecArray | null;
    while ((url = URL_PATTERN.exec(text)) !== null) {
      const value = clean(url[0]);
      if (!value || seenEndpoints.has(value)) continue;
      seenEndpoints.add(value);
      endpoints.push(value);
    }
    PATH_PATTERN.lastIndex = 0;
    let path: RegExpExecArray | null;
    while ((path = PATH_PATTERN.exec(text)) !== null) {
      const value = clean(path[1] ?? "");
      if (!value || value.includes("://") || seenEndpoints.has(value)) continue;
      if (endpoints.some((entry) => entry.endsWith(value))) continue;
      seenEndpoints.add(value);
      endpoints.push(value);
    }
  }

  return {
    accounts: accounts.slice(0, MAX_ACCOUNTS),
    endpoints: endpoints.slice(0, MAX_ENDPOINTS),
  };
}

/**
 * Prompt block injected into the Observe guidance area. Renders only when the
 * delegation text actually carries identities.
 */
export function renderBriefingSeedsBlock(manifest: WorkerManifest): string {
  const seeds = extractBriefingSeeds(manifest);
  if (seeds.accounts.length === 0) return "";
  const lines = ["[灰盒委托预置身份与多角色基线纪律]"];
  seeds.accounts.forEach((account, index) => {
    lines.push(`- 预置身份 ${index + 1}（${account.label}）：${account.hint}`);
  });
  if (seeds.endpoints.length) {
    lines.push(`- 委托给定业务入口：${seeds.endpoints.join("、")}`);
  }
  lines.push(
    "首轮必须优先用上述预置身份实测登录与鉴权边界：受信角色建命名会话 `http_request(session=\"role_user\")`，" +
      "匿名对照 `http_request(session=\"anon\")`，对同一业务对象做越权差分（IDOR/BOLA/BFLA）；" +
      "严禁放着已知工号/账号不用去当黑盒盲猜弱口令或绕过登录。认证成功后用 credential_record 登记指针，" +
      "跨主机复用前先 credential_list，验证结果用 credential_use(action=\"verify\") 回写矩阵。",
  );
  return lines.join("\n");
}