import { Banner, Button, Card, Form, Space, Switch, Table, Toast, Typography } from "@douyinfe/semi-ui";
import { IconDelete, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { api, type PublicSettings, type SkillPackPublic } from "../../api";

export function SettingsSkillsPanel({
  settings,
  onSettings,
}: {
  settings: PublicSettings;
  onSettings: (next: PublicSettings) => void;
}) {

    const toggleSkill = async (id: string, enabled: boolean) => {
      try {
        const r = await api.toggleTools({ kind: "skill", id, enabled });
        onSettings(r.json);
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
        onSettings(r.json);
        Toast.success("已导入 Skill");
      } catch (e) {
        Toast.error(e instanceof Error ? e.message : String(e));
      }
    };
    const rescan = async () => {
      try {
        const r = await api.rescanTools();
        onSettings(r.json);
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
