import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout, Nav, Typography, Badge } from "@douyinfe/semi-ui";
import {
  IconHome,
  IconList,
  IconPulse,
  IconCheckboxTick,
  IconHistory,
  IconFolder,
  IconFile,
  IconTerminal,
  IconSetting,
} from "@douyinfe/semi-icons";
import { api, type Overview, type TaskRecord } from "./api";
import { DETAIL_TABS, ROUTE_META, type DetailTab } from "./labels";
import { OverviewPage } from "./pages/OverviewPage";
import { TasksPage } from "./pages/TasksPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { SettingsPage } from "./pages/SettingsPage";

const { Header, Sider, Content } = Layout;

type Route =
  | "overview"
  | "tasks"
  | "settings"
  | DetailTab;

function parseHash(): { route: Route; taskId: string | null } {
  const raw = (location.hash || "#/overview").replace(/^#\/?/, "");
  const [routePart, id] = raw.split("/");
  const route = (routePart || "overview") as Route;
  return { route, taskId: id || null };
}

function buildHash(route: Route, taskId: string | null): string {
  if (taskId && route !== "overview" && route !== "tasks" && route !== "settings") {
    return `#/${route}/${taskId}`;
  }
  if (route === "tasks" && taskId) return `#/tasks/${taskId}`;
  return `#/${route}`;
}

export function App() {
  const initial = parseHash();
  const [route, setRoute] = useState<Route>(initial.route);
  const [taskId, setTaskId] = useState<string | null>(initial.taskId);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);

  const meta = ROUTE_META[route] ?? ROUTE_META.overview;
  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === taskId) ?? null,
    [tasks, taskId],
  );

  const navigate = useCallback((next: Route, nextTaskId?: string | null) => {
    setRoute(next);
    const id = nextTaskId === undefined ? taskId : nextTaskId;
    let resolved = id;
    if (
      DETAIL_TABS.some((t) => t.key === next) &&
      !resolved &&
      tasks.length
    ) {
      resolved = tasks[tasks.length - 1]!.id;
      setTaskId(resolved);
    } else if (nextTaskId !== undefined) {
      setTaskId(nextTaskId);
    }
    location.hash = buildHash(next, resolved ?? null);
  }, [taskId, tasks]);

  const refresh = useCallback(async () => {
    try {
      const h = await api.health();
      setOnline(Boolean(h.json?.ok));
    } catch {
      setOnline(false);
    }
    const [t, o] = await Promise.all([api.tasks(), api.overview()]);
    setTasks(t.json.tasks ?? []);
    setOverview(o.json);
    if (!taskId && (t.json.tasks?.length ?? 0) > 0) {
      setTaskId(t.json.tasks![t.json.tasks!.length - 1]!.id);
    }
  }, [taskId]);

  useEffect(() => {
    const onHash = () => {
      const p = parseHash();
      setRoute(p.route);
      if (p.taskId) setTaskId(p.taskId);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openTask = (id: string) => navigate("live", id);

  const selectedKeys = [route === "tasks" && taskId ? "tasks" : route];

  return (
    <Layout style={{ height: "100vh", background: "var(--semi-color-bg-0)" }}>
      <Sider style={{ background: "var(--semi-color-bg-1)", borderRight: "1px solid var(--semi-color-border)" }}>
        <Nav
          style={{ maxWidth: 220, height: "100%" }}
          selectedKeys={selectedKeys}
          onSelect={({ itemKey }) => navigate(String(itemKey) as Route)}
          header={{
            text: "GongYuAI",
            logo: (
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--semi-color-primary)",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 13,
                }}
              >
                GY
              </span>
            ),
          }}
          footer={{ collapseButton: true }}
        >
          <Nav.Item itemKey="overview" text="总览" icon={<IconHome />} />
          <Nav.Item itemKey="tasks" text="任务" icon={<IconList />} />
          <Nav.Sub itemKey="dive" text="任务深潜">
            <Nav.Item itemKey="live" text="运行态" icon={<IconPulse />} />
            <Nav.Item itemKey="goals" text="目标" icon={<IconCheckboxTick />} />
            <Nav.Item itemKey="history" text="历史" icon={<IconHistory />} />
            <Nav.Item itemKey="evidence" text="证据" icon={<IconFolder />} />
            <Nav.Item itemKey="report" text="报告" icon={<IconFile />} />
            <Nav.Item itemKey="logs" text="日志" icon={<IconTerminal />} />
          </Nav.Sub>
          <Nav.Item itemKey="settings" text="设置" icon={<IconSetting />} />
        </Nav>
      </Sider>
      <Layout>
        <Header
          style={{
            background: "var(--semi-color-bg-1)",
            borderBottom: "1px solid var(--semi-color-border)",
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            height: 64,
          }}
        >
          <div>
            <Typography.Title heading={5} style={{ margin: 0 }}>
              {meta.title}
            </Typography.Title>
            <Typography.Text type="tertiary" size="small">
              {meta.subtitle}
            </Typography.Text>
          </div>
          <Badge
            dot
            count={online ? 1 : 0}
            type={online ? "success" : "danger"}
            position="rightTop"
          >
            <Typography.Text type="tertiary">
              {online === null ? "连接中…" : online ? "在线 · :8877" : "离线"}
            </Typography.Text>
          </Badge>
        </Header>
        <Content style={{ padding: 24, overflow: "auto", background: "var(--semi-color-bg-0)" }}>
          {route === "overview" && (
            <OverviewPage overview={overview} onSelect={openTask} />
          )}
          {route === "tasks" && <TasksPage tasks={tasks} onSelect={openTask} />}
          {route === "settings" && <SettingsPage />}
          {DETAIL_TABS.some((t) => t.key === route) && (
            <TaskDetailPage
              task={selectedTask}
              tab={route as DetailTab}
              onTabChange={(t) => navigate(t, taskId)}
              onRefresh={refresh}
            />
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
