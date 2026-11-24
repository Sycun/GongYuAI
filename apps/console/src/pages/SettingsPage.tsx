import { ChatApprovalSettings } from "../components/ChatApprovalSettings";
import type { ChatCatalog } from "@gongyuai/contracts";
import { ChatModelSettings } from "../components/ChatModelSettings";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Card,
  Col,
  Form,
  Progress,
  Radio,
  RadioGroup,
  Row,
  Space,
  Switch,
  Table,
  Tag,
  Toast,
  Typography,
} from "@douyinfe/semi-ui";
import type { FormApi } from "@douyinfe/semi-ui/lib/es/form/interface";
import { IconDownloadStroked, IconBox, IconRefresh, IconSave, IconDelete, IconPlus } from "@douyinfe/semi-icons";
import {
  api,
  type AssetCollectorPublic,
  type McpServerPublic,
  type PublicSettings,
  type SkillPackPublic,
  type UsageStats,
  type UpdateJobStatus,
} from "../api";
import type { SettingsSection } from "../labels";
import { formatDateTime } from "../time";
import { IntegrationUsage } from "../components/IntegrationUsage";

const UPDATE_RECONNECT_MS = 180_000;

function formatNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

export function SettingsPage({ section, catalog, onCatalog, profileId }: { profileId?: string | null; section: SettingsSection; catalog: ChatCatalog | null; onCatalog: (value: ChatCatalog) => void }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateJobStatus | null>(null);
  const updateFormApi = useRef<FormApi | null>(null);
  const updateStartedAt = useRef<number>(0);
  const lastCommitBeforeUpdate = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const [s, u] = await Promise.all([api.settings(), section === "usage" ? api.usage(true) : null]);
    setSettings(s.json);
    if (u) setUsage(u.json);
    return s.json;
  }, [section]);

  useEffect(() => {
    void reload().catch((e) => Toast.error(e instanceof Error ? e.message : String(e)));
  }, [reload]);

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

  if (!settings) {
    return <Typography.Text type="tertiary">加载设置…</Typography.Text>;
  }

  const saveUpdateCfg = async (
    values: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ) => {
    try {
      const r = await api.saveUpdateCfg({
        githubUrl: String(values.githubUrl ?? ""),
        branch: String(values.branch ?? "main"),
      });
      setSettings(r.json);
      if (!opts?.quiet) Toast.success("更新源已保存");
      return r.json;
    } catch (e) {
      Toast.error(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  const runSilentUpdate = async () => {
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

  const totals = usage?.totals ?? { tokens: 0, toolCalls: 0, installs: 0, tasks: 0 };
  const phase = updateStatus?.phase;
  const cardStyle = { background: "var(--semi-color-bg-1)", maxWidth: 720 } as const;

  if (section === "approval") return <ChatApprovalSettings catalog={catalog} onCatalog={onCatalog} />;

  if (section === "model") {
    return (
      <div className="gy-settings-stack">
        {catalog ? <ChatModelSettings key={profileId} catalog={catalog} initialId={profileId} onSaved={onCatalog} /> :
          <Button onClick={() => void api.chatModels().then(r => onCatalog(r.json)).catch(() => Toast.error("无法读取模型配置"))}>重新读取对话模型</Button>}
      </div>
    );
  }

  if (section === "assets") {
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
        setSettings(r.json);
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
        setSettings(r.json);
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
        setSettings(r.json);
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
                          setSettings(r.json);
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

  if (section === "mcp") {
    const toggleMcp = async (id: string, loadAtStartup: boolean) => {
      try {
        const r = await api.toggleTools({ kind: "mcp", id, enabled: loadAtStartup });
        setSettings(r.json);
        Toast.success(
          loadAtStartup ? `已设为启动时加载 ${id}` : `已设为按需加载 ${id}`,
        );
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const addMcp = async (values: Record<string, unknown>) => {
      try {
        const transport = String(values.transport ?? "stdio") as "stdio" | "http";
        const r = await api.addMcp({
          id: String(values.id ?? ""),
          name: String(values.name ?? ""),
          enabled: true,
          transport,
          command: transport === "stdio" ? String(values.command ?? "") : undefined,
          args:
            transport === "stdio" && values.args
              ? String(values.args).split(/\s+/).filter(Boolean)
              : [],
          url: transport === "http" ? String(values.url ?? "") : undefined,
        });
        setSettings(r.json);
        Toast.success("已添加用户 MCP");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const rescan = async () => {
      try {
        const r = await api.rescanTools();
        setSettings(r.json);
        Toast.success(`已重扫目录 · MCP ${r.json.mcpServers?.length ?? 0} 项`);
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    return (
      <Space vertical align="start" style={{ width: "100%", maxWidth: 980 }}>
        <Banner
          type="info"
          closeIcon={null}
          description="模型可以看到全部连接器，并按任务需要选择。设为『启动时加载』的连接器会在任务开始时提前连接。"
        />
        <Space>
          <Button icon={<IconRefresh />} onClick={() => void rescan()}>
            重扫目录
          </Button>
        </Space>
        <Card title="MCP 连接器" style={{ width: "100%", background: "var(--semi-color-bg-1)" }}>
          <Table
            size="small"
            pagination={{ pageSize: 12 }}
            rowKey="id"
            dataSource={settings.mcpServers ?? []}
            columns={[
              { title: "ID", dataIndex: "id", width: 110 },
              { title: "分类", dataIndex: "category", width: 90 },
              { title: "说明", dataIndex: "description", ellipsis: true },
              {
                title: "来源",
                dataIndex: "source",
                width: 70,
                render: (v: string) => (v === "builtin" ? "内置" : "用户"),
              },
              { title: "传输", dataIndex: "transport", width: 80 },
              {
                title: "加载方式",
                dataIndex: "enabled",
                width: 190,
                render: (v: boolean, row: McpServerPublic) =>
                  row.startupForced ? (
                    <Space spacing={4}>
                      <RadioGroup
                        type="button"
                        buttonSize="small"
                        value="startup"
                        disabled
                        name={`mcp-load-${row.id}`}
                        aria-label={`${row.id} 加载方式`}
                      >
                        <Radio value="ondemand">按需加载</Radio>
                        <Radio value="startup">启动时加载</Radio>
                      </RadioGroup>
                      <Tag size="small" color="grey">
                        常开
                      </Tag>
                    </Space>
                  ) : (
                    <RadioGroup
                      type="button"
                      buttonSize="small"
                      value={v ? "startup" : "ondemand"}
                      onChange={(e) =>
                        void toggleMcp(row.id, e.target.value === "startup")
                      }
                      name={`mcp-load-${row.id}`}
                      aria-label={`${row.id} 加载方式`}
                    >
                      <Radio value="ondemand">按需加载</Radio>
                      <Radio value="startup">启动时加载</Radio>
                    </RadioGroup>
                  ),
              },
              {
                title: "",
                width: 56,
                render: (_: unknown, row: McpServerPublic) =>
                  row.builtin ? null : (
                    <Button
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      onClick={() =>
                        void api
                          .removeMcp(row.id)
                          .then((r) => {
                            setSettings(r.json);
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
            添加远程/stdio MCP
          </Typography.Title>
          <Form labelPosition="left" labelWidth={90} onSubmit={(v) => void addMcp(v)}>
            <Form.Input field="id" label="ID" placeholder="my-scanner" rules={[{ required: true }]} />
            <Form.Input field="name" label="名称" rules={[{ required: true }]} />
            <Form.Select
              field="transport"
              label="传输"
              initValue="stdio"
              optionList={[
                { value: "stdio", label: "stdio" },
                { value: "http", label: "http" },
              ]}
            />
            <Form.Input field="command" label="Command" placeholder="npx（stdio）" />
            <Form.Input field="args" label="Args" placeholder="-y some-mcp" />
            <Form.Input field="url" label="URL" placeholder="http://…（http）" />
            <Button htmlType="submit" theme="solid" icon={<IconPlus />}>
              添加
            </Button>
          </Form>
        </Card>
      </Space>
    );
  }

  if (section === "skills") {
    const toggleSkill = async (id: string, enabled: boolean) => {
      try {
        const r = await api.toggleTools({ kind: "skill", id, enabled });
        setSettings(r.json);
        Toast.success(enabled ? `已启用 ${id}` : `已关闭 ${id}`);
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const importSkill = async (values: Record<string, unknown>) => {
      try {
        const r = await api.importSkill({
          id: String(values.id ?? ""),
          name: String(values.name ?? ""),
          enabled: true,
          skillMarkdown: String(values.skillMarkdown ?? ""),
        });
        setSettings(r.json);
        Toast.success("已导入 Skill");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const rescan = async () => {
      try {
        const r = await api.rescanTools();
        setSettings(r.json);
        Toast.success(`已重扫目录 · Skill ${r.json.skillPacks?.length ?? 0} 项`);
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    return (
      <Space vertical align="start" style={{ width: "100%", maxWidth: 980 }}>
        <Banner
          type="info"
          closeIcon={null}
          description="路由表 + load_skill：开关只表示是否进入路由目录（建议全开）。不会把全部 SKILL.md 灌进上下文；模型按阶段 load_skill(id) 读正文。目录：skills/builtin|user + routing.json。"
        />
        <Button icon={<IconRefresh />} onClick={() => void rescan()}>
          重扫目录
        </Button>
        <Card title="Skill 包" style={{ width: "100%", background: "var(--semi-color-bg-1)" }}>
          <Table
            size="small"
            pagination={false}
            rowKey="id"
            dataSource={settings.skillPacks ?? []}
            columns={[
              { title: "ID", dataIndex: "id", width: 180 },
              { title: "名称", dataIndex: "name", width: 140 },
              { title: "说明", dataIndex: "description", ellipsis: true },
              {
                title: "来源",
                dataIndex: "source",
                width: 70,
                render: (v: string) => (v === "builtin" ? "内置" : "用户"),
              },
              {
                title: "参与路由",
                dataIndex: "enabled",
                width: 90,
                render: (v: boolean, row: SkillPackPublic) => (
                  <Switch checked={v} onChange={(on) => void toggleSkill(row.id, on)} />
                ),
              },
              {
                title: "",
                width: 56,
                render: (_: unknown, row: SkillPackPublic) =>
                  row.builtin ? null : (
                    <Button
                      type="danger"
                      theme="borderless"
                      icon={<IconDelete />}
                      onClick={() =>
                        void api
                          .removeSkill(row.id)
                          .then((r) => {
                            setSettings(r.json);
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
            导入 Skill（SKILL.md）
          </Typography.Title>
          <Form labelPosition="left" labelWidth={90} onSubmit={(v) => void importSkill(v)}>
            <Form.Input field="id" label="ID" rules={[{ required: true }]} />
            <Form.Input field="name" label="名称" rules={[{ required: true }]} />
            <Form.TextArea
              field="skillMarkdown"
              label="正文"
              rows={8}
              placeholder={"---\nname: …\ndescription: …\n---\n\n# …"}
              rules={[{ required: true }]}
            />
            <Button htmlType="submit" theme="solid" icon={<IconPlus />}>
              导入
            </Button>
          </Form>
        </Card>
      </Space>
    );
  }

  if (section === "usage") {
    return (
      <div style={{ display: "grid", gap: 16 }}>
      <IntegrationUsage usage={usage?.integrations} />
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
      </div>
    );
  }

  if (section === "update") {
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
