import { useEffect, useMemo, useState } from "react";
import { ActivityRail } from "./components/ActivityRail.jsx";
import { BottomPanel } from "./components/BottomPanel.jsx";
import { ConnectionDialog } from "./components/ConnectionDialog.jsx";
import { ExplorerPanel } from "./components/ExplorerPanel.jsx";
import { StatusBar } from "./components/StatusBar.jsx";
import { SettingsDialog } from "./components/SettingsDialog.jsx";
import { TerminalPane } from "./components/TerminalPane.jsx";
import { TopBar } from "./components/TopBar.jsx";
import { NativeApp } from "./NativeApp.jsx";
import { isNativeRuntimeAvailable, isRunningInElectron } from "./native/client.js";
import {
  createDemoMetrics,
  createTerminalLines,
  formatFileSize,
  SERVERS,
  TRANSFER_SEED,
} from "./demoData.js";

const DEFAULT_BOTTOM_PANEL_HEIGHT = 168;
const DEFAULT_MONITOR_PANEL_HEIGHT = 344;
const DEFAULT_APPEARANCE = {
  accent: "#9d84f8",
  terminalBackground: "#061423",
  terminalForeground: "#c8cbd1",
  wallpaperOpacity: 0.22,
  wallpaperName: "",
  wallpaperUrl: "",
};

function createSessionState(server, showDemoCompletion = false) {
  return {
    lines: createTerminalLines(server),
    command: showDemoCompletion ? "journalc" : "",
    completionOpen: showDemoCompletion,
    completionIndex: 0,
  };
}

