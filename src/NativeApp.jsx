import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrives, Plus } from "@phosphor-icons/react";
import { ActivityRail } from "./components/ActivityRail.jsx";
import { BottomPanel } from "./components/BottomPanel.jsx";
import { ConnectionDialog } from "./components/ConnectionDialog.jsx";
import { ExplorerPanel } from "./components/ExplorerPanel.jsx";
import { HostKeyDialog } from "./components/HostKeyDialog.jsx";
import { NativeTerminalPane } from "./components/NativeTerminalPane.jsx";
import { PasswordDialog } from "./components/PasswordDialog.jsx";
import { SettingsDialog } from "./components/SettingsDialog.jsx";
import { StatusBar } from "./components/StatusBar.jsx";
import { TopBar } from "./components/TopBar.jsx";
import { getNativeClient } from "./native/client.js";
import "./native-styles.css";
import "./update-styles.css";
import "./credential-styles.css";

const DEFAULT_BOTTOM_PANEL_HEIGHT = 168;
const DEFAULT_MONITOR_PANEL_HEIGHT = 344;
const ACTIVE_TRANSFER_STATES = new Set(["queued", "uploading", "cancelling", "finalizing"]);
const DEFAULT_APPEARANCE = {
  accent: "#9d84f8",
  terminalBackground: "#061423",
  terminalForeground: "#c8cbd1",
  wallpaperOpacity: 0.22,
  wallpaperName: "",
  wallpaperUrl: "",
};

function createWorkspace(connectionId) {
  return {
    connectionId,
    sessionId: null,
    state: "disconnected",
    error: "",
    directory: null,
    entries: [],
    filesLoading: false,
    filesError: "",
    sftpError: "",
    metrics: null,
    monitorLoading: false,
    monitorError: "",
    sampledAt: "",
    transfers: [],
    issues: [],
  };
}

