/**
 * P17 — privilege-escalation / host enumeration parsers.
 *
 * The HostProfile object exists since P14, but the model had to fill it by hand.
 * These parsers turn common read-only enumeration output into a bounded draft:
 * OS/hostname/domain, users, privileges, services, shares and AV/EDR signals.
 *
 * Discipline:
 * - parsers only transport what is present; unknown stays empty, never guessed;
 * - arrays are deduped and bounded (200 entries; AV 50);
 * - every field is evidence-backed by the caller's `evidencePath`;
 * - a parser mismatch is a skip, not a fabricated profile.
 */


export type HostEnumParserId =
  | "linux-id"
  | "linux-uname"
  | "linux-os-release"
  | "linux-sudo"
  | "linux-capabilities"
  | "linux-listeners"
  | "windows-systeminfo"
  | "windows-whoami"
  | "windows-localgroup"
  | "windows-net-user"
  | "windows-net-share"
  | "windows-ipconfig"
  | "hostname"
  | "av-signal";

export type HostEnumDraft = {
  hostname?: string;
  os?: string;
  domain?: string;
  users: string[];
  privileges: string[];
  services: string[];
  shares: string[];
  av: string[];
};

export type HostEnumResult = {
  draft: HostEnumDraft;
  matched: HostEnumParserId[];
};

const MAX_ENTRIES = 200;
const MAX_AV = 50;
const AV_SIGNALS = [
  "Windows Defender",
  "Microsoft Defender",
  "CrowdStrike",
  "Falcon",
  "SentinelOne",
  "Carbon Black",
  "Symantec",
  "McAfee",
  "Trellix",
  "Kaspersky",
  "ESET",
  "Sophos",
  "Trend Micro",
  "Cylance",
  "Elastic Endgame",
  "Qualys",
  "Rapid7",
  "Osquery",
  "ClamAV",
];

const pushUnique = (target: string[], value: string) => {
  const clean = value.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!clean) return;
  if (!target.includes(clean)) target.push(clean);
};

const bounded = (values: string[], max = MAX_ENTRIES): string[] =>
  values.map((value) => value.trim()).filter(Boolean).slice(0, max);

const firstMatch = (text: string, re: RegExp): string | null => {
  const match = re.exec(text);
  return match?.[1]?.trim() || null;
};

function parseLinuxId(text: string, draft: HostEnumDraft): boolean {
  // uid=0(root) gid=0(root) groups=0(root),27(sudo)
  const uid = /^uid=\d+\(([^)]+)\)/m.exec(text);
  const gid = /^gid=\d+\(([^)]+)\)/m.exec(text);
  if (!uid && !gid) return false;
  if (uid?.[1]) {
    pushUnique(draft.users, uid[1]);
    if (uid[1] === "root") pushUnique(draft.privileges, "uid=0(root)");
  }
  if (gid?.[1] === "root") pushUnique(draft.privileges, "gid=0(root)");
  const groups = /groups=([^\n]+)/.exec(text)?.[1] ?? "";
  for (const group of groups.split(",")) {
    const name = group.trim().replace(/^\d+\(([^)]+)\)$/, "$1");
    if (name === "sudo" || name === "wheel" || name === "admin") {
      pushUnique(draft.privileges, `group:${name}`);
    }
  }
  return true;
}

function parseLinuxUname(text: string, draft: HostEnumDraft): boolean {
  const line = /^Linux\s+(\S+)\s+(\S+).*?\b(aarch64|x86_64|armv\d+l|i686)\b/m.exec(text);
  if (!line) return false;
  draft.hostname = draft.hostname ?? line[1]!;
  draft.os = draft.os ?? `Linux ${line[3]}`;
  return true;
}

function parseOsRelease(text: string, draft: HostEnumDraft): boolean {
  const pretty = firstMatch(text, /^PRETTY_NAME="?([^"\n]+)"?$/m);
  if (!pretty) return false;
  draft.os = pretty;
  return true;
}

