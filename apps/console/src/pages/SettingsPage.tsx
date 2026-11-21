import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Col,
  Form,
  Progress,
  Row,
  Space,
  Table,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import { IconRefresh, IconSave, IconLink } from "@douyinfe/semi-icons";
import { api, type PublicSettings, type UsageStats, type UpdateJobStatus } from "../api";
import type { SettingsSection } from "../labels";

function formatNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateJobStatus | null>(null);

  const reload = useCallback(async () => {
    const [s, u] = await Promise.all([api.settings(), api.usage()]);
    setSettings(s.json);
    setUsage(u.json);
  }, []);

  useEffect(() => {
    void reload().catch((e) => Toast.error(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(() => {
      void api
        .updateStatus()
        .then((r) => {
          setUpdateStatus(r.json);
          if (r.json.phase === "done") {
            setUpdating(false);
            Toast.success("已静默更新完成");
            void reload();
            window.setTimeout(() => window.location.reload(), 1200);
          }
          if (r.json.phase === "failed") {
            setUpdating(false);
            Toast.error(r.json.error || r.json.message || "更新失败");
          }
        })
        .catch(() => {
          // restart may drop connection — keep polling quietly
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [updating, reload]);

  if (!settings) {
    return <Typography.Text type="tertiary">加载设置…</Typography.Text>;
  }

  const saveModel = async (values: Record<string, unknown>) => {
    setSaving(true);
    try {
      const r = await api.saveModel({
        provider: String(values.provider ?? "openai"),
        modelId: String(values.modelId ?? ""),
        baseUrl: String(values.baseUrl ?? ""),
        apiKey: String(values.apiKey ?? ""),
        visionEnabled: Boolean(values.visionEnabled),
        visionModelId: String(values.visionModelId ?? ""),
      });
      setSettings(r.json);
      Toast.success("模型配置已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveUpdateCfg = async (values: Record<string, unknown>) => {
    try {
      const r = await api.saveUpdateCfg({
        githubUrl: String(values.githubUrl ?? ""),
        branch: String(values.branch ?? "main"),
        githubToken: String(values.githubToken ?? ""),
      });
      setSettings(r.json);
      Toast.success("更新源已保存");
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const testModel = async () => {
    setTesting(true);
    try {
      const r = await api.testModel();
      if (r.json.ok) {
        Toast.success(`连通正常 · ${r.json.modelId} · 视觉${r.json.visionEnabled ? "开" : "关"}`);
      } else {
        Toast.error(r.json.error || `失败 ${r.json.status}`);
      }
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const runSilentUpdate = async () => {
    setUpdating(true);
    try {
      await api.saveUpdateCfg({
        githubUrl: settings.update.githubUrl,
        branch: settings.update.branch,
      });
      const r = await api.runUpdate();
      setUpdateStatus(r.json);
    } catch (e) {
      setUpdating(false);
      Toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const totals = usage?.totals ?? { tokens: 0, toolCalls: 0, installs: 0, tasks: 0 };
  const phase = updateStatus?.phase;
  const cardStyle = { background: "var(--semi-color-bg-1)", maxWidth: 720 } as const;

  if (section === "model") {
    return (
      <Card title="模型配置" style={cardStyle}>
        <Banner
          type="info"
          closeIcon={null}
          description="OpenAI 兼容 API（含中转）。开启视觉后，Pi / 后续截图类工具可走 image 输入；Key 仅存本机 settings.json。"
          style={{ marginBottom: 16 }}
        />
        <Form
          labelPosition="left"
          labelWidth={110}
          initValues={{
            provider: settings.model.provider,
            modelId: settings.model.modelId,
            baseUrl: settings.model.baseUrl,
            apiKey: settings.model.apiKeyConfigured ? settings.model.apiKeyMask : "",
            visionEnabled: settings.model.visionEnabled,
            visionModelId: settings.model.visionModelId,
          }}
          onSubmit={(v) => void saveModel(v)}
        >
          <Form.Input
            field="provider"
            label="Provider"
            placeholder="openai"
            rules={[{ required: true, message: "必填" }]}
          />
          <Form.Input
            field="baseUrl"
            label="Base URL"
            placeholder="https://api.x5m5x.com/v1"
            rules={[{ required: true, message: "必填" }]}
            extraText="须带 /v1"
          />
          <Form.Input
            field="modelId"
            label="主模型"
            placeholder="gpt-4.1-mini"
            rules={[{ required: true, message: "必填" }]}
          />
          <Form.Input
            field="apiKey"
            label="API Key"
            mode="password"
            placeholder={settings.model.apiKeyConfigured ? "已配置（留空或掩码则不改）" : "sk-…"}
          />
          <Form.Switch
            field="visionEnabled"
            label="视觉能力"
            extraText="启用后支持 Pi image 输入；API 需为视觉模型"
          />
          <Form.Input
            field="visionModelId"
            label="视觉模型"
            placeholder="可选，留空则同主模型"
            extraText="例如 gpt-4o / gpt-6-astra 等支持 image 的模型 id"
          />
          <Space style={{ marginTop: 8 }}>
            <Button htmlType="submit" theme="solid" icon={<IconSave />} loading={saving}>
              保存
            </Button>
            <Button icon={<IconLink />} loading={testing} onClick={() => void testModel()}>
              测试连通
            </Button>
          </Space>
        </Form>
      </Card>
    );
  }

  if (section === "usage") {
    return (
      <Card title="Token 统计" style={cardStyle}>
        <Row gutter={12} style={{ marginBottom: 12 }}>
          <Col span={12}>
            <Typography.Text type="tertiary" size="small">
              累计 Token
            </Typography.Text>
            <div style={{ fontSize: 26, fontWeight: 650 }}>{formatNum(totals.tokens)}</div>
          </Col>
          <Col span={12}>
            <Typography.Text type="tertiary" size="small">
              工具调用 / 安装
            </Typography.Text>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>
              {formatNum(totals.toolCalls)} / {formatNum(totals.installs)}
            </div>
          </Col>
        </Row>
        <Typography.Text type="tertiary" size="small">
          任务数 {totals.tasks}
        </Typography.Text>
        <Table
          style={{ marginTop: 12 }}
          size="small"
          pagination={false}
          rowKey="id"
          dataSource={usage?.byTask ?? []}
          empty="暂无用量"
          columns={[
            { title: "任务", dataIndex: "name", ellipsis: true },
            { title: "Token", dataIndex: "tokens", width: 90, render: (v: number) => formatNum(v) },
            { title: "工具", dataIndex: "toolCalls", width: 70 },
          ]}
        />
        <Button
          icon={<IconRefresh />}
          theme="borderless"
          style={{ marginTop: 8 }}
          onClick={() => void reload()}
        >
          刷新用量
        </Button>
      </Card>
    );
  }

  if (section === "update") {
    return (
      <Card title="一键更新" style={cardStyle}>
        <Typography.Paragraph type="tertiary" style={{ marginTop: 0 }}>
          从 GitHub 静默拉取并覆盖安装目录，保留本机数据与模型配置，构建后自动重启。对用户无感。
        </Typography.Paragraph>
        <Form
          labelPosition="left"
          labelWidth={90}
          initValues={{
            githubUrl: settings.update.githubUrl,
            branch: settings.update.branch,
            githubToken: settings.update.githubTokenConfigured
              ? settings.update.githubTokenMask
              : "",
          }}
          onSubmit={(v) => void saveUpdateCfg(v)}
        >
          <Form.Input field="githubUrl" label="仓库" placeholder="https://github.com/Sycun/GongYuAI" />
          <Form.Input field="branch" label="分支" placeholder="main" />
          <Form.Input
            field="githubToken"
            label="Token"
            mode="password"
            placeholder={
              settings.update.githubTokenConfigured
                ? "已配置（私有库可选）"
                : "私有库 PAT / 或本机 gh auth"
            }
          />
          <Space>
            <Button htmlType="submit" type="tertiary">
              保存更新源
            </Button>
            <Button theme="solid" loading={updating} onClick={() => void runSilentUpdate()}>
              {updating ? "更新中…" : "一键更新"}
            </Button>
          </Space>
        </Form>
        {(updating || (phase && phase !== "idle")) && (
          <div style={{ marginTop: 16 }}>
            <Progress
              percent={
                phase === "done"
                  ? 100
                  : phase === "failed"
                    ? 100
                    : phase === "restarting"
                      ? 90
                      : phase === "building"
                        ? 70
                        : phase === "overlay"
                          ? 50
                          : phase === "extracting"
                            ? 30
                            : 15
              }
              showInfo
              aria-label="update"
            />
            <Typography.Text type="tertiary" size="small">
              {updateStatus?.message || "…"}
              {updateStatus?.commit ? ` · ${updateStatus.commit}` : ""}
            </Typography.Text>
          </div>
        )}
        <Typography.Text type="quaternary" size="small" style={{ display: "block", marginTop: 12 }}>
          当前版本 {settings.version}
          {settings.update.lastUpdatedAt
            ? ` · 上次更新 ${settings.update.lastUpdatedAt}`
            : ""}
          {settings.update.lastCommit ? ` · ${settings.update.lastCommit}` : ""}
        </Typography.Text>
      </Card>
    );
  }

  return (
    <Card title="运行时" style={cardStyle}>
      <Space vertical align="start">
        <Typography.Text>监听 {window.location.host || "0.0.0.0:8877"}</Typography.Text>
        <Typography.Text type="tertiary">
          长程任务控制台 · 检查点 + 租约/栅栏 · 证据闸门 · Semi Design
        </Typography.Text>
      </Space>
    </Card>
  );
}