export function DemoApp() {
  const [servers, setServers] = useState(SERVERS);
  const [activeServerId, setActiveServerId] = useState(SERVERS[0].id);
  const [activeRail, setActiveRail] = useState("files");
  const [railVisible, setRailVisible] = useState(true);
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [connectionDialog, setConnectionDialog] = useState({ open: false, view: "list" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [activeBottomTab, setActiveBottomTab] = useState("transfer");
  const [bottomVisible, setBottomVisible] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomPanelHeights, setBottomPanelHeights] = useState({
    standard: DEFAULT_BOTTOM_PANEL_HEIGHT,
    monitor: DEFAULT_MONITOR_PANEL_HEIGHT,
  });
  const [sessions, setSessions] = useState([{ id: SERVERS[0].id, label: SERVERS[0].name, state: SERVERS[0].state }]);
  const [activeSessionId, setActiveSessionId] = useState(SERVERS[0].id);
  const [sessionStates, setSessionStates] = useState(() => ({
    [SERVERS[0].id]: createSessionState(SERVERS[0], true),
  }));
  const [transfers, setTransfers] = useState([TRANSFER_SEED]);
  const [metricsOffset, setMetricsOffset] = useState(0);
  const [sampledAt, setSampledAt] = useState("2026-07-14 11:28:53");

  const server = servers.find((item) => item.id === activeServerId) || servers[0];
  const activeSession = sessionStates[activeSessionId] || createSessionState(server);
  const metrics = useMemo(() => {
    const cpu = Math.max(4, Math.min(92, server.metrics.cpu + metricsOffset));
    const down = Math.max(0.1, server.metrics.down + metricsOffset * 0.08);
    const up = Math.max(0.1, server.metrics.up - metricsOffset * 0.05);
    const history = server.metrics.history.map((point, index, points) => (
      index === points.length - 1 ? { ...point, down, up } : point
    ));
    return { ...server.metrics, cpu, down, up, history };
  }, [metricsOffset, server]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setMetricsOffset((value) => (value >= 3 ? -2 : value + 1));
      setSampledAt(`2026-07-14 ${new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}`);
    }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setTransfers((items) => {
        let changed = false;
        const nextItems = items.map((item) => {
          if (!item.autoAdvance || item.state !== "uploading" || item.progress >= 100) return item;
          changed = true;
          const progress = Math.min(100, item.progress + 1.5);
          return {
            ...item,
            progress,
            state: progress === 100 ? "success" : "uploading",
            autoAdvance: progress < 100,
          };
        });
        return changed ? nextItems : items;
      });
    }, 1200);
    return () => window.clearInterval(interval);
  }, []);

  function updateSession(sessionId, updater) {
    setSessionStates((states) => {
      const current = states[sessionId];
      const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
      return { ...states, [sessionId]: next };
    });
  }

  function updateActiveSession(updater) {
    updateSession(activeSessionId, updater);
  }

  function selectServer(serverId) {
    const nextServer = servers.find((item) => item.id === serverId);
    if (!nextServer) return;
    setActiveServerId(serverId);
    setActiveSessionId(serverId);
    setServerMenuOpen(false);
    setActiveRail("files");
    setSessions((items) => items.some((item) => item.id === serverId)
      ? items
      : [...items, { id: nextServer.id, label: nextServer.name, state: nextServer.state }]);
    setSessionStates((states) => states[serverId]
      ? states
      : { ...states, [serverId]: createSessionState(nextServer, true) });
  }

  function openConnections(view = "list") {
    setServerMenuOpen(false);
    setConnectionDialog({ open: true, view });
  }

  function closeSession(sessionId) {
    if (sessions.length === 1) return;
    const nextSessions = sessions.filter((item) => item.id !== sessionId);
    setSessions(nextSessions);
    setSessionStates((states) => {
      const next = { ...states };
      delete next[sessionId];
      return next;
    });
    if (activeSessionId === sessionId) {
      const nextServerId = nextSessions.at(-1).id;
      setActiveSessionId(nextServerId);
      setActiveServerId(nextServerId);
    }
  }

  function createServerConnection(values) {
    const baseId = values.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
    let id = baseId;
    let suffix = 2;
    while (servers.some((item) => item.id === id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const username = values.username.trim();
    const safeUser = username.replace(/[^a-zA-Z0-9_-]/g, "") || "user";
    const nextServer = {
      id,
      name: values.name.trim(),
      endpoint: `${username}@${values.host.trim()}:${values.port}`,
      host: values.host.trim(),
      port: values.port,
      username,
      authMethod: values.authMethod,
      group: values.group.trim() || "未分组",
      state: "connected",
      directory: username === "root" ? "/root" : `/home/${safeUser}`,
      metrics: createDemoMetrics(),
    };
    setServers((items) => [...items, nextServer]);
    setSessions((items) => [...items, { id, label: nextServer.name, state: nextServer.state }]);
    setSessionStates((states) => ({ ...states, [id]: createSessionState(nextServer, true) }));
    setActiveServerId(id);
    setActiveSessionId(id);
    setActiveRail("files");
    setConnectionDialog({ open: false, view: "list" });
  }

  function chooseCompletion(value) {
    updateActiveSession((current) => ({ ...current, command: value, completionOpen: false }));
  }

  function handleCommandChange(value) {
    updateActiveSession((current) => ({
      ...current,
      command: value,
      completionIndex: 0,
      completionOpen: current.completionOpen,
    }));
  }

  function handleCommandKeyDown(event, suggestions) {
    if (event.nativeEvent?.isComposing) return;
    const opensTemplates = event.ctrlKey
      && ((event.shiftKey && event.key.toLowerCase() === "p") || event.code === "Space");
    if (opensTemplates) {
      event.preventDefault();
      updateActiveSession({ completionOpen: true, completionIndex: 0 });
      return;
    }
    if (activeSession.completionOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      updateActiveSession((current) => ({
        ...current,
        completionIndex: (current.completionIndex + delta + suggestions.length) % Math.max(suggestions.length, 1),
      }));
      return;
    }
    if (activeSession.completionOpen && ["Enter", "Tab"].includes(event.key) && suggestions.length) {
      event.preventDefault();
      chooseCompletion(suggestions[activeSession.completionIndex]?.command || suggestions[0].command);
      return;
    }
    if (event.key === "Escape") {
      updateActiveSession({ completionOpen: false });
      return;
    }
    if (event.key === "Enter" && activeSession.command.trim()) {
      event.preventDefault();
      const submitted = activeSession.command.trim();
      const known = submitted.startsWith("journalctl");
      updateActiveSession((current) => ({
        ...current,
        lines: [
          ...current.lines,
          { kind: "command", prompt: `[${server.username || "root"}@${server.name} 20260714_101530]$`, text: ` ${submitted}` },
          { kind: known ? "muted" : "error", text: known ? "-- Logs begin at Mon 2026-07-14 09:00:01 CST. Press Ctrl+C to stop. --" : `bash: ${submitted}: command not found` },
        ],
        command: "",
        completionOpen: false,
      }));
    }
  }

  function receiveUploads(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const nextTransfers = files.map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      fileName: file.name,
      sizeLabel: formatFileSize(file.size),
      target: `${server.directory}/${file.name}`,
      progress: 0,
      speed: "8.6 MB/s",
      state: "uploading",
      serverId: server.id,
      autoAdvance: true,
    }));
    setTransfers((items) => [...nextTransfers, ...items]);
    setActiveBottomTab("transfer");
    setBottomVisible(true);
    setBottomCollapsed(false);
  }

  function openBottomTab(tab) {
    setActiveBottomTab(tab);
    setBottomVisible(true);
    setBottomCollapsed(false);
  }

  function handleRailChange(item) {
    setActiveRail(item);
    if (item === "monitor") openBottomTab("monitor");
    if (item === "transfers") openBottomTab("transfer");
  }

  function updateTransfer(transferId, patch) {
    setTransfers((items) => items.map((item) => (item.id === transferId ? { ...item, ...patch } : item)));
  }

  const panelHeightKey = activeBottomTab === "monitor" ? "monitor" : "standard";
  const bottomPanelHeight = bottomPanelHeights[panelHeightKey];
  const taskPanelHeight = bottomVisible ? (bottomCollapsed ? 52 : bottomPanelHeight) : 0;

  return (
    <div className="app-root" style={{ "--accent": appearance.accent }}>
      <main className={`app-shell ${railVisible ? "" : "is-rail-hidden"}`} style={{ "--task-panel-h": `${taskPanelHeight}px` }}>
      <TopBar
        server={server}
        servers={servers}
        metrics={metrics}
        menuOpen={serverMenuOpen}
        onToggleMenu={() => setServerMenuOpen((value) => !value)}
        onSelectServer={selectServer}
        onAddServer={() => openConnections("new")}
        onToggleRail={() => setRailVisible((value) => !value)}
        onOpenMonitor={() => openBottomTab("monitor")}
      />
      {railVisible && <ActivityRail
        activeItem={activeRail}
        settingsOpen={settingsOpen}
        onChange={handleRailChange}
        onOpenSettings={() => setSettingsOpen(true)}
      />}
      <div className="workbench">
        <ExplorerPanel
          mode={activeRail}
          server={server}
          servers={servers}
          activeServerId={activeServerId}
          onUpload={receiveUploads}
          onOpenBottomTab={openBottomTab}
          onCreateSession={() => openConnections("list")}
          onSelectServer={selectServer}
          onOpenConnections={openConnections}
        />
        <TerminalPane
          server={server}
          sessions={sessions}
          activeSessionId={activeSessionId}
          lines={activeSession.lines}
          command={activeSession.command}
          completionOpen={activeSession.completionOpen}
          completionIndex={activeSession.completionIndex}
          appearance={appearance}
          onSessionSelect={selectServer}
          onSessionAdd={() => openConnections("new")}
          onSessionClose={closeSession}
          onCommandChange={handleCommandChange}
          onCommandKeyDown={handleCommandKeyDown}
          onCompletionOpen={() => updateActiveSession({ completionOpen: true, completionIndex: 0 })}
          onCompletionSelect={chooseCompletion}
        />
        {bottomVisible && <BottomPanel
          activeTab={activeBottomTab}
          collapsed={bottomCollapsed}
          transfers={transfers}
          servers={servers}
          server={server}
          metrics={metrics}
          sampledAt={sampledAt}
          onTabChange={openBottomTab}
          onToggle={() => setBottomCollapsed((value) => !value)}
          onClose={() => setBottomVisible(false)}
          onResize={(height) => setBottomPanelHeights((current) => ({ ...current, [panelHeightKey]: height }))}
          onResetResize={() => setBottomPanelHeights((current) => ({
            ...current,
            [panelHeightKey]: panelHeightKey === "monitor" ? DEFAULT_MONITOR_PANEL_HEIGHT : DEFAULT_BOTTOM_PANEL_HEIGHT,
          }))}
          onCancel={(transferId) => updateTransfer(transferId, { state: "cancelled", autoAdvance: false })}
          onRetry={(transferId) => updateTransfer(transferId, { progress: 0, state: "uploading", autoAdvance: true })}
        />}
        <StatusBar server={server} />
      </div>
      </main>
      <ConnectionDialog
        open={connectionDialog.open}
        initialView={connectionDialog.view}
        servers={servers}
        activeServerId={activeServerId}
        onClose={() => setConnectionDialog({ open: false, view: "list" })}
        onSelectServer={(serverId) => {
          selectServer(serverId);
          setConnectionDialog({ open: false, view: "list" });
        }}
        onCreateServer={createServerConnection}
      />
      <SettingsDialog
        open={settingsOpen}
        theme={appearance}
        onThemeChange={(patch) => setAppearance((current) => ({ ...current, ...patch }))}
        onWallpaperChange={({ name, url }) => setAppearance((current) => ({ ...current, wallpaperName: name, wallpaperUrl: url }))}
        onRemoveWallpaper={() => setAppearance((current) => ({ ...current, wallpaperName: "", wallpaperUrl: "" }))}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export function App() {
  if (isNativeRuntimeAvailable()) return <NativeApp />;
  if (isRunningInElectron()) {
    return (
      <main className="native-runtime-error" role="alert">
        <strong>原生客户端初始化失败</strong>
        <span>Electron 安全桥未正确加载。请关闭客户端并重新启动；当前不会降级到模拟模式。</span>
      </main>
    );
  }
  return <DemoApp />;
}