function parseSudo(text: string, draft: HostEnumDraft): boolean {
  if (!/sudoers|may run the following commands|NOPASSWD/i.test(text)) return false;
  const rules = /^\s*\(([^)]+)\)\s+(NOPASSWD:\s*)?(.+)$/gm;
  let found = false;
  for (const match of text.matchAll(rules)) {
    const runAs = match[1]?.trim() ?? "ALL";
    const nopasswd = Boolean(match[2]);
    const command = match[3]?.trim() ?? "ALL";
    pushUnique(
      draft.privileges,
      `sudo:${runAs}:${nopasswd ? "NOPASSWD:" : ""}${command}`.slice(0, 180),
    );
    found = true;
  }
  if (!found && /NOPASSWD/i.test(text)) pushUnique(draft.privileges, "sudo:NOPASSWD");
  return true;
}

function parseCapabilities(text: string, draft: HostEnumDraft): boolean {
  const re = /^(\S+)\s*=?\s*(cap_[a-z_]+(?:[=+][a-z_+]+)?)/gm;
  let found = false;
  for (const match of text.matchAll(re)) {
    pushUnique(draft.privileges, `cap:${match[2]}:${match[1]}`.slice(0, 200));
    found = true;
  }
  return found;
}

function parseListeners(text: string, draft: HostEnumDraft): boolean {
  if (!/LISTEN|ESTAB/i.test(text) || !/:\d{2,5}\b/.test(text)) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!/LISTEN/i.test(line)) continue;
    const port = /(?:0\.0\.0\.0|\[::\]|127\.0\.0\.1|\*|[\w.-]+):(\d{2,5})\b/.exec(line);
    if (!port) continue;
    const proc = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? "";
    pushUnique(draft.services, `${proc || "tcp"}/${port[1]}`);
  }
  return draft.services.length > 0;
}

function parseWindowsSysteminfo(text: string, draft: HostEnumDraft): boolean {
  if (!/OS Name:/i.test(text) || !/System Boot Time|OS Version:/i.test(text)) return false;
  draft.os = firstMatch(text, /^OS Name:\s*(.+)$/im) ?? draft.os;
  draft.hostname = firstMatch(text, /^Host Name:\s*(.+)$/im) ?? draft.hostname;
  draft.domain = firstMatch(text, /^Domain:\s*(.+)$/im) ?? draft.domain;
  return true;
}

function parseWindowsWhoami(text: string, draft: HostEnumDraft): boolean {
  if (!/USER INFORMATION|GROUP INFORMATION|PRIVILEGES INFORMATION/i.test(text)) return false;
  const user = firstMatch(text, /^([A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+)\s{2,}S-1-/m);
  if (user) {
    pushUnique(draft.users, user.split("\\").pop() ?? user);
    const domain = user.includes("\\") ? user.split("\\")[0] : "";
    // A NetBIOS short name must not overwrite a FQDN from systeminfo/ipconfig.
    if (domain && (!draft.domain || draft.domain.length < domain.length)) {
      draft.domain = domain;
    }
  }
  const groupsBlock = /GROUP INFORMATION[\s\S]*?(?=PRIVILEGES INFORMATION|$)/i.exec(text)?.[0] ?? "";
  for (const line of groupsBlock.split(/\r?\n/)) {
    const group = /^(.+?)\s{2,}Group\s{2,}/i.exec(line)?.[1]?.trim();
    if (group && group !== "Group Name") {
      pushUnique(draft.privileges, `group:${group}`);
      if (/administrators|domain admins|enterprise admins|schema admins/i.test(group)) {
        pushUnique(draft.privileges, `admin:${group}`);
      }
    }
  }
  const privBlock = /PRIVILEGES INFORMATION[\s\S]*$/i.exec(text)?.[0] ?? "";
  for (const line of privBlock.split(/\r?\n/)) {
    const priv = /^(Se[A-Za-z]+Privilege)\s+/i.exec(line)?.[1];
    if (priv) pushUnique(draft.privileges, `winpriv:${priv}`);
  }
  return true;
}

function parseLocalGroup(text: string, draft: HostEnumDraft): boolean {
  if (!/Alias name|Local Group Members|localgroup/i.test(text)) return false;
  const members = /Members\s*\n-+\n([\s\S]*?)(?:\n\s*\n|$)/i.exec(text)?.[1] ?? "";
  for (const line of members.split(/\r?\n/)) {
    const member = line.trim();
    if (!member || /^The command completed/i.test(member)) continue;
    if (/^[A-Za-z0-9._-]+$/i.test(member) || member.includes("\\")) {
      pushUnique(draft.users, member.split("\\").pop() ?? member);
    }
  }
  return true;
}

function parseNetUserTable(text: string, draft: HostEnumDraft): boolean {
  if (!/User accounts for|The command completed successfully/i.test(text)) return false;
  const block = text.split(/^-{3,}\s*$/m);
  if (block.length < 2) return false;
  for (const line of block.slice(1).join("\n").split(/\r?\n/)) {
    for (const account of line.trim().split(/\s{2,}/)) {
      if (/^[A-Za-z0-9._$-]{1,64}$/.test(account) && !/^The command/i.test(account)) {
        pushUnique(draft.users, account);
      }
    }
  }
  return true;
}

function parseNetShare(text: string, draft: HostEnumDraft): boolean {
  if (!/Share name\s+Resource\s+Remark|共享名/i.test(text)) return false;
  for (const line of text.split(/\r?\n/)) {
    const name = /^([A-Za-z0-9._$-]+)\s{2,}/.exec(line)?.[1];
    if (!name || /^(Share name|The command)/i.test(name)) continue;
    pushUnique(draft.shares, name);
  }
  return true;
}

function parseIpconfig(text: string, draft: HostEnumDraft): boolean {
  const suffix = firstMatch(text, /Primary Dns Suffix[ .]*:\s*(.+)$/im);
  if (!suffix) return false;
  draft.domain = draft.domain ?? suffix;
  return true;
}

function parseHostname(text: string, draft: HostEnumDraft): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 253) return false;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(trimmed)) return false;
  draft.hostname = draft.hostname ?? trimmed;
  return true;
}

