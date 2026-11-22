import { useState, type ReactNode } from "react";
import { Button, Space, Tag, Toast, Typography } from "@douyinfe/semi-ui";
import { api, type ReconcileResultPayload, type TaskRecord } from "../api";

/**
 * 事件台账里的 `adoptedReconcile`：首次通过当时采用的核算输入与结果。
 * 页面按时间倒序取第一条，因此这里展示的就是“判定当时有效的输入”。
 */
export type AdoptedReconcile = {
  path: string;
  sha256: string;
  name?: string;
  revisionId?: string;
  inputDigest?: string;
  configDigest?: string;
  baseline?: { path: string; sha256: string | null };
  current?: { path: string; sha256: string | null };
};

type Goal = TaskRecord["goals"][number];

type StateColor = "orange" | "red" | "blue" | "green" | "grey";

/** 核算态 → 标签文案与配色；操作员只读这一行就知道下一步该补材料还是重算。 */
const STATE_META: Record<string, { label: string; color: StateColor }> = {
  "missing-material": { label: "待补材料", color: "orange" },
  stale: { label: "待重算", color: "orange" },
  unsatisfied: { label: "结论不合格", color: "red" },
  ready: { label: "可判定", color: "blue" },
  passed: { label: "已通过", color: "green" },
  "no-result": { label: "待核算", color: "grey" },
};

/** 服务端 counts 带 ambiguous（重复主键歧义），控制台类型里尚未声明该字段。 */
type Counts = ReconcileResultPayload["result"]["counts"] & { ambiguous?: number };

type Props = {
  taskId: string;
  goal: Goal;
  /** 首次通过采用的核算输入（来自 goal_asserted 事件），未通过时为空。 */
  adopted?: AdoptedReconcile | null;
  /** 核算/判定结束后刷新：历史（核算态、事件台账）+ 任务本身。 */
  onChanged: () => Promise<void>;
};

function countsText(counts: Counts): string {
  return [
    `新增 ${counts.added}`,
    `移除 ${counts.removed}`,
    `变更 ${counts.changed}`,
    `未变 ${counts.unchanged}`,
    `缺件 ${counts.missing}`,
    `未知 ${counts.unknown}`,
    `歧义 ${counts.ambiguous ?? 0}`,
  ].join("、");
}

/**
 * 判定失败时服务端回 409，`request()` 抛的是响应体文本；能解析出 reason
 * 就按服务端原文展示，避免控制台自己改写结论。
 */
function failureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown; error?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason.trim()) return parsed.reason;
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
  } catch {
    /* 不是 JSON：原样展示服务端文本 */
  }
  return raw;
}

/** 小字段行：核算配置、失败原因、采用版本都按同一套排版读。 */
function Line({
  children,
  type = "tertiary",
  strong = false,
}: {
  children: ReactNode;
  type?: "tertiary" | "secondary" | "danger";
  strong?: boolean;
}) {
  return (
    <Typography.Text
      type={type}
      size="small"
      strong={strong}
      style={{ display: "block", marginTop: 4, lineHeight: 1.7 }}
    >
      {children}
    </Typography.Text>
  );
}

/**
 * 业务核算目标在“目标”页的紧凑卡片：建档时填的核算配置、当前核算态、
 * 两个动作（运行核算 / 触发判定）以及首次通过采用的输入版本。
 *
 * 结论一律来自服务端：卡片只负责把 counts、证据路径与哈希、拒绝原因原样
 * 呈现，不自己推断是否通过。
 */
