export type IntegrationKind = "skill" | "mcp";
export type IntegrationCounts = { calls: number; succeeded: number; failed: number };
export type IntegrationRow = IntegrationCounts & { kind: IntegrationKind; name: string; method: string };
export type TaskIntegrationUsage = { since: string | null; rows: IntegrationRow[] };
export type ProjectIntegrationUsage = { tracked: number; tasks: number; unreadable: number; rows: IntegrationRow[] };

export function totalIntegrationCalls(rows: IntegrationCounts[]): IntegrationCounts {
  return rows.reduce((total, row) => ({
    calls: total.calls + row.calls,
    succeeded: total.succeeded + row.succeeded,
    failed: total.failed + row.failed,
  }), { calls: 0, succeeded: 0, failed: 0 });
}

export function integrationSuccessRate(row: IntegrationCounts): string {
  const known = row.succeeded + row.failed;
  return known ? (100 * row.succeeded / known).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + "%" : "—";
}
