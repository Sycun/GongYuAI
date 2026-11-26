/** 纯参数解析。不读文件、不发请求。`parseGlobal` 仅在未传入 env 时读取 `process.env`。 */

export type GlobalOpts = {
  dataDir: string;
  host: string;
  port: number;
  baseUrl?: string;
};

export function parseGlobal(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; rest: string[]; opts: GlobalOpts } {
  const opts: GlobalOpts = {
    // Empty → control-plane resolves to <installRoot>/.gongyuai (never cwd-relative).
    dataDir: env.GY_DATA_DIR ?? "",
    host: env.GY_HOST ?? "127.0.0.1",
    port: Number(env.GY_PORT ?? 8877),
  };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") continue;
    if (token === "--data-dir") opts.dataDir = argv[++i]!;
    else if (token === "--host") opts.host = argv[++i]!;
    else if (token === "--port") opts.port = Number(argv[++i]);
    else if (token === "--base-url") opts.baseUrl = argv[++i]!;
    else out.push(token);
  }
  const cmd = out[0] ?? "help";
  return { cmd, rest: out.slice(1), opts };
}

/** Positional args, skipping `--flag value` pairs. */
export function positional(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Collect repeated --flag value pairs (e.g. multiple --target). */
export function flags(rest: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === name && rest[i + 1]) {
      out.push(rest[++i]!);
    }
  }
  return out;
}

export function flag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  return rest[index + 1];
}

export function has(rest: string[], name: string): boolean {
  return rest.includes(name);
}

export function parseHeaderFlag(raw: string): [string, string] {
  const idx = raw.indexOf(":");
  if (idx <= 0) throw new Error(`--header must be "Name: Value" (got ${raw})`);
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (!name || !value) throw new Error(`--header must be "Name: Value" (got ${raw})`);
  return [name, value];
}