export function GoalReconcileCard({ taskId, goal, adopted, onChanged }: Props) {
  const [runBusy, setRunBusy] = useState(false);
  const [assertBusy, setAssertBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{ counts: Counts; path: string; sha256: string } | null>(
    null,
  );
  const [serverReason, setServerReason] = useState<string | null>(null);

  const business = goal.business ?? null;
  const state = goal.reconcileState ?? null;
  const stateMeta = state ? STATE_META[state.state] : undefined;
  const busy = runBusy || assertBusy;

  const runReconcile = async () => {
    setRunBusy(true);
    setServerReason(null);
    try {
      const { json } = await api.reconcileGoal(taskId, goal.id);
      const counts: Counts = json.result.counts;
      setLastRun({ counts, path: json.evidencePath, sha256: json.evidenceSha256 });
      Toast.success({
        content: `核算完成：共 ${counts.totalKeys} 项（${countsText(counts)}）；结果 ${json.evidencePath} · SHA-256 ${json.evidenceSha256.slice(0, 16)}…`,
        duration: 8,
      });
      await onChanged();
    } catch (err) {
      const reason = failureReason(err);
      setServerReason(`核算失败：${reason}`);
      Toast.error({ content: `核算失败：${reason}`, duration: 8 });
    } finally {
      setRunBusy(false);
    }
  };

  const runAssert = async () => {
    setAssertBusy(true);
    try {
      const { json } = await api.assertGoal(taskId, goal.id);
      if (!json.ok) {
        const reason = json.reason?.trim() || "判定未通过（服务端未返回原因）";
        setServerReason(reason);
        Toast.error({ content: reason, duration: 8 });
      } else {
        setServerReason(null);
        Toast.success("判定通过：已按当前材料记录首次通过");
      }
    } catch (err) {
      const reason = failureReason(err);
      setServerReason(reason);
      Toast.error({ content: reason, duration: 8 });
    } finally {
      try {
        await onChanged();
      } catch {
        /* 刷新失败不改变本次判定结论，下一次轮询会再取一次 */
      }
      setAssertBusy(false);
    }
  };

  return (
    <div
      style={{
        marginTop: 8,
        padding: "10px 12px",
        border: "1px solid var(--semi-color-border)",
        borderRadius: 8,
        background: "var(--semi-color-fill-0)",
        fontSize: 12,
      }}
    >
      <Space wrap align="center" spacing={8}>
        <Tag color="violet" size="small">
          业务核算
        </Tag>
        <Typography.Text strong size="small">
          核算配置 · {business?.name ?? "缺失"}
        </Typography.Text>
        <Tag color={stateMeta?.color ?? "grey"} size="small">
          核算态 · {stateMeta?.label ?? "待核算"}
        </Tag>
        <Button
          size="small"
          theme="solid"
          loading={runBusy}
          disabled={!business || busy}
          onClick={() => void runReconcile()}
        >
          运行核算
        </Button>
        <Button
          size="small"
          type="primary"
          theme="light"
          loading={assertBusy}
          disabled={busy}
          onClick={() => void runAssert()}
        >
          触发判定
        </Button>
      </Space>

      {business ? (
        <>
          <Line>
            主键 {business.keyField} · 基线 {business.baseline.path} · 当前{" "}
            {business.current.path}
          </Line>
          <Line>
            阈值 未知项≤{business.maxUnknown} · 重复主键歧义≤{business.maxAmbiguous}
            {business.requiredKeys?.length
              ? ` · 约定检查项 ${business.requiredKeys.join("、")}`
              : ""}
          </Line>
        </>
      ) : (
        <Line type="danger">
          该目标声明为业务核算但缺少核算配置，无法按目标口径核算；请重新建档或改用完整核算口径。
        </Line>
      )}

      {state?.reason ? <Line type="secondary">核算态原因：{state.reason}</Line> : null}

      {state?.ambiguous?.length ? (
        <div style={{ marginTop: 4 }}>
          {state.ambiguous.map((item) => (
            <Line key={item.key} type="danger">
              冲突重复键 <Typography.Text strong>{item.key}</Typography.Text>
              （{item.reason}）· 来源行{" "}
              {item.lines
                .map((entry) =>
                  `${entry.material === "baseline" ? "基线" : "当前"} 第 ${
                    entry.endLine > entry.line ? `${entry.line}–${entry.endLine}` : entry.line
                  } 行`,
                )
                .join("、") || "未记录"}
            </Line>
          ))}
        </div>
      ) : null}

      {lastRun ? (
        <Line>
          最近一次核算：共 {lastRun.counts.totalKeys} 项（{countsText(lastRun.counts)}）· 结果{" "}
          {lastRun.path} · SHA-256 {lastRun.sha256}
        </Line>
      ) : null}

      {serverReason ? <Line type="danger">服务端原因：{serverReason}</Line> : null}

      {goal.passes && adopted ? (
        <>
          <Line strong>
            首次通过采用的输入版本：{adopted.revisionId ?? "—"}
            {adopted.name ? ` · 核算 ${adopted.name}` : ""}
          </Line>
          {adopted.inputDigest ? (
            <Line>
              输入摘要 {adopted.inputDigest}
              {adopted.configDigest ? ` · 口径摘要 ${adopted.configDigest}` : ""}
            </Line>
          ) : null}
          <Line>
            基线 {adopted.baseline?.path ?? "—"} · SHA-256 {adopted.baseline?.sha256 ?? "—"}
          </Line>
          <Line>
            当前 {adopted.current?.path ?? "—"} · SHA-256 {adopted.current?.sha256 ?? "—"}
          </Line>
          <Line>
            结果文件 {adopted.path} · SHA-256 {adopted.sha256}
          </Line>
        </>
      ) : null}
    </div>
  );
}
