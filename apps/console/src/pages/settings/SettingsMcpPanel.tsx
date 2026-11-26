import { Banner, Button, Card, Form, Radio, RadioGroup, Space, Table, Tag, Toast, Typography } from "@douyinfe/semi-ui";
import { IconDelete, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { api, type McpServerPublic, type PublicSettings } from "../../api";
import { useClientPagination } from "../../components/useClientPagination";

export function SettingsMcpPanel({
  settings,
  onSettings,
}: {
  settings: PublicSettings;
  onSettings: (next: PublicSettings) => void;
}) {
    const mcpPager = useClientPagination(settings.mcpServers ?? [], 12);

    const toggleMcp = async (id: string, loadAtStartup: boolean) => {
      try {
        const r = await api.toggleTools({ kind: "mcp", id, enabled: loadAtStartup });
        onSettings(r.json);
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
        onSettings(r.json);
        Toast.success("已添加用户 MCP");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const rescan = async () => {
      try {
        const r = await api.rescanTools();
        onSettings(r.json);
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
            pagination={mcpPager.pagination}
            rowKey="id"
            dataSource={mcpPager.dataSource}
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
