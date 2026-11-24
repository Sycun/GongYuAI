/**
 * DeepSeek 原生工具调用标记（DSML）兜底解析。
 *
 * 部分端点/模型组合会把工具调用写进正文（`<｜｜DSML｜｜ invoke ...>`）而不是
 * OpenAI 风格的 tool_calls。聊天任务处理器与 π 循环共用本解析器，把可见
 * 标记还原成调用意图；无法解析时调用方应显式报错，绝不把标记当正文结果。
 */
export type DsmlCall = { name: string; args: Record<string, string> };

export function hasDsmlMarkup(text: string): boolean {
  return text.includes("｜｜DSML｜｜");
}

export function parseDsmlCalls(text: string): DsmlCall[] {
  const invoke = /<｜｜DSML｜｜\s*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*invoke\s*>/g;
  const param = /<｜｜DSML｜｜\s*parameter\s+name="([^"]+)"(?:\s+string="[^"]*")?[^>]*>([\s\S]*?)<\/｜｜DSML｜｜\s*parameter\s*>/g;
  const calls: DsmlCall[] = [];
  for (const m of text.matchAll(invoke)) {
    const args: Record<string, string> = {};
    for (const p of m[2]!.matchAll(param)) args[p[1]!.trim()] = p[2]!.trim();
    calls.push({ name: m[1]!.trim(), args });
  }
  return calls;
}