function endpoint(connection) {
  return `${connection.username}@${connection.host}:${connection.port}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function toUiTransfer(transfer) {
  return {
    ...transfer,
    serverId: transfer.connectionId,
    sizeLabel: formatBytes(transfer.size),
    speed: transfer.speed > 0 ? `${formatBytes(transfer.speed)}/s` : "—",
  };
}

function formatSampleTime(isoValue) {
  const date = new Date(isoValue);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function NativeApp() {
  const client = useMemo(() => getNativeClient(), []);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const [workspaces, setWorkspaces] = useState({});
  const workspacesRef = useRef({});
  const [workspaceOrder, setWorkspaceOrder] = useState([]);
  const [activeConnectionId, setActiveConnectionId] = useState(null);
  const [activeRail, setActiveRail] = useState("connections");
  const [railVisible, setRailVisible] = useState(true);
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [connectionDialog, setConnectionDialog] = useState({ open: false, view: "list" });
  const [passwordConnectionId, setPasswordConnectionId] = useState(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [updateState, setUpdateState] = useState(null);
  const [updateActionError, setUpdateActionError] = useState("");
  const [credentialStorage, setCredentialStorage] = useState({ available: false, protection: "windows-user" });
  const [activeBottomTab, setActiveBottomTab] = useState("transfer");
  const [bottomVisible, setBottomVisible] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomPanelHeights, setBottomPanelHeights] = useState({
    standard: DEFAULT_BOTTOM_PANEL_HEIGHT,
    monitor: DEFAULT_MONITOR_PANEL_HEIGHT,
  });
  const activeConnectionIdRef = useRef(null);
  const pendingSecretsRef = useRef(new Map());
  const attemptsRef = useRef(new Map());
  const directoryRequestsRef = useRef(new Map());
  const monitorInFlightRef = useRef(new Set());
  activeConnectionIdRef.current = activeConnectionId;

  const updateWorkspace = useCallback((connectionId, updater) => {
    const current = workspacesRef.current;
    const existing = current[connectionId] || createWorkspace(connectionId);
    const nextWorkspace = typeof updater === "function" ? updater(existing) : { ...existing, ...updater };
    const next = { ...current, [connectionId]: nextWorkspace };
    workspacesRef.current = next;
    setWorkspaces(next);
  }, []);

  const addIssue = useCallback((connectionId, title, detail, code = "runtime") => {
    updateWorkspace(connectionId, (workspace) => ({
      ...workspace,
      issues: [
        { id: `${Date.now()}-${code}`, title, detail },
        ...workspace.issues,
      ].slice(0, 20),
    }));
  }, [updateWorkspace]);

  const loadDirectory = useCallback(async (connectionId, remotePath, sessionIdOverride) => {
    const workspace = workspacesRef.current[connectionId];
    const sessionId = sessionIdOverride || workspace?.sessionId;
    if (!sessionId || !remotePath) return;
    const requestId = crypto.randomUUID();
    directoryRequestsRef.current.set(connectionId, { requestId, sessionId });
    const isCurrentRequest = () => {
      const request = directoryRequestsRef.current.get(connectionId);
      return request?.requestId === requestId
        && request.sessionId === sessionId
        && workspacesRef.current[connectionId]?.sessionId === sessionId;
    };
    updateWorkspace(connectionId, { filesLoading: true, filesError: "" });
    try {
      const result = await client.sftp.list(sessionId, remotePath);
      if (!isCurrentRequest()) return;
      updateWorkspace(connectionId, {
        directory: result.path,
        entries: result.entries,
        filesLoading: false,
        filesError: "",
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      updateWorkspace(connectionId, { filesLoading: false, filesError: error.message });
      addIssue(connectionId, "无法读取远程目录", error.message, error.code);
    } finally {
      if (directoryRequestsRef.current.get(connectionId)?.requestId === requestId) {
        directoryRequestsRef.current.delete(connectionId);
      }
    }
  }, [addIssue, client, updateWorkspace]);

  const sampleMonitor = useCallback(async (connectionId, sessionIdOverride) => {
    const workspace = workspacesRef.current[connectionId];
    const sessionId = sessionIdOverride || workspace?.sessionId;
    if (!sessionId || monitorInFlightRef.current.has(sessionId)) return;
    monitorInFlightRef.current.add(sessionId);
    updateWorkspace(connectionId, { monitorLoading: true, monitorError: "" });
    try {
      const sample = await client.monitor.sample(sessionId);
      if (workspacesRef.current[connectionId]?.sessionId !== sessionId) return;
      updateWorkspace(connectionId, (current) => {
        if (current.sessionId !== sessionId) return current;
        const history = [
          ...(current.metrics?.history || []),
          {
            time: new Date(sample.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }),
            down: sample.down,
            up: sample.up,
          },
        ].slice(-30);
        return {
          ...current,
          metrics: { ...sample, history },
          sampledAt: formatSampleTime(sample.sampledAt),
          monitorLoading: false,
          monitorError: "",
        };
      });
    } catch (error) {
      if (workspacesRef.current[connectionId]?.sessionId !== sessionId) return;
      updateWorkspace(connectionId, { monitorLoading: false, monitorError: error.message });
      addIssue(connectionId, "性能采样失败", error.message, error.code);
    } finally {
      monitorInFlightRef.current.delete(sessionId);
    }
  }, [addIssue, client, updateWorkspace]);

  useEffect(() => {
    let cancelled = false;
    void client.connections.list()
      .then((items) => {
        if (cancelled) return;
        setConnections(items);
        setLoading(false);
        if (items.length === 0) setConnectionDialog({ open: true, view: "new" });
      })
      .catch((error) => {
        if (cancelled) return;
        setFatalError(error.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void client.credentials.status()
      .then((status) => {
        if (!cancelled) setCredentialStorage(status);
      })
      .catch(() => {
        if (!cancelled) setCredentialStorage({ available: false, protection: "windows-user" });
      });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = client.events.onUpdateStatus((state) => {
      if (disposed) return;
      setUpdateActionError("");
      setUpdateState(state);
    });
    void client.updates.status()
      .then((state) => {
        if (!disposed) setUpdateState(state);
      })
      .catch((error) => {
        if (!disposed) setUpdateActionError(error.message);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    const unsubscribeState = client.events.onSessionState((event) => {
      const connectionId = event?.connectionId;
      if (!connectionId || !event.sessionId) return;
      const currentWorkspace = workspacesRef.current[connectionId];
      if (currentWorkspace?.sessionId !== event.sessionId) return;
      updateWorkspace(connectionId, (workspace) => {
        return {
          ...workspace,
          state: event.state,
          error: event.error?.message || (event.state === "error" ? "SSH 会话发生错误。" : ""),
          ...(event.state === "disconnected" ? { sessionId: null } : {}),
        };
      });
      if (event.error?.message) addIssue(connectionId, "SSH 会话错误", event.error.message, event.error.code);
    });
    const unsubscribeTransfer = client.events.onTransferProgress((event) => {
      if (!event?.connectionId || !event.sessionId) return;
      const currentWorkspace = workspacesRef.current[event.connectionId];
      if (currentWorkspace?.sessionId !== event.sessionId) return;
      updateWorkspace(event.connectionId, (workspace) => {
        const transfer = toUiTransfer(event);
        const exists = workspace.transfers.some((item) => item.id === transfer.id);
        return {
          ...workspace,
          transfers: exists
            ? workspace.transfers.map((item) => item.id === transfer.id ? transfer : item)
            : [transfer, ...workspace.transfers],
        };
      });
      if (event.state === "failed" && event.error?.message) {
        addIssue(event.connectionId, `上传失败：${event.fileName}`, event.error.message, event.error.code);
      }
      if (event.state === "success") {
        const workspace = workspacesRef.current[event.connectionId];
        if (workspace?.sessionId === event.sessionId && workspace.directory) {
          void loadDirectory(event.connectionId, workspace.directory, event.sessionId);
        }
      }
    });
    return () => {
      unsubscribeState();
      unsubscribeTransfer();
    };
  }, [addIssue, client, loadDirectory, updateWorkspace]);

  const activeWorkspace = activeConnectionId ? workspaces[activeConnectionId] : null;
  const servers = connections.map((connection) => {
    const workspace = workspaces[connection.id];
    return {
      ...connection,
      endpoint: endpoint(connection),
      state: workspace?.state || "disconnected",
      directory: workspace?.directory || null,
    };
  });
  const activeServer = servers.find((server) => server.id === activeConnectionId) || null;
  const sessions = workspaceOrder
    .map((connectionId) => {
      const server = servers.find((item) => item.id === connectionId);
      const workspace = workspaces[connectionId] || createWorkspace(connectionId);
      return server ? {
        id: connectionId,
        label: server.name,
        sessionId: workspace.sessionId,
        state: workspace.state,
        error: workspace.error,
      } : null;
    })
    .filter(Boolean);
  const passwordServer = servers.find((server) => server.id === passwordConnectionId) || null;
  const hasActiveTransfers = Object.values(workspaces).some((workspace) => workspace.transfers
    .some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state)));

  async function checkForUpdates() {
    setUpdateActionError("");
    try {
      setUpdateState(await client.updates.check());
    } catch (error) {
      setUpdateActionError(error.message);
    }
  }

  async function installUpdate() {
    setUpdateActionError("");
    try {
      await client.updates.install();
    } catch (error) {
      setUpdateActionError(error.message);
    }
  }

  function openConnections(view = "list") {
    setServerMenuOpen(false);
    setConnectionDialog({ open: true, view });
  }

  function openWorkspaceTab(connectionId) {
    setWorkspaceOrder((items) => items.includes(connectionId) ? items : [...items, connectionId]);
    setActiveConnectionId(connectionId);
    setActiveRail("files");
  }

  function selectServer(connectionId) {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) return;
    openWorkspaceTab(connectionId);
    setServerMenuOpen(false);
    const workspace = workspacesRef.current[connectionId];
    if (!workspace || ["disconnected", "error"].includes(workspace.state)) {
      if (connection.hasSavedPassword) void beginConnect(connectionId).catch(() => undefined);
      else setPasswordConnectionId(connectionId);
    }
  }

  async function connectTrusted(connectionId, credential, attemptId) {
    try {
      const result = await client.ssh.connect({
        connectionId,
        credential,
        dimensions: { cols: 120, rows: 32 },
      });
      if (attemptsRef.current.get(connectionId) !== attemptId) {
        await client.ssh.disconnect(result.sessionId);
        return;
      }
      pendingSecretsRef.current.delete(connectionId);
      attemptsRef.current.delete(connectionId);
      if (result.credentialPersistence?.state === "saved") {
        setConnections((items) => items.map((item) => item.id === connectionId
          ? { ...item, hasSavedPassword: true }
          : item));
      }
      updateWorkspace(connectionId, {
        sessionId: result.sessionId,
        state: "connected",
        error: "",
        directory: result.home,
        sftpError: result.sftpError?.message || "",
        filesError: result.sftpError?.message || "",
      });
      if (result.home) void loadDirectory(connectionId, result.home, result.sessionId);
      if (result.sftpError?.message) addIssue(connectionId, "SFTP 不可用", result.sftpError.message, result.sftpError.code);
      if (result.credentialPersistence?.state === "failed") {
        addIssue(
          connectionId,
          "已连接，但密码未保存",
          result.credentialPersistence.error?.message || "Windows 无法保存该密码。",
          result.credentialPersistence.error?.code,
        );
      }
      void sampleMonitor(connectionId, result.sessionId);
    } catch (error) {
      if (attemptsRef.current.get(connectionId) === attemptId) attemptsRef.current.delete(connectionId);
      pendingSecretsRef.current.delete(connectionId);
      updateWorkspace(connectionId, { state: "error", error: error.message, sessionId: null });
      addIssue(connectionId, "SSH 连接失败", error.message, error.code);
      if (credential.source === "saved" && [
        "AUTH_FAILED",
        "CREDENTIAL_DECRYPT_FAILED",
        "CREDENTIAL_STORAGE_UNAVAILABLE",
        "SAVED_PASSWORD_NOT_FOUND",
      ].includes(error.code)) {
        setPasswordConnectionId(connectionId);
      }
      throw error;
    }
  }

  async function beginConnect(connectionId, password, saveAfterConnect = false) {
    const attemptId = crypto.randomUUID();
    attemptsRef.current.set(connectionId, attemptId);
    const credential = typeof password === "string"
      ? { source: "provided", password, saveAfterConnect }
      : { source: "saved" };
    pendingSecretsRef.current.set(connectionId, credential);
    openWorkspaceTab(connectionId);
    updateWorkspace(connectionId, { state: "connecting", error: "" });
    try {
      const probe = await client.hostKeys.probe(connectionId);
      if (attemptsRef.current.get(connectionId) !== attemptId) return;
      if (probe.status === "unknown") {
        setHostKeyPrompt({ ...probe, connectionId, attemptId });
        return;
      }
      if (probe.status === "mismatch") {
        pendingSecretsRef.current.delete(connectionId);
        attemptsRef.current.delete(connectionId);
        updateWorkspace(connectionId, { state: "error", error: "服务器主机指纹已变化，连接已阻断。" });
        setHostKeyPrompt({ ...probe, connectionId, attemptId });
        addIssue(connectionId, "服务器主机指纹已变化", "已信任指纹与本次收到的指纹不同，客户端已阻断连接。", "HOST_KEY_MISMATCH");
        return;
      }
      return connectTrusted(connectionId, credential, attemptId);
    } catch (error) {
      if (attemptsRef.current.get(connectionId) === attemptId) attemptsRef.current.delete(connectionId);
      pendingSecretsRef.current.delete(connectionId);
      updateWorkspace(connectionId, { state: "error", error: error.message });
      addIssue(connectionId, "连接准备失败", error.message, error.code);
      throw error;
    }
  }

  async function createServerConnection(values, { password, savePassword }) {
    const saved = await client.connections.save(values);
    setConnections((items) => [...items, { ...saved, hasSavedPassword: false }]);
    setConnectionDialog({ open: false, view: "list" });
    void beginConnect(saved.id, password, savePassword).catch(() => undefined);
  }

  async function submitSavedPassword(password, { savePassword }) {
    const connectionId = passwordConnectionId;
    if (!connectionId) return;
    await beginConnect(connectionId, password, savePassword);
    setPasswordConnectionId(null);
  }

  async function forgetSavedPassword(connectionId) {
    await client.credentials.remove(connectionId);
    setConnections((items) => items.map((item) => item.id === connectionId
      ? { ...item, hasSavedPassword: false }
      : item));
  }

  async function deleteServerConnection(connectionId) {
    const workspace = workspacesRef.current[connectionId];
    if (workspace?.transfers.some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state))) {
      throw new Error("该服务器仍有活动传输，请完成或取消传输后再删除连接。");
    }

    attemptsRef.current.delete(connectionId);
    pendingSecretsRef.current.delete(connectionId);
    directoryRequestsRef.current.delete(connectionId);
    if (workspace?.sessionId) await client.ssh.disconnect(workspace.sessionId);
    await client.connections.remove(connectionId);

    const nextWorkspaces = { ...workspacesRef.current };
    delete nextWorkspaces[connectionId];
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    setConnections((items) => items.filter((item) => item.id !== connectionId));

    const nextOrder = workspaceOrder.filter((id) => id !== connectionId);
    setWorkspaceOrder(nextOrder);
    if (activeConnectionId === connectionId) {
      const nextActiveId = nextOrder.at(-1) || null;
      setActiveConnectionId(nextActiveId);
      if (!nextActiveId) setActiveRail("connections");
    }
    if (passwordConnectionId === connectionId) setPasswordConnectionId(null);
  }

  async function acceptHostKey() {
    if (!hostKeyPrompt || hostKeyPrompt.status !== "unknown") return;
    const { connectionId, attemptId, challengeId } = hostKeyPrompt;
    await client.hostKeys.accept(challengeId);
    if (attemptsRef.current.get(connectionId) !== attemptId) return;
    const secret = pendingSecretsRef.current.get(connectionId);
    if (!secret) throw new Error("本次连接密码已清除，请重新连接。" );
    setHostKeyPrompt(null);
    await connectTrusted(connectionId, secret, attemptId);
  }

  function closeHostKeyPrompt() {
    if (hostKeyPrompt?.connectionId) {
      pendingSecretsRef.current.delete(hostKeyPrompt.connectionId);
      attemptsRef.current.delete(hostKeyPrompt.connectionId);
      if (hostKeyPrompt.status === "unknown") {
        updateWorkspace(hostKeyPrompt.connectionId, { state: "disconnected", error: "已取消主机指纹确认。" });
      }
    }
    setHostKeyPrompt(null);
  }

  function closeWorkspace(connectionId) {
    attemptsRef.current.delete(connectionId);
    pendingSecretsRef.current.delete(connectionId);
    directoryRequestsRef.current.delete(connectionId);
    const workspace = workspacesRef.current[connectionId];
    if (workspace?.transfers.some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state))) {
      addIssue(connectionId, "工作区仍有活动传输", "请等待上传完成或取消传输后再关闭工作区。", "ACTIVE_TRANSFER");
      setActiveConnectionId(connectionId);
      openBottomTab("transfer");
      return;
    }
    if (workspace?.sessionId) void client.ssh.disconnect(workspace.sessionId);
    updateWorkspace(connectionId, {
      sessionId: null,
      state: "disconnected",
      error: "",
      filesLoading: false,
      monitorLoading: false,
    });
    const next = workspaceOrder.filter((id) => id !== connectionId);
    setWorkspaceOrder(next);
    if (activeConnectionId === connectionId) {
      const nextActiveId = next.at(-1) || null;
      setActiveConnectionId(nextActiveId);
      if (!nextActiveId) setActiveRail("connections");
    }
  }

  async function uploadFiles(files) {
    const connectionId = activeConnectionIdRef.current;
    const workspaceAtStart = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspaceAtStart?.sessionId || !workspaceAtStart.directory) {
      if (connectionId) addIssue(connectionId, "无法上传文件", "当前工作区没有可用的 SFTP 目录。", "SFTP_UNAVAILABLE");
      return;
    }
    const sessionId = workspaceAtStart.sessionId;
    const directory = workspaceAtStart.directory;
    try {
      const transfers = await client.sftp.upload(sessionId, directory, files);
      if (workspacesRef.current[connectionId]?.sessionId !== sessionId) return;
      updateWorkspace(connectionId, (workspace) => ({
        ...workspace,
        transfers: [
          ...transfers.map(toUiTransfer),
          ...workspace.transfers.filter((existing) => !transfers.some((item) => item.id === existing.id)),
        ],
      }));
      if (activeConnectionIdRef.current === connectionId) openBottomTab("transfer");
    } catch (error) {
      if (workspacesRef.current[connectionId]?.sessionId !== sessionId) return;
      addIssue(connectionId, "无法开始上传", error.message, error.code);
      if (activeConnectionIdRef.current === connectionId) openBottomTab("issues");
    }
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

  const onTerminalError = useCallback((error, connectionId) => {
    if (!connectionId) return;
    addIssue(connectionId, "终端通信失败", error?.message || "终端通信发生错误。", error?.code);
  }, [addIssue]);

  useEffect(() => {
    if (!activeConnectionId || !activeWorkspace?.sessionId || activeWorkspace.state !== "connected") return undefined;
    void sampleMonitor(activeConnectionId, activeWorkspace.sessionId);
    const interval = window.setInterval(() => {
      void sampleMonitor(activeConnectionId, activeWorkspace.sessionId);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [activeConnectionId, activeWorkspace?.sessionId, activeWorkspace?.state, sampleMonitor]);

  const panelHeightKey = activeBottomTab === "monitor" ? "monitor" : "standard";
  const bottomPanelHeight = bottomPanelHeights[panelHeightKey];
  const taskPanelHeight = bottomVisible && activeServer ? (bottomCollapsed ? 52 : bottomPanelHeight) : 0;

  if (loading) {
    return <main className="native-startup-state" role="status"><HardDrives size={34} weight="duotone" /><strong>正在加载本机连接配置…</strong></main>;
  }
  if (fatalError) {
    return <main className="native-startup-state is-error" role="alert"><HardDrives size={34} weight="duotone" /><strong>无法启动原生客户端</strong><span>{fatalError}</span></main>;
  }

  return (
    <div className="app-root" style={{ "--accent": appearance.accent }}>
      <main className={`app-shell ${railVisible ? "" : "is-rail-hidden"}`} style={{ "--task-panel-h": `${taskPanelHeight}px` }}>
        <TopBar
          runtimeMode="native"
          server={activeServer}
          servers={servers}
          metrics={activeWorkspace?.metrics || null}
          menuOpen={serverMenuOpen}
          onToggleMenu={() => setServerMenuOpen((value) => !value)}
          onSelectServer={selectServer}
          onAddServer={() => openConnections("new")}
          onToggleRail={() => setRailVisible((value) => !value)}
          onOpenMonitor={() => activeServer && openBottomTab("monitor")}
        />
        {railVisible && <ActivityRail
          activeItem={activeRail}
          settingsOpen={settingsOpen}
          onChange={handleRailChange}
          onOpenSettings={() => setSettingsOpen(true)}
        />}
        <div className="workbench">
          <ExplorerPanel
            mode={activeServer ? activeRail : "connections"}
            runtimeMode="native"
            server={activeServer}
            servers={servers}
            activeServerId={activeConnectionId}
            fileState={activeWorkspace ? {
              path: activeWorkspace.directory,
              entries: activeWorkspace.entries,
              loading: activeWorkspace.filesLoading,
              error: activeWorkspace.filesError,
            } : null}
            onUpload={uploadFiles}
            onRefresh={() => activeWorkspace?.directory && void loadDirectory(activeConnectionId, activeWorkspace.directory)}
            onNavigate={(path) => void loadDirectory(activeConnectionId, path)}
            onOpenBottomTab={openBottomTab}
            onCreateSession={() => openConnections("list")}
            onSelectServer={selectServer}
            onOpenConnections={openConnections}
          />
          {sessions.length ? (
            <NativeTerminalPane
              client={client}
              sessions={sessions}
              activeSessionId={activeConnectionId}
              appearance={appearance}
              onSessionSelect={setActiveConnectionId}
              onSessionAdd={() => openConnections("new")}
              onSessionClose={closeWorkspace}
              onTerminalError={onTerminalError}
            />
          ) : (
            <section className="terminal-pane native-empty-workspace">
              <HardDrives size={46} weight="duotone" />
              <strong>打开一个服务器工作区</strong>
              <span>每台服务器会保留独立的终端、远程目录和监控状态。</span>
              <button type="button" className="primary-button" onClick={() => openConnections(connections.length ? "list" : "new")}><Plus size={18} /> {connections.length ? "选择服务器" : "新增 SSH 服务器"}</button>
            </section>
          )}
          {bottomVisible && activeServer && <BottomPanel
            runtimeMode="native"
            activeTab={activeBottomTab}
            collapsed={bottomCollapsed}
            transfers={activeWorkspace?.transfers || []}
            servers={servers}
            server={activeServer}
            metrics={activeWorkspace?.metrics || null}
            sampledAt={activeWorkspace?.sampledAt || "尚未采样"}
            monitorLoading={activeWorkspace?.monitorLoading}
            monitorError={activeWorkspace?.monitorError}
            issues={activeWorkspace?.issues || []}
            onTabChange={openBottomTab}
            onToggle={() => setBottomCollapsed((value) => !value)}
            onClose={() => setBottomVisible(false)}
            onResize={(height) => setBottomPanelHeights((current) => ({ ...current, [panelHeightKey]: height }))}
            onResetResize={() => setBottomPanelHeights((current) => ({
              ...current,
              [panelHeightKey]: panelHeightKey === "monitor" ? DEFAULT_MONITOR_PANEL_HEIGHT : DEFAULT_BOTTOM_PANEL_HEIGHT,
            }))}
            onCancel={(transferId) => void client.sftp.cancel(transferId).catch((error) => addIssue(activeConnectionId, "取消传输失败", error.message, error.code))}
            onRetry={(transferId) => void client.sftp.retry(transferId).catch((error) => addIssue(activeConnectionId, "重试传输失败", error.message, error.code))}
          />}
          <StatusBar runtimeMode="native" server={activeServer} error={activeWorkspace?.error} />
        </div>
      </main>

      <ConnectionDialog
        runtimeMode="native"
        open={connectionDialog.open}
        initialView={connectionDialog.view}
        servers={servers}
        activeServerId={activeConnectionId}
        onClose={() => setConnectionDialog({ open: false, view: "list" })}
        onSelectServer={selectServer}
        onCreateServer={createServerConnection}
        onForgetPassword={forgetSavedPassword}
        onDeleteServer={deleteServerConnection}
        credentialStorage={credentialStorage}
      />
      <PasswordDialog
        open={Boolean(passwordConnectionId)}
        server={passwordServer}
        credentialStorage={credentialStorage}
        onClose={() => setPasswordConnectionId(null)}
        onSubmit={submitSavedPassword}
      />
      <HostKeyDialog prompt={hostKeyPrompt} onAccept={acceptHostKey} onClose={closeHostKeyPrompt} />
      <SettingsDialog
        open={settingsOpen}
        theme={appearance}
        onThemeChange={(patch) => setAppearance((current) => ({ ...current, ...patch }))}
        onWallpaperChange={({ name, url }) => setAppearance((current) => ({ ...current, wallpaperName: name, wallpaperUrl: url }))}
        onRemoveWallpaper={() => setAppearance((current) => ({ ...current, wallpaperName: "", wallpaperUrl: "" }))}
        updateState={updateState}
        updateActionError={updateActionError}
        hasActiveTransfers={hasActiveTransfers}
        onCheckUpdate={checkForUpdates}
        onInstallUpdate={installUpdate}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
