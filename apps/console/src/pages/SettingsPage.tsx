import { ChatApprovalSettings } from "../components/ChatApprovalSettings";
import type { ChatCatalog } from "@gongyuai/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Space, Toast, Typography } from "@douyinfe/semi-ui";
import { IconRefresh } from "@douyinfe/semi-icons";
import { api, type PublicSettings, type UsageStats } from "../api";
import type { SettingsSection } from "../labels";
import { SettingsAssetsPanel } from "./settings/SettingsAssetsPanel";
import { SettingsMcpPanel } from "./settings/SettingsMcpPanel";
import { SettingsModelPanel } from "./settings/SettingsModelPanel";
import { SettingsRuntimePanel } from "./settings/SettingsRuntimePanel";
import { SettingsSkillsPanel } from "./settings/SettingsSkillsPanel";
import { SettingsUpdatePanel } from "./settings/SettingsUpdatePanel";
import { SettingsUsagePanel } from "./settings/SettingsUsagePanel";
import { useSettingsUpdate } from "./settings/useSettingsUpdate";

const SETTINGS_DATA_SECTIONS = new Set<SettingsSection>(["assets", "mcp", "skills", "update"]);

export function SettingsPage({
  section,
  catalog,
  onCatalog,
  profileId,
  online,
  modelError,
}: {
  profileId?: string | null;
  section: SettingsSection;
  catalog: ChatCatalog | null;
  onCatalog: (value: ChatCatalog) => void;
  online?: boolean | null;
  modelError?: boolean;
}) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const needsSettings = SETTINGS_DATA_SECTIONS.has(section);
  const needsUsage = section === "usage";

  const reload = useCallback(async () => {
    if (!needsSettings && !needsUsage) return null;
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [s, u] = await Promise.all([
        needsSettings ? api.settings() : null,
        needsUsage ? api.usage(true) : null,
      ]);
      if (loadSeq.current !== seq) return null;
      if (s) setSettings(s.json);
      if (u) setUsage(u.json);
      return s?.json ?? null;
    } catch (e) {
      if (loadSeq.current === seq) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    } finally {
      if (loadSeq.current === seq) setLoading(false);
    }
  }, [needsSettings, needsUsage]);

  useEffect(() => {
    if (!needsSettings && !needsUsage) {
      setLoadError(null);
      return;
    }
    void reload().catch((e) => Toast.error(e instanceof Error ? e.message : String(e)));
  }, [reload, needsSettings, needsUsage]);

  useEffect(() => {
    if (online !== true) return;
    if ((needsSettings && !settings) || (needsUsage && !usage) || loadError) {
      void reload().catch(() => {});
    }
  }, [online, needsSettings, needsUsage, settings, usage, loadError, reload]);

  const update = useSettingsUpdate(settings, setSettings, reload);

  const renderLoadFallback = (loadingLabel: string) => {
    if (loadError) {
      return (
        <div role="alert">
          <Space vertical align="start">
            <Typography.Text type="danger">
              {online === false
                ? "后端服务当前离线，无法加载数据。服务恢复后会自动重试。"
                : `加载失败：${loadError}`}
            </Typography.Text>
            <Button
              icon={<IconRefresh />}
              loading={loading}
              onClick={() => void reload().catch((e) => Toast.error(e instanceof Error ? e.message : String(e)))}
            >
              重试
            </Button>
          </Space>
        </div>
      );
    }
    return <Typography.Text type="tertiary">{loadingLabel}</Typography.Text>;
  };

  if (section === "approval") {
    return <ChatApprovalSettings catalog={catalog} onCatalog={onCatalog} online={online} />;
  }

  if (section === "model") {
    return (
      <SettingsModelPanel
        catalog={catalog}
        onCatalog={onCatalog}
        profileId={profileId}
        online={online}
        modelError={modelError}
      />
    );
  }

  if (section === "runtime") {
    return <SettingsRuntimePanel />;
  }

  if (section === "usage") {
    if (!usage) return renderLoadFallback("加载用量…");
    return <SettingsUsagePanel usage={usage} loading={loading} reload={reload} />;
  }

  if (!settings) {
    return renderLoadFallback("加载设置…");
  }

  if (section === "assets") {
    return <SettingsAssetsPanel settings={settings} onSettings={setSettings} />;
  }

  if (section === "mcp") {
    return <SettingsMcpPanel settings={settings} onSettings={setSettings} />;
  }

  if (section === "skills") {
    return <SettingsSkillsPanel settings={settings} onSettings={setSettings} />;
  }

  if (section === "update") {
    return <SettingsUpdatePanel settings={settings} update={update} />;
  }

  return <SettingsRuntimePanel />;
}