function parseAvSignals(text: string, draft: HostEnumDraft): boolean {
  let found = false;
  for (const signal of AV_SIGNALS) {
    if (new RegExp(signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
      pushUnique(draft.av, signal);
      found = true;
    }
  }
  return found;
}

/**
 * Pure, deterministic. Multiple formats can be present in one blob; the union
 * is returned with the parser ids that matched. No matched parser = empty draft.
 */
export function parseHostEnumeration(text: string): HostEnumResult {
  const draft: HostEnumDraft = {
    users: [],
    privileges: [],
    services: [],
    shares: [],
    av: [],
  };
  const matched: HostEnumParserId[] = [];
  const run = (id: HostEnumParserId, parser: () => boolean) => {
    try {
      if (parser()) matched.push(id);
    } catch {
      /* a parser failure must not abort the rest */
    }
  };

  run("linux-id", () => parseLinuxId(text, draft));
  run("linux-uname", () => parseLinuxUname(text, draft));
  run("linux-os-release", () => parseOsRelease(text, draft));
  run("linux-sudo", () => parseSudo(text, draft));
  run("linux-capabilities", () => parseCapabilities(text, draft));
  run("linux-listeners", () => parseListeners(text, draft));
  run("windows-systeminfo", () => parseWindowsSysteminfo(text, draft));
  run("windows-whoami", () => parseWindowsWhoami(text, draft));
  run("windows-localgroup", () => parseLocalGroup(text, draft));
  run("windows-net-user", () => parseNetUserTable(text, draft));
  run("windows-net-share", () => parseNetShare(text, draft));
  run("windows-ipconfig", () => parseIpconfig(text, draft));
  run("av-signal", () => parseAvSignals(text, draft));
  // Hostname only when it is the whole input; avoids treating every single-line
  // command output as a host name.
  run("hostname", () => !/\n/.test(text.trim()) && parseHostname(text, draft));

  return {
    draft: {
      ...(draft.hostname ? { hostname: draft.hostname } : {}),
      ...(draft.os ? { os: draft.os } : {}),
      ...(draft.domain ? { domain: draft.domain } : {}),
      users: bounded(draft.users),
      privileges: bounded(draft.privileges),
      services: bounded(draft.services),
      shares: bounded(draft.shares),
      av: bounded(draft.av, MAX_AV),
    },
    matched,
  };
}
