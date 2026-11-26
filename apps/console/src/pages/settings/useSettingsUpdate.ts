import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Toast } from "@douyinfe/semi-ui";
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form/interface";
import { api, type PublicSettings, type UpdateJobStatus } from "../../api";

const UPDATE_RECONNECT_MS = 180_000;

export type SettingsUpdateController = {
  updating: boolean;
  updateStatus: UpdateJobStatus | null;
  phase: string | undefined;
  updateFormApi: MutableRefObject<FormApi | null>;
  saveUpdateCfg: (
    values: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ) => Promise<PublicSettings>;
  runSilentUpdate: () => Promise<void>;
};

/** 更新任务状态挂在设置页上，切换分区时轮询不中断。 */
export function useSettingsUpdate(
  settings: PublicSettings | null,
  onSettings: (next: PublicSettings) => void,
  reload: () => Promise<PublicSettings | null>,
): SettingsUpdateController {
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateJobStatus | null>(null);
  const updateFormApi = useRef<FormApi | null>(null);
  const updateStartedAt = useRef(0);
  const lastCommitBeforeUpdate = useRef<string | null>(null);

  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const r = await api.updateStatus();
          setUpdateStatus(r.json);
          if (r.json.phase === "done") {
            setUpdating(false);
            const msg =
              r.json.message === "已是最新" ? "已是最新，无需重启" : "更新完成，即将刷新";
            Toast.success(msg);
            void reload();
            if (r.json.message !== "已是最新") {
              window.setTimeout(() => window.location.reload(), 1200);
            }
            return;
          }
          if (r.json.phase === "failed") {
            setUpdating(false);
            Toast.error(r.json.message || "更新失败");
            return;
          }
          // After restart the new process hydrates to done; also accept lastCommit flip.
          if (r.json.phase === "restarting" || r.json.phase === "building") {
            try {
              const s = await api.settings();
              const next = s.json.update.lastCommit;
              if (
                next &&
                lastCommitBeforeUpdate.current &&
                next !== lastCommitBeforeUpdate.current
              ) {
                setUpdating(false);
                setUpdateStatus({
                  ...r.json,
                  phase: "done",
                  message: "已更新",
                });
                Toast.success("更新完成，即将刷新");
                void reload();
                window.setTimeout(() => window.location.reload(), 1200);
              }
            } catch {
              /* still restarting */
            }
          }
        } catch {
          // restart may drop connection — keep polling quietly
          if (Date.now() - updateStartedAt.current > UPDATE_RECONNECT_MS) {
            setUpdating(false);
            Toast.error("重启超时，请查看 /tmp/gy-serve.log");
          }
        }
      })();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [updating, reload]);

  const saveUpdateCfg = async (
    values: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ) => {
    try {
      const r = await api.saveUpdateCfg({
        githubUrl: String(values.githubUrl ?? ""),
        branch: String(values.branch ?? "main"),
      });
      onSettings(r.json);
      if (!opts?.quiet) Toast.success("更新源已保存");
      return r.json;
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const runSilentUpdate = async () => {
    if (!settings) return;
    const values =
      updateFormApi.current?.getValues?.() ??
      ({
        githubUrl: settings.update.githubUrl,
        branch: settings.update.branch,
      } as Record<string, unknown>);
    lastCommitBeforeUpdate.current = settings.update.lastCommit;
    updateStartedAt.current = Date.now();
    setUpdating(true);
    setUpdateStatus(null);
    try {
      await saveUpdateCfg(values, { quiet: true });
      const r = await api.runUpdate();
      setUpdateStatus(r.json);
      if (r.json.phase === "done") {
        setUpdating(false);
        const msg =
          r.json.message === "已是最新" ? "已是最新，无需重启" : "更新完成，即将刷新";
        Toast.success(msg);
        void reload();
        if (r.json.message !== "已是最新") {
          window.setTimeout(() => window.location.reload(), 1200);
        }
      } else if (r.json.phase === "failed") {
        setUpdating(false);
        Toast.error(r.json.message || "更新失败");
      }
    } catch (e) {
      setUpdating(false);
      Toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return {
    updating,
    updateStatus,
    phase: updateStatus?.phase,
    updateFormApi,
    saveUpdateCfg,
    runSilentUpdate,
  };
}
