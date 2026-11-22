/** Handoff vocabulary for the synthetic document-review reader. */
export const handoffRequest = [
  '写交接 JSON：{"memo":"其他新增事实和待核事项","withdrawals":[],"history":[]}。',
  'withdrawals 每项为 {"notice":"撤回意见的F编号","subject":"被撤回原记录的F编号","scope":"适用范围"}。分别核对两个编号，未出现撤回意见就留空数组。',
  'history 每项为 {"goal":"原目标","recorded":"passed|failed|unverified|unknown","recheck":"verifiable|unverifiable|unknown","source":"历史记录的F编号"}。按历史日志填写 recorded，单独判断现有原件能否复验。',
  '只记已读材料中的新增信息，未知编号填 null。没有相关历史目标就留空数组。笔记简短。',
].join("\n");

export const handoffLegend = "读交接时，notice 是发布撤回意见的编号，subject 是该意见撤回的原记录编号。recorded 保留历史日志所载状态，recheck 描述今天能否凭原版复验。按目标范围和新材料分别核对。";

export function ledgerNote(call, knownIds) {
  let note;
  try { note = JSON.parse(call.text); } catch { /* Keep malformed output available to the reader. */ }
  const id = (value) => value === null || knownIds.has(value);
  const valid = call.finish === "stop" && typeof note?.memo === "string"
    && Array.isArray(note.withdrawals) && note.withdrawals.every((w) =>
      w && id(w.notice) && id(w.subject) && typeof w.scope === "string" &&
      (w.subject === null || w.notice === null || w.subject !== w.notice))
    && Array.isArray(note.history) && note.history.every((h) =>
      h && typeof h.goal === "string" && id(h.source) &&
      ["passed","failed","unverified","unknown"].includes(h.recorded) &&
      ["verifiable","unverifiable","unknown"].includes(h.recheck));
  return { valid: Boolean(valid), text: valid ? JSON.stringify(note) : "未通过交接格式校验的原文：" + call.text };
}

/** Keep the order within each series, use each supplied row exactly once. */
export function sixBatches(facts, filingRows) {
  const slice = (items, i) => items.slice(Math.floor(i * items.length / 6), Math.floor((i + 1) * items.length / 6));
  return Array.from({ length: 6 }, (_, i) => [...slice(facts, i), ...slice(filingRows, i)]);
}
