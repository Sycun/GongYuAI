/**
 * 原始材料差异核算的正常入口实现（验收项 2 + 第八轮）。
 *
 * 只读取操作员通过 `POST /tasks/:id/evidence` 导入的原始记录、按业务字段
 * 计算差异，并把核算结果本身写成一份带 SHA-256 的证据与一条 Fact。这里
 * 不接触任何“预期结果”：预期由验收端另行封存后逐项比对。
 *
 * 第八轮：每次核算都由 `HistoryStore.archiveReconcile` 归档成一个**核算版本**
 * ——版本号、对应目标、两侧材料内容哈希、核算口径摘要与结果文件哈希一起落库。
 * 首次判定只认这条归档记录，因此“用旧合格文件撑过一次首次通过”不再成立。
 */
import { openHistory } from "@gongyuai/history";
import {
  GoalReconcileRequestSchema,
  ReconcileRequestSchema,
  businessConfigFromRequest,
  reconcileConfigDigest,
  type BusinessReconcileConfig,
  type ReconcileResult,
  type ReconcileRevision,
} from "@gongyuai/contracts";
import { taskPaths } from "./paths.js";

export type ReconcileMaterialState = {
  path: string;
  present: boolean;
  sha256: string | null;
};

export type ReconcileOutcome = {
  result: ReconcileResult;
  /** 核算结果在 evidence/ 下的相对路径。 */
  evidencePath: string;
  evidenceSha256: string;
  factId: string | null;
  /** 本次核算的版本身份（判定时用它核对输入）。 */
  revision: ReconcileRevision;
  materials: { baseline: ReconcileMaterialState; current: ReconcileMaterialState };
};

/** 业务配置 → 核算请求：口径完全来自目标建档时持久化的那一份。 */
function requestFromConfig(goalId: string, config: BusinessReconcileConfig) {
  return {
    name: config.name,
    baseline: {
      path: config.baseline.path,
      ...(config.baseline.format ? { format: config.baseline.format } : {}),
      ...(config.baseline.keyField ? { keyField: config.baseline.keyField } : {}),
    },
    current: {
      path: config.current.path,
      ...(config.current.format ? { format: config.current.format } : {}),
      ...(config.current.keyField ? { keyField: config.current.keyField } : {}),
    },
    keyField: config.keyField,
    ...(config.compareFields?.length ? { compareFields: config.compareFields } : {}),
    ...(config.requiredKeys?.length ? { requiredKeys: config.requiredKeys } : {}),
    goalIds: [goalId],
  };
}

/**
 * 解析核算请求：可以给完整口径（手动核算），也可以只给 `goalId`
 * （按目标建档时持久化的配置核算，操作员不用手抄路径）。
 */
export function resolveReconcileRequest(
  taskId: string,
  dataDir: string,
  input: unknown,
): { request: ReturnType<typeof ReconcileRequestSchema.parse>; goalIds: string[] } {
  const goalScoped = GoalReconcileRequestSchema.safeParse(input);
  if (goalScoped.success) {
    const { historyDb, evidenceDir } = taskPaths(dataDir);
    const history = openHistory({ dbPath: historyDb, evidenceDir, readOnly: true });
    try {
      const goal = history.listGoals(taskId).find((entry) => entry.id === goalScoped.data.goalId);
      if (!goal) throw new Error(`unknown goal: ${goalScoped.data.goalId}`);
      if (!goal.business) {
        throw new Error(
          `目标 ${goal.id} 没有业务核算配置（不是业务核算目标），请用完整核算口径请求`,
        );
      }
      return {
        request: ReconcileRequestSchema.parse(requestFromConfig(goal.id, goal.business)),
        goalIds: [goal.id],
      };
    } finally {
      history.close();
    }
  }

  const request = ReconcileRequestSchema.parse(input);
  const goalIds = [...new Set(request.goalIds ?? [])];
  if (goalIds.length) {
    const { historyDb, evidenceDir } = taskPaths(dataDir);
    const history = openHistory({ dbPath: historyDb, evidenceDir, readOnly: true });
    try {
      const goals = history.listGoals(taskId);
      for (const goalId of goalIds) {
        const goal = goals.find((entry) => entry.id === goalId);
        if (!goal) throw new Error(`unknown goal: ${goalId}`);
        if (goal.business) {
          // 业务目标的核算必须按目标声明跑，避免“另跑一份口径”冒充目标结论。
          // 口径比较用同一份摘要函数，不比较 JSON 键序。
          const expected = ReconcileRequestSchema.parse(requestFromConfig(goal.id, goal.business));
          if (
            reconcileConfigDigest(businessConfigFromRequest(expected)) !==
            reconcileConfigDigest(businessConfigFromRequest(request))
          ) {
            throw new Error(
              `核算口径与目标 ${goal.id} 的声明不一致：目标要求 name=${goal.business.name}、` +
                `keyField=${goal.business.keyField}、基线 ${goal.business.baseline.path}、` +
                `当前 ${goal.business.current.path}；请用 {goalId} 走目标配置核算`,
            );
          }
        }
      }
    } finally {
      history.close();
    }
  }
  return { request, goalIds };
}

export function runReconcile(
  taskId: string,
  dataDir: string,
  input: unknown,
): ReconcileOutcome {
  const { historyDb, evidenceDir } = taskPaths(dataDir);
  const { request, goalIds } = resolveReconcileRequest(taskId, dataDir, input);

  const history = openHistory({ dbPath: historyDb, evidenceDir });
  try {
    const archived = history.archiveReconcile({ taskId, request, goalIds });
    return {
      result: archived.result,
      evidencePath: archived.evidencePath,
      evidenceSha256: archived.evidenceSha256,
      factId: archived.factId,
      revision: archived.revision,
      materials: {
        baseline: {
          path: archived.revision.baseline.path,
          present: archived.revision.baseline.present,
          sha256: archived.revision.baseline.sha256,
        },
        current: {
          path: archived.revision.current.path,
          present: archived.revision.current.present,
          sha256: archived.revision.current.sha256,
        },
      },
    };
  } finally {
    history.close();
  }
}
