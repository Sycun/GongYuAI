import { useState } from "react";
import { Banner, Button, Card, Form, Space, Switch, Table, Toast, Typography } from "@douyinfe/semi-ui";
import { IconDelete, IconPlus, IconSave } from "@douyinfe/semi-icons";
import { api, type AssetCollectorPublic, type PublicSettings } from "../../api";

export function SettingsAssetsPanel({
  settings,
  onSettings,
}: {
  settings: PublicSettings;
  onSettings: (next: PublicSettings) => void;
}) {
  const [saving, setSaving] = useState(false);

    const collectors = settings.assetCollectors ?? [];
    const builtins = collectors.filter((c) => c.builtin);
    const customs = collectors.filter((c) => !c.builtin);

    const saveCollector = async (values: Record<string, unknown>) => {
      setSaving(true);
      try {
        const r = await api.saveAssetCollector({
          id: String(values.id ?? ""),
          enabled: Boolean(values.enabled),
          email: String(values.email ?? ""),
          apiKey: String(values.apiKey ?? ""),
          baseUrl: String(values.baseUrl ?? ""),
          method: values.method ? String(values.method) : undefined,
          authHeader: values.authHeader != null ? String(values.authHeader) : undefined,
          authQueryParam:
            values.authQueryParam != null ? String(values.authQueryParam) : undefined,
          queryParam: values.queryParam != null ? String(values.queryParam) : undefined,
          queryEncoding: values.queryEncoding
            ? String(values.queryEncoding)
            : undefined,
          bodyTemplate:
            values.bodyTemplate != null ? String(values.bodyTemplate) : undefined,
          resultPath: values.resultPath != null ? String(values.resultPath) : undefined,
          addressFields:
            typeof values.addressFields === "string"
              ? String(values.addressFields)
                  .split(/[,;\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
        });
        onSettings(r.json);
        Toast.success("资产收集配置已保存");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    };

    const toggleCollector = async (id: string, enabled: boolean) => {
      try {
        const r = await api.toggleAssetCollector({ id, enabled });
        onSettings(r.json);
        Toast.success(enabled ? `已启用 ${id}` : `已关闭 ${id}`);
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };

    const addCustom = async (values: Record<string, unknown>) => {
      try {
        const r = await api.addAssetCollector({
          id: String(values.id ?? ""),
          name: String(values.name ?? ""),
          kind: "custom",
          enabled: true,
          apiKey: String(values.apiKey ?? ""),
          baseUrl: String(values.baseUrl ?? ""),
          method: String(values.method ?? "GET"),
          authHeader: String(values.authHeader ?? ""),
          authQueryParam: String(values.authQueryParam ?? ""),
          queryParam: String(values.queryParam ?? "q"),
          queryEncoding: String(values.queryEncoding ?? "plain"),
          bodyTemplate: String(values.bodyTemplate ?? ""),
          resultPath: String(values.resultPath ?? ""),
          addressFields: String(values.addressFields ?? "host,ip,domain,url")
            .split(/[,;\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
        });
        onSettings(r.json);
        Toast.success("已添加自定义收集器");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };

    const kindLabel = (k: string) =>
      k === "fofa" ? "FOFA" : k === "hunter" ? "鹰图" : "自定义";

    return (
      <Space vertical align="start" style={{ width: "100%", maxWidth: 980 }}>
        <Banner
          type="info"
          closeIcon={null}
          description="配置 FOFA / 鹰图(Hunter) 或自建资产收集 API。启用且填好密钥后，任务运行时 AI 可通过 asset_search 被动测绘，命中自动写入资产清单（CIDR/通配准入）。密钥仅存本机 settings.json。"
        />
        {builtins.map((c: AssetCollectorPublic) => (
          <Card
            key={c.id}
            title={`${c.name}（${kindLabel(c.kind)}）`}
            style={{ width: "100%", background: "var(--semi-color-bg-1)" }}
            headerExtraContent={
              <Switch
                checked={c.enabled}
                onChange={(on) => void toggleCollector(c.id, on)}
              />
            }
          >
            <Form
              labelPosition="left"
              labelWidth={110}
              initValues={{
                id: c.id,
                enabled: c.enabled,
                email: c.emailConfigured ? c.emailMask : "",
                apiKey: c.apiKeyConfigured ? c.apiKeyMask : "",
                baseUrl: c.baseUrl,
              }}
              onSubmit={(v) => void saveCollector({ ...v, id: c.id, enabled: c.enabled })}
            >
              {c.kind === "fofa" ? (
                <Form.Input
                  field="email"
                  label="Email"
                  placeholder={c.emailConfigured ? "已配置（留空或掩码则不改）" : "FOFA 账号邮箱"}
                />
              ) : null}
              <Form.Input
                field="apiKey"
                label="API Key"
                mode="password"
                placeholder={
                  c.apiKeyConfigured ? "已配置（留空或掩码则不改）" : "平台 API Key"
                }
              />
              <Form.Input
                field="baseUrl"
                label="服务地址"
                placeholder={c.baseUrl}
                extraText={
                  c.kind === "fofa"
                    ? "默认 https://fofa.info/api/v1/search/all"
                    : "默认 https://hunter.qianxin.com/openApi/search"
                }
              />
              <Button htmlType="submit" theme="solid" icon={<IconSave />} loading={saving}>
                保存
              </Button>
            </Form>
          </Card>
        ))}

        <Card
          title="自定义资产收集项目"
          style={{ width: "100%", background: "var(--semi-color-bg-1)" }}
        >
          <Typography.Paragraph type="tertiary" style={{ marginTop: 0 }}>
            对接自建测绘 / 资产库 HTTP API。GET/POST；查询可用明文或 Base64；用 resultPath
            与 addressFields 解析主机。模板变量：{"{{apiKey}}"} {"{{query}}"} {"{{queryBase64}}"}{" "}
            {"{{page}}"} {"{{size}}"}。
          </Typography.Paragraph>
          <Table
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={customs}
            empty="暂无自定义收集器"
            columns={[
              { title: "ID", dataIndex: "id", width: 120 },
              { title: "名称", dataIndex: "name", width: 140 },
              { title: "URL", dataIndex: "baseUrl", ellipsis: true },
              {
                title: "启用",
                dataIndex: "enabled",
                width: 80,
                render: (v: boolean, row: AssetCollectorPublic) => (
                  <Switch checked={v} onChange={(on) => void toggleCollector(row.id, on)} />
                ),
              },
              {
                title: "",
                width: 56,
                render: (_: unknown, row: AssetCollectorPublic) => (
                  <Button
                    type="danger"
                    theme="borderless"
                    icon={<IconDelete />}
                    onClick={() =>
                      void api
                        .removeAssetCollector(row.id)
                        .then((r) => {
                          onSettings(r.json);
                          Toast.success("已删除");
                        })
                        .catch((e) =>
                          Toast.error(e instanceof Error ? e.message : String(e)),
                        )
                    }
                  />
                ),
              },
            ]}
          />
          <Typography.Title heading={6} style={{ marginTop: 20 }}>
            添加自定义收集器
          </Typography.Title>
          <Form labelPosition="left" labelWidth={120} onSubmit={(v) => void addCustom(v)}>
            <Form.Input
              field="id"
              label="ID"
              placeholder="my-recon"
              rules={[{ required: true, message: "必填" }]}
            />
            <Form.Input
              field="name"
              label="名称"
              placeholder="我的资产库"
              rules={[{ required: true, message: "必填" }]}
            />
            <Form.Input
              field="baseUrl"
              label="服务地址"
              placeholder="https://recon.example.com/api/search"
              rules={[{ required: true, message: "必填" }]}
            />
            <Form.Input field="apiKey" label="API Key" mode="password" />
            <Form.Select
              field="method"
              label="方法"
              initValue="GET"
              optionList={[
                { value: "GET", label: "GET" },
                { value: "POST", label: "POST" },
              ]}
            />
            <Form.Input
              field="authHeader"
              label="鉴权头"
              placeholder="Authorization 或 Authorization: Bearer {{apiKey}}"
            />
            <Form.Input
              field="authQueryParam"
              label="鉴权 Query"
              placeholder="可选，如 key / token"
            />
            <Form.Input field="queryParam" label="查询参数名" initValue="q" />
            <Form.Select
              field="queryEncoding"
              label="查询编码"
              initValue="plain"
              optionList={[
                { value: "plain", label: "明文" },
                { value: "base64", label: "Base64" },
              ]}
            />
            <Form.TextArea
              field="bodyTemplate"
              label="POST 体模板"
              rows={3}
              placeholder={'{"q":"{{query}}","size":{{size}}}'}
            />
            <Form.Input
              field="resultPath"
              label="结果路径"
              placeholder="data.list / results"
            />
            <Form.Input
              field="addressFields"
              label="地址字段"
              initValue="host,ip,domain,url"
              extraText="逗号分隔，按优先级取第一个非空"
            />
            <Button htmlType="submit" theme="solid" icon={<IconPlus />}>
              添加
            </Button>
          </Form>
        </Card>
      </Space>
    );
}
