import { useState } from "react";
import { Button, Space, Toast, Typography } from "@douyinfe/semi-ui";
import { IconRefresh } from "@douyinfe/semi-icons";
import type { ChatCatalog } from "@gongyuai/contracts";
import { ChatModelSettings } from "../../components/ChatModelSettings";
import { api } from "../../api";

export function SettingsModelPanel({
  catalog,
  onCatalog,
  profileId,
  online,
  modelError,
}: {
  profileId?: string | null;
  catalog: ChatCatalog | null;
  onCatalog: (value: ChatCatalog) => void;
  online?: boolean | null;
  modelError?: boolean;
}) {
  const [reloadingModels, setReloadingModels] = useState(false);

    const retryModels = () => {
      setReloadingModels(true);
      void api
        .chatModels()
        .then((r) => onCatalog(r.json))
        .catch(() => Toast.error("无法读取模型配置"))
        .finally(() => setReloadingModels(false));
    };
    return (
      <div className="gy-settings-stack">
        {catalog ? (
          <ChatModelSettings key={profileId} catalog={catalog} initialId={profileId} onSaved={onCatalog} />
        ) : (
          <div role="status">
            <Space vertical align="start">
              <Typography.Text type={modelError || online === false ? "danger" : "tertiary"}>
                {online === false
                  ? "无法连接后端服务，暂时无法读取模型配置。服务恢复后会自动重试。"
                  : modelError
                    ? "读取模型配置失败，请重试。"
                    : "正在读取模型配置…"}
              </Typography.Text>
              {(modelError || online === false) && (
                <Button icon={<IconRefresh />} loading={reloadingModels} onClick={retryModels}>
                  重新读取对话模型
                </Button>
              )}
            </Space>
          </div>
        )}
      </div>
    );
}
