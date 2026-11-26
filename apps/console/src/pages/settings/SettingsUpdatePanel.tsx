import { Button, Form, Progress } from "@douyinfe/semi-ui";
import { IconBox, IconDownloadStroked } from "@douyinfe/semi-icons";
import type { PublicSettings } from "../../api";
import { formatDateTime } from "../../time";
import type { SettingsUpdateController } from "./useSettingsUpdate";

export function SettingsUpdatePanel({
  settings,
  update,
}: {
  settings: PublicSettings;
  update: SettingsUpdateController;
}) {
  const { updating, updateStatus, phase, updateFormApi, saveUpdateCfg, runSilentUpdate } = update;

    const showProgress = updating || phase === "failed" || phase === "done" || phase === "restarting";
    const progress: Record<string, number> = { done: 100, restarting: 90, building: 70, overlay: 50, extracting: 30 };
    return <div className="gy-settings-stack gy-update-page">
      <section className="gy-config-card gy-release">
        <div className="gy-release-line">
          <div className="gy-release-icon"><IconBox size="extra-large" aria-hidden="true" /></div>
          <div className="gy-release-version"><span>当前版本</span><h2>GongYuAI <strong>v{settings.version}</strong></h2></div>
          <Button theme="solid" icon={<IconDownloadStroked />} loading={updating}
            onClick={() => void runSilentUpdate()}>{updating ? "正在更新" : "一键更新"}</Button>
        </div>
        <p className="gy-release-note">从指定分支获取更新，完成后自动重启服务。</p>
        {(settings.update.lastUpdatedAt || settings.update.lastCommit) && <div className="gy-release-meta">
          {settings.update.lastUpdatedAt && <span>上次更新　{formatDateTime(settings.update.lastUpdatedAt, true)}</span>}
          {settings.update.lastCommit && <span>提交　<code>{settings.update.lastCommit.slice(0, 12)}</code></span>}
        </div>}
        {showProgress && <div className="gy-release-status" role={phase === "failed" ? "alert" : "status"}>
          {phase !== "failed" && <Progress percent={progress[phase ?? ""] ?? 15} showInfo aria-label="更新进度" />}
          <span>{updateStatus?.message || "准备更新…"} {updateStatus?.commit?.slice(0, 12)}</span>
          {phase === "failed" && updateStatus?.error && <pre>{updateStatus.error}</pre>}
        </div>}
      </section>
      <section className="gy-config-card gy-source">
        <h2>更新来源</h2>
        <Form labelPosition="top" getFormApi={form => { updateFormApi.current = form; }}
          initValues={{ githubUrl: settings.update.githubUrl, branch: settings.update.branch }}
          onSubmit={v => { void saveUpdateCfg(v).catch(() => {}); }}>
          <div className="gy-update-fields">
            <Form.Input field="githubUrl" label="仓库地址" placeholder="https://github.com/Sycun/GongYuAI" />
            <Form.Input field="branch" label="分支" placeholder="main" />
          </div>
          <Button htmlType="submit" type="tertiary" disabled={updating}>保存更新源</Button>
        </Form>
      </section>
    </div>;
}
