/** 控制台时间展示统一为北京时间（UTC+8）。 */

const LOCAL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const BEIJING_OFFSET_MS = 8 * 3600_000;

export function parseTime(s: string): number {
  if (!s) return 0;
  if (LOCAL_RE.test(s)) {
    const t = Date.parse(s.replace(" ", "T") + "+08:00");
    return Number.isFinite(t) ? t : 0;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO / 本地串 → `YYYY-MM-DD HH:mm` 或带秒 */
export function formatDateTime(at: string | null | undefined, withSeconds = false): string {
  if (!at) return "—";
  if (LOCAL_RE.test(at)) {
    return withSeconds ? (at.length >= 19 ? at.slice(0, 19) : `${at.slice(0, 16)}:00`) : at.slice(0, 16);
  }
  const ms = parseTime(at);
  if (!ms) return at;
  const t = new Date(ms + BEIJING_OFFSET_MS);
  const base = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(t.getUTCSeconds())}` : base;
}
