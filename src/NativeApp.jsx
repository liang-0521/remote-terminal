import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HardDrives, Plus } from "@phosphor-icons/react";
import { ActivityRail } from "./components/shell/ActivityRail.jsx";
import { BottomPanel } from "./components/shell/BottomPanel.jsx";
import { CloseRequestDialog } from "./components/connections/CloseRequestDialog.jsx";
import { ConnectionDialog } from "./components/connections/ConnectionDialog.jsx";
import { ExplorerPanel } from "./components/files/ExplorerPanel.jsx";
import { RemoteTextEditor } from "./components/files/RemoteTextEditor.jsx";
import { UnsavedChangesDialog } from "./components/files/UnsavedChangesDialog.jsx";
import { UploadConflictDialog } from "./components/files/UploadConflictDialog.jsx";
import { HostKeyDialog } from "./components/connections/HostKeyDialog.jsx";
import { PasswordDialog } from "./components/connections/PasswordDialog.jsx";
import { SettingsDialog } from "./components/settings/SettingsDialog.jsx";
import { StatusBar } from "./components/shell/StatusBar.jsx";
import { TopBar } from "./components/shell/TopBar.jsx";
import { DEFAULT_EXPLORER_WIDTH, WorkspaceResizeHandle } from "./components/shell/WorkspaceResizeHandle.jsx";
import { getNativeClient } from "./native/client.js";
import { resolveInterfaceColorScheme } from "./services/interface-theme.js";
import { shouldRefreshRemoteDirectory } from "./services/transfer-state.js";
import "./native-styles.css";
import "./update-styles.css";
import "./credential-styles.css";
import "./theme-styles.css";
import "./feature-styles.css";

const NativeTerminalPane = lazy(() => import("./components/terminal/NativeTerminalPane.jsx")
  .then(({ NativeTerminalPane: component }) => ({ default: component })));

const DEFAULT_BOTTOM_PANEL_HEIGHT = 344;
const ACTIVE_TRANSFER_STATES = new Set(["queued", "uploading", "cancelling", "finalizing"]);
const DEFAULT_APPEARANCE = {
  accent: "#9d84f8",
  terminalBackground: "#061423",
  terminalForeground: "#c8cbd1",
  wallpaperOpacity: 0.22,
  wallpaperName: "",
  wallpaperUrl: "",
};

function accentContrast(hexColor) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hexColor || "");
  if (!match) return "#ffffff";
  const [red, green, blue] = match.slice(1).map((channel) => Number.parseInt(channel, 16));
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62 ? "#111827" : "#ffffff";
}

function createWorkspace(connectionId) {
  return {
    connectionId,
    sessionId: null,
    terminalSessionId: null,
    state: "disconnected",
    error: "",
    directory: null,
    entries: [],
    filesLoading: false,
    filesError: "",
    sftpError: "",
    completionCatalog: [],
    completionLoading: false,
    completionError: "",
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

function localFileName(file) {
  const path = typeof file === "string" ? file : file?.localPath;
  return typeof path === "string" ? path.split(/[\\/]/).at(-1) || "" : "";
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
  const [railExpanded, setRailExpanded] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(DEFAULT_EXPLORER_WIDTH);
  const [explorerPlacement, setExplorerPlacement] = useState("left");
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [connectionDialog, setConnectionDialog] = useState({ open: false, view: "list" });
  const [passwordConnectionId, setPasswordConnectionId] = useState(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeBehavior, setCloseBehavior] = useState(null);
  const [closeBehaviorError, setCloseBehaviorError] = useState("");
  const [closeRequestOpen, setCloseRequestOpen] = useState(false);
  const [closeRequestId, setCloseRequestId] = useState(null);
  const [closeRequestActiveSessionCount, setCloseRequestActiveSessionCount] = useState(0);
  const [closeRequestActiveTransferCount, setCloseRequestActiveTransferCount] = useState(0);
  const [closeRequestDirtyDocuments, setCloseRequestDirtyDocuments] = useState([]);
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [interfaceThemeMode, setInterfaceThemeMode] = useState("system");
  const [commandAssistanceMode, setCommandAssistanceMode] = useState("auto");
  const [monitorIntervalSeconds, setMonitorIntervalSeconds] = useState(1);
  const [uiPreferencesReady, setUiPreferencesReady] = useState(false);
  const [uiPreferencesError, setUiPreferencesError] = useState("");
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => (
    typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches
  ));
  const [updateState, setUpdateState] = useState(null);
  const [updateActionError, setUpdateActionError] = useState("");
  const [credentialStorage, setCredentialStorage] = useState({ available: false, protection: "windows-user" });
  const [dataDirectoryStatus, setDataDirectoryStatus] = useState(null);
  const [bottomVisible, setBottomVisible] = useState(true);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
  const [bottomView, setBottomView] = useState("transfer");
  const [openDocuments, setOpenDocuments] = useState([]);
  const [activeDocumentKey, setActiveDocumentKey] = useState(null);
  const [unsavedChangesRequest, setUnsavedChangesRequest] = useState(null);
  const [uploadConflictRequest, setUploadConflictRequest] = useState(null);
  const activeConnectionIdRef = useRef(null);
  const pendingSecretsRef = useRef(new Map());
  const attemptsRef = useRef(new Map());
  const directoryRequestsRef = useRef(new Map());
  const completionRequestsRef = useRef(new Map());
  const monitorInFlightRef = useRef(new Set());
  const uiPreferencesLoadedRef = useRef(false);
  const uiPreferencesSaveQueueRef = useRef(Promise.resolve());
  const openDocumentsRef = useRef([]);
  const unsavedChangesResolverRef = useRef(null);
  activeConnectionIdRef.current = activeConnectionId;
  openDocumentsRef.current = openDocuments;
  const interfaceColorScheme = resolveInterfaceColorScheme(interfaceThemeMode, systemPrefersDark);

  useEffect(() => {
    let cancelled = false;
    void client.app.getUiPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setInterfaceThemeMode(preferences.interfaceThemeMode);
        setAppearance((current) => ({ ...current, ...preferences.appearance }));
        setExplorerWidth(Math.round(preferences.explorerWidth));
        setExplorerPlacement(preferences.explorerPlacement || "left");
        setExplorerCollapsed(Boolean(preferences.explorerCollapsed));
        setRailExpanded(preferences.railExpanded);
        setBottomVisible(true);
        setBottomCollapsed(preferences.bottomCollapsed);
        setBottomPanelHeight(Math.round(preferences.bottomPanelHeight));
        setCommandAssistanceMode(preferences.commandAssistanceMode);
        setMonitorIntervalSeconds(preferences.monitorIntervalSeconds || 1);
        setUiPreferencesError("");
        uiPreferencesLoadedRef.current = true;
      })
      .catch((error) => {
        if (!cancelled) setUiPreferencesError(error.message || "无法读取已保存的界面设置。");
      })
      .finally(() => {
        if (!cancelled) setUiPreferencesReady(true);
      });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!uiPreferencesReady || !uiPreferencesLoadedRef.current) return;
    const preferences = {
      interfaceThemeMode,
      appearance: {
        accent: appearance.accent,
        terminalBackground: appearance.terminalBackground,
        terminalForeground: appearance.terminalForeground,
        wallpaperOpacity: appearance.wallpaperOpacity,
      },
      explorerWidth,
      explorerPlacement,
      explorerCollapsed,
      railExpanded,
      bottomVisible: true,
      bottomCollapsed,
      bottomPanelHeight,
      commandAssistanceMode,
      monitorIntervalSeconds,
    };
    const request = uiPreferencesSaveQueueRef.current
      .catch(() => undefined)
      .then(() => client.app.setUiPreferences(preferences));
    uiPreferencesSaveQueueRef.current = request;
    let active = true;
    void request
      .then(() => {
        if (active) setUiPreferencesError("");
      })
      .catch((error) => {
        if (active) setUiPreferencesError(error.message || "无法保存界面设置。");
      });
    return () => { active = false; };
  }, [
    appearance.accent,
    appearance.terminalBackground,
    appearance.terminalForeground,
    appearance.wallpaperOpacity,
    bottomCollapsed,
    bottomPanelHeight,
    bottomVisible,
    client,
    commandAssistanceMode,
    explorerWidth,
    explorerPlacement,
    explorerCollapsed,
    interfaceThemeMode,
    monitorIntervalSeconds,
    railExpanded,
    uiPreferencesReady,
  ]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const updateSystemPreference = (event) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(query.matches);
    query.addEventListener("change", updateSystemPreference);
    return () => query.removeEventListener("change", updateSystemPreference);
  }, []);

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

  const listRemoteDirectory = useCallback((remotePath) => {
    const connectionId = activeConnectionIdRef.current;
    const sessionId = connectionId ? workspacesRef.current[connectionId]?.sessionId : null;
    if (!sessionId) return Promise.reject(new Error("当前工作区没有可用的 SFTP 会话。"));
    return client.sftp.list(sessionId, remotePath);
  }, [client]);

  const loadCompletionCatalog = useCallback(async (connectionId, sessionIdOverride) => {
    const sessionId = sessionIdOverride || workspacesRef.current[connectionId]?.sessionId;
    if (!sessionId) return;
    const requestId = crypto.randomUUID();
    completionRequestsRef.current.set(connectionId, { requestId, sessionId });
    const isCurrentRequest = () => {
      const request = completionRequestsRef.current.get(connectionId);
      return request?.requestId === requestId
        && request.sessionId === sessionId
        && workspacesRef.current[connectionId]?.sessionId === sessionId;
    };
    updateWorkspace(connectionId, { completionLoading: true, completionError: "" });
    try {
      const completionCatalog = await client.terminal.completions(sessionId);
      if (!isCurrentRequest()) return;
      updateWorkspace(connectionId, {
        completionCatalog,
        completionLoading: false,
        completionError: "",
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      const message = error?.message || "无法加载服务器智能补全目录。";
      updateWorkspace(connectionId, { completionLoading: false, completionError: message });
      addIssue(connectionId, "智能补全加载失败", message, error?.code || "COMPLETION_CATALOG_FAILED");
    } finally {
      if (completionRequestsRef.current.get(connectionId)?.requestId === requestId) {
        completionRequestsRef.current.delete(connectionId);
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
    void client.storage.dataDirectoryStatus()
      .then((status) => {
        if (!cancelled) setDataDirectoryStatus(status);
      })
      .catch(() => {
        if (!cancelled) setDataDirectoryStatus(null);
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
    const initialCheckTimer = window.setTimeout(() => {
      void client.updates.check().catch(() => undefined);
    }, 10_000);
    const checkInterval = window.setInterval(() => {
      void client.updates.check().catch(() => undefined);
    }, 6 * 60 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearTimeout(initialCheckTimer);
      window.clearInterval(checkInterval);
      unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!client.app || !client.events.onCloseRequested) return undefined;
    let disposed = false;
    void client.app.getCloseBehavior()
      .then((behavior) => {
        if (!disposed) setCloseBehavior(behavior);
      })
      .catch((error) => {
        if (!disposed) setCloseBehaviorError(error.message);
    });
    const unsubscribe = client.events.onCloseRequested((event) => {
      if (disposed) return;
      if (typeof event?.requestId !== "string" || !event.requestId) return;
      const activeSessionCount = Number.isSafeInteger(event?.activeSessionCount)
        && event.activeSessionCount > 0
        ? event.activeSessionCount
        : 0;
      const activeTransferCount = Number.isSafeInteger(event?.activeTransferCount)
        && event.activeTransferCount > 0
        ? event.activeTransferCount
        : 0;
      setCloseRequestId(event.requestId);
      setCloseRequestActiveSessionCount(activeSessionCount);
      setCloseRequestActiveTransferCount(activeTransferCount);
      setCloseRequestDirtyDocuments(openDocumentsRef.current.filter((document) => document.dirty).map((document) => document.name));
      setCloseRequestOpen(true);
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
      if (event.state === "disconnected") {
        setOpenDocuments((current) => {
          const next = current.filter((document) => document.sessionId !== event.sessionId);
          setActiveDocumentKey((activeKey) => next.some((document) => document.key === activeKey) ? activeKey : null);
          return next;
        });
      }
    });
    const unsubscribeTransfer = client.events.onTransferProgress((event) => {
      if (!event?.connectionId || !event.sessionId) return;
      const currentWorkspace = workspacesRef.current[event.connectionId];
      if (currentWorkspace?.sessionId !== event.sessionId) return;
      const previousTransfer = currentWorkspace.transfers.find((item) => item.id === event.id);
      const justCompleted = shouldRefreshRemoteDirectory(previousTransfer?.state, event.state);
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
      if (justCompleted) {
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
        sessionId: workspace.terminalSessionId,
        state: workspace.state,
        error: workspace.error,
        completionCatalog: workspace.completionCatalog,
        completionLoading: workspace.completionLoading,
        completionError: workspace.completionError,
        directoryEntries: workspace.entries,
      } : null;
    })
    .filter(Boolean);
  const passwordServer = servers.find((server) => server.id === passwordConnectionId) || null;
  const hasActiveTransfers = Object.values(workspaces).some((workspace) => workspace.transfers
    .some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state)));
  const closeDialogActiveTransferCount = Math.max(
    hasActiveTransfers ? 1 : 0,
    closeRequestActiveTransferCount,
  );

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

  function chooseDataDirectory() {
    return client.dialog.openDirectory({ title: "选择 Remote Terminal 数据目录" });
  }

  async function changeDataDirectory(targetPath) {
    const result = await client.storage.changeDataDirectory(targetPath);
    setDataDirectoryStatus(result.status);
    return result;
  }

  async function changeCloseBehavior(behavior, { rethrow = false } = {}) {
    if (!client.app) return;
    setCloseBehaviorError("");
    try {
      setCloseBehavior(await client.app.setCloseBehavior(behavior));
    } catch (error) {
      setCloseBehaviorError(error.message);
      if (rethrow) throw error;
    }
  }

  async function resolveCloseRequest(action, { remember = false } = {}) {
    if (!client.app) return;
    if (!closeRequestId) throw new Error("关闭请求已失效，请重新关闭主窗口。");
    if (remember) await changeCloseBehavior(action, { rethrow: true });
    await client.app.resolveCloseRequest(closeRequestId, action);
    setCloseRequestOpen(false);
    setCloseRequestId(null);
    setCloseRequestActiveSessionCount(0);
    setCloseRequestActiveTransferCount(0);
    setCloseRequestDirtyDocuments([]);
  }

  function openConnections(view = "list") {
    setServerMenuOpen(false);
    setConnectionDialog({ open: true, view });
  }

  function openWorkspaceTab(connectionId) {
    setWorkspaceOrder((items) => items.includes(connectionId) ? items : [...items, connectionId]);
    setActiveConnectionId(connectionId);
    setActiveRail("files");
    if (explorerPlacement === "bottom") {
      setBottomView("files");
      setBottomCollapsed(false);
    }
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
        terminalSessionId: result.sessionId,
        state: "connected",
        error: "",
        directory: result.home,
        sftpError: result.sftpError?.message || "",
        filesError: result.sftpError?.message || "",
      });
      void loadCompletionCatalog(connectionId, result.sessionId);
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
    updateWorkspace(connectionId, {
      state: "connecting",
      error: "",
      completionCatalog: [],
      completionLoading: false,
      completionError: "",
    });
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

  function requestUnsavedChangesConfirmation(documents, actionLabel) {
    const dirtyDocuments = documents.filter((document) => document.dirty);
    if (!dirtyDocuments.length) return Promise.resolve(true);
    if (unsavedChangesResolverRef.current) unsavedChangesResolverRef.current(false);
    setActiveConnectionId(dirtyDocuments[0].connectionId);
    setActiveDocumentKey(dirtyDocuments[0].key);
    setUnsavedChangesRequest({ documents: dirtyDocuments, actionLabel });
    return new Promise((resolve) => {
      unsavedChangesResolverRef.current = resolve;
    });
  }

  function resolveUnsavedChangesConfirmation(confirmed) {
    const resolve = unsavedChangesResolverRef.current;
    unsavedChangesResolverRef.current = null;
    setUnsavedChangesRequest(null);
    resolve?.(confirmed);
  }

  async function deleteServerConnection(connectionId) {
    const workspace = workspacesRef.current[connectionId];
    if (workspace?.transfers.some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state))) {
      throw new Error("该服务器仍有活动传输，请完成或取消传输后再删除连接。");
    }
    const documents = openDocumentsRef.current.filter((document) => document.connectionId === connectionId);
    if (!await requestUnsavedChangesConfirmation(documents, "删除服务器连接")) return;

    attemptsRef.current.delete(connectionId);
    pendingSecretsRef.current.delete(connectionId);
    directoryRequestsRef.current.delete(connectionId);
    completionRequestsRef.current.delete(connectionId);
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

  async function closeWorkspace(connectionId) {
    const workspace = workspacesRef.current[connectionId];
    if (workspace?.transfers.some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state))) {
      addIssue(connectionId, "工作区仍有活动传输", "请等待上传完成或取消传输后再关闭工作区。", "ACTIVE_TRANSFER");
      setActiveConnectionId(connectionId);
      openTransferPanel();
      return;
    }
    const documents = openDocumentsRef.current.filter((document) => document.connectionId === connectionId);
    if (!await requestUnsavedChangesConfirmation(documents, "关闭工作区")) return;
    attemptsRef.current.delete(connectionId);
    pendingSecretsRef.current.delete(connectionId);
    directoryRequestsRef.current.delete(connectionId);
    completionRequestsRef.current.delete(connectionId);
    if (workspace?.sessionId) void client.ssh.disconnect(workspace.sessionId);
    setOpenDocuments((current) => {
      const next = current.filter((document) => document.connectionId !== connectionId);
      setActiveDocumentKey((activeKey) => next.some((document) => document.key === activeKey) ? activeKey : null);
      return next;
    });
    updateWorkspace(connectionId, {
      sessionId: null,
      terminalSessionId: null,
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

  async function startUpload({ connectionId, sessionId, directory, files }) {
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
      if (activeConnectionIdRef.current === connectionId) openTransferPanel();
    } catch (error) {
      if (workspacesRef.current[connectionId]?.sessionId !== sessionId) return;
      addIssue(connectionId, "无法开始上传", error.message, error.code);
      if (activeConnectionIdRef.current === connectionId) openTransferPanel();
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
    const existingEntries = new Map(workspaceAtStart.entries.map((entry) => [entry.name, entry]));
    const selected = Array.from(files || []);
    const blocked = selected.filter((file) => {
      const entry = existingEntries.get(localFileName(file));
      return entry && entry.type !== "file";
    });
    if (blocked.length) {
      setUploadConflictRequest({
        mode: "blocked",
        directory,
        names: blocked.map(localFileName),
      });
      return;
    }
    const conflicts = selected.filter((file) => existingEntries.get(localFileName(file))?.type === "file");
    const conflictNames = new Set(conflicts.map(localFileName));
    const preparedFiles = selected.map((file) => ({
      ...(typeof file === "string" ? { localPath: file } : file),
      overwrite: conflictNames.has(localFileName(file)),
    }));
    const request = { connectionId, sessionId, directory, files: preparedFiles };
    if (conflicts.length) {
      setUploadConflictRequest({
        ...request,
        mode: "overwrite",
        names: conflicts.map(localFileName),
      });
      return;
    }
    await startUpload(request);
  }

  async function confirmUploadConflict(request) {
    if (request.mode !== "overwrite") return;
    setUploadConflictRequest(null);
    await startUpload(request);
  }

  async function selectUploadFiles() {
    const connectionId = activeConnectionIdRef.current;
    if (!client.dialog?.openFiles) {
      if (connectionId) addIssue(connectionId, "无法选择上传文件", "当前原生运行时未提供系统文件选择器。", "FILE_DIALOG_UNAVAILABLE");
      return;
    }
    try {
      const files = await client.dialog.openFiles({ title: "选择要上传到当前远程目录的文件" });
      if (files.length) await uploadFiles(files);
    } catch (error) {
      if (connectionId) addIssue(connectionId, "无法选择上传文件", error.message, error.code);
    }
  }

  async function downloadRemoteFile(remotePath) {
    const connectionId = activeConnectionIdRef.current;
    const workspace = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspace?.sessionId) {
      throw new Error("当前工作区没有可用的 SFTP 会话。");
    }
    try {
      const result = await client.sftp.downloadToComputer(workspace.sessionId, remotePath);
      if (result?.cleanupError) {
        addIssue(
          connectionId,
          "文件已下载，但临时缓存未清理",
          result.cleanupError.message,
          result.cleanupError.code,
        );
      }
      return result;
    } catch (error) {
      addIssue(
        connectionId,
        "下载远程文件失败",
        error?.message || "无法下载远程文件。",
        error?.code || "SFTP_DOWNLOAD_FAILED",
      );
      throw error;
    }
  }

  async function deleteRemoteEntry(remotePath, expectedEntryType) {
    const connectionId = activeConnectionIdRef.current;
    const workspace = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspace?.sessionId) {
      throw new Error("当前工作区没有可用的 SFTP 会话。");
    }
    try {
      return await client.sftp.remove(workspace.sessionId, remotePath, expectedEntryType);
    } catch (error) {
      addIssue(
        connectionId,
        "删除远程条目失败",
        error?.message || "无法删除远程条目。",
        error?.code || "SFTP_DELETE_FAILED",
      );
      throw error;
    }
  }

  async function renameRemoteEntry(sourcePath, targetPath, expectedEntryType) {
    const connectionId = activeConnectionIdRef.current;
    const workspace = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspace?.sessionId) {
      throw new Error("当前工作区没有可用的 SFTP 会话。");
    }
    try {
      const result = await client.sftp.rename(
        workspace.sessionId,
        sourcePath,
        targetPath,
        expectedEntryType,
      );
      setOpenDocuments((current) => current.map((document) => document.path === sourcePath
        ? {
          ...document,
          key: `${document.connectionId}:${targetPath}`,
          path: targetPath,
          name: targetPath.split("/").at(-1) || document.name,
        }
        : document));
      setActiveDocumentKey((current) => current === `${connectionId}:${sourcePath}`
        ? `${connectionId}:${targetPath}`
        : current);
      return result;
    } catch (error) {
      addIssue(
        connectionId,
        "重命名或移动远程条目失败",
        error?.message || "无法重命名或移动远程条目。",
        error?.code || "SFTP_RENAME_FAILED",
      );
      throw error;
    }
  }

  async function createRemoteEntry(directory, name, entryType) {
    const connectionId = activeConnectionIdRef.current;
    const workspace = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspace?.sessionId) throw new Error("当前工作区没有可用的 SFTP 会话。");
    try {
      const result = await client.sftp.create(workspace.sessionId, directory, name, entryType);
      await loadDirectory(connectionId, directory, workspace.sessionId);
      return result;
    } catch (error) {
      addIssue(connectionId, `新建远程${entryType === "directory" ? "文件夹" : "文件"}失败`, error?.message || "无法创建远程条目。", error?.code || "SFTP_CREATE_FAILED");
      throw error;
    }
  }

  function openTransferPanel() {
    setBottomVisible(true);
    setBottomCollapsed(false);
    setBottomView("transfer");
  }

  function handleRailChange(item) {
    setActiveRail(item);
    if (item === "files" && explorerPlacement === "bottom") {
      setBottomView("files");
      setBottomCollapsed(false);
    }
  }

  function changeExplorerPlacement(placement) {
    setExplorerPlacement(placement);
    setExplorerCollapsed(false);
    if (placement === "bottom") {
      setBottomView("files");
      setBottomCollapsed(false);
    }
  }

  function openRemoteTextFile({ entry, path }) {
    const connectionId = activeConnectionIdRef.current;
    const workspace = connectionId ? workspacesRef.current[connectionId] : null;
    if (!connectionId || !workspace?.sessionId) {
      if (connectionId) addIssue(connectionId, "无法预览远程文件", "当前工作区没有可用的 SFTP 会话。", "SFTP_UNAVAILABLE");
      return;
    }
    const key = `${connectionId}:${path}`;
    setOpenDocuments((current) => {
      const existing = current.find((document) => document.key === key);
      if (existing) {
        return current.map((document) => document.key === key
          ? { ...document, sessionId: workspace.sessionId, name: entry.name }
          : document);
      }
      return [...current, {
        key,
        dirty: false,
      connectionId,
      sessionId: workspace.sessionId,
      path,
      name: entry.name,
      }];
    });
    setActiveDocumentKey(key);
  }

  function selectRemoteDocument(key) {
    if (!key) {
      setActiveDocumentKey(null);
      return;
    }
    const document = openDocuments.find((item) => item.key === key);
    if (!document) return;
    setActiveConnectionId(document.connectionId);
    setActiveDocumentKey(key);
  }

  async function closeRemoteDocument(key) {
    const document = openDocumentsRef.current.find((item) => item.key === key);
    if (!document) return;
    if (!await requestUnsavedChangesConfirmation([document], "关闭文件")) return;
    const currentDocuments = openDocumentsRef.current;
    const index = currentDocuments.findIndex((item) => item.key === key);
    const next = currentDocuments.filter((item) => item.key !== key);
    setOpenDocuments(next);
    if (activeDocumentKey === key) {
      const nextActive = next[index] || next[index - 1] || null;
      setActiveDocumentKey(nextActive?.key || null);
      if (nextActive) setActiveConnectionId(nextActive.connectionId);
    }
  }

  function updateRemoteDocumentDirty(key, dirty) {
    setOpenDocuments((current) => current.map((document) => (
      document.key === key && document.dirty !== dirty ? { ...document, dirty } : document
    )));
  }

  function reconnectWorkspace(connectionId) {
    const connection = connections.find((item) => item.id === connectionId);
    const workspace = workspacesRef.current[connectionId];
    if (!connection || workspace?.state === "connecting") return;
    if (connection.hasSavedPassword) void beginConnect(connectionId).catch(() => undefined);
    else setPasswordConnectionId(connectionId);
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
    }, monitorIntervalSeconds * 1_000);
    return () => window.clearInterval(interval);
  }, [activeConnectionId, activeWorkspace?.sessionId, activeWorkspace?.state, monitorIntervalSeconds, sampleMonitor]);

  const taskPanelHeight = bottomVisible && activeServer ? (bottomCollapsed ? 52 : bottomPanelHeight) : 0;
  const explorerDockPlacement = activeRail === "files" ? explorerPlacement : "left";
  const explorerDockCollapsed = activeRail === "files"
    && explorerDockPlacement !== "bottom"
    && explorerCollapsed;
  const explorerDockWidth = explorerDockCollapsed ? 48 : explorerWidth;
  const explorerDockedBelow = activeRail === "files" && explorerPlacement === "bottom";
  const bottomFilesAvailable = Boolean(activeServer) && explorerPlacement === "bottom";
  const activeBottomView = bottomFilesAvailable && bottomView === "files" ? "files" : "transfer";
  const explorerPanelProps = {
    server: activeServer,
    servers,
    activeServerId: activeConnectionId,
    fileState: activeWorkspace ? {
      path: activeWorkspace.directory,
      entries: activeWorkspace.entries,
      loading: activeWorkspace.filesLoading,
      error: activeWorkspace.filesError,
    } : null,
    metrics: activeWorkspace?.metrics || null,
    sampledAt: activeWorkspace?.sampledAt || "尚未采样",
    monitorLoading: activeWorkspace?.monitorLoading,
    monitorError: activeWorkspace?.monitorError,
    monitorIntervalSeconds,
    onMonitorIntervalChange: setMonitorIntervalSeconds,
    onUpload: uploadFiles,
    onSelectUploadFiles: selectUploadFiles,
    onNativeDragDropSubscribe: client.events.onDragDrop,
    onDownloadRemoteFile: downloadRemoteFile,
    onRenameRemoteEntry: renameRemoteEntry,
    onDeleteRemoteEntry: deleteRemoteEntry,
    onCreateRemoteEntry: createRemoteEntry,
    onOpenTextFile: openRemoteTextFile,
    onRefresh: () => activeWorkspace?.directory && void loadDirectory(activeConnectionId, activeWorkspace.directory),
    onNavigate: (path) => void loadDirectory(activeConnectionId, path),
    onListDirectory: listRemoteDirectory,
    onPlacementChange: changeExplorerPlacement,
    onToggleCollapsed: () => setExplorerCollapsed((value) => !value),
    onSelectServer: selectServer,
    onOpenConnections: openConnections,
  };

  if (loading || !uiPreferencesReady) {
    return <main className="native-startup-state" role="status"><HardDrives size={34} weight="duotone" /><strong>正在加载本机连接配置…</strong></main>;
  }
  if (fatalError) {
    return <main className="native-startup-state is-error" role="alert"><HardDrives size={34} weight="duotone" /><strong>无法启动原生客户端</strong><span>{fatalError}</span></main>;
  }

  return (
    <div
      className="app-root"
      data-color-scheme={interfaceColorScheme}
      data-theme-mode={interfaceThemeMode}
      style={{ "--accent": appearance.accent, "--accent-contrast": accentContrast(appearance.accent) }}
    >
      <main className={`app-shell ${railExpanded ? "is-rail-expanded" : ""}`} style={{ "--task-panel-h": `${taskPanelHeight}px` }}>
        <TopBar
          server={activeServer}
          servers={servers}
          metrics={activeWorkspace?.metrics || null}
          menuOpen={serverMenuOpen}
          railExpanded={railExpanded}
          onToggleMenu={() => setServerMenuOpen((value) => !value)}
          onSelectServer={selectServer}
          onAddServer={() => openConnections("new")}
          onToggleRail={() => setRailExpanded((value) => !value)}
          onOpenMonitor={() => activeServer && setActiveRail("monitor")}
        />
        <ActivityRail
          activeItem={activeRail}
          expanded={railExpanded}
          settingsOpen={settingsOpen}
          themeMode={interfaceThemeMode}
          onChange={handleRailChange}
          onThemeModeChange={setInterfaceThemeMode}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div
          className="workbench"
          data-explorer-placement={explorerDockPlacement}
          data-explorer-collapsed={explorerDockCollapsed ? "true" : "false"}
          style={{ "--explorer-w": `${explorerDockWidth}px` }}
        >
          {!explorerDockedBelow && <ExplorerPanel
            {...explorerPanelProps}
            mode={activeRail}
            layout={explorerDockPlacement}
            collapsed={explorerDockCollapsed}
          />}
          {explorerDockPlacement !== "bottom" && !explorerDockCollapsed && <WorkspaceResizeHandle
            width={explorerWidth}
            placement={explorerDockPlacement}
            onResize={setExplorerWidth}
            onReset={() => setExplorerWidth(DEFAULT_EXPLORER_WIDTH)}
          />}
          {sessions.length ? (
            <Suspense fallback={<section className="terminal-pane native-empty-workspace" role="status">正在加载终端组件…</section>}>
              <NativeTerminalPane
                client={client}
                sessions={sessions}
                activeSessionId={activeConnectionId}
                documents={openDocuments}
                activeDocumentKey={activeDocumentKey}
                appearance={appearance}
                commandAssistanceMode={commandAssistanceMode}
                onSessionSelect={(connectionId) => {
                  setActiveDocumentKey(null);
                  setActiveConnectionId(connectionId);
                }}
                onSessionAdd={() => openConnections("new")}
                onSessionClose={(connectionId) => void closeWorkspace(connectionId)}
                onDocumentSelect={selectRemoteDocument}
                onDocumentClose={(key) => void closeRemoteDocument(key)}
                onReconnect={reconnectWorkspace}
                onTerminalError={onTerminalError}
              >
                {openDocuments.map((document) => (
                  <RemoteTextEditor
                    key={document.key}
                    active={activeDocumentKey === document.key}
                    client={client}
                    document={document}
                    appearance={appearance}
                    onDirtyChange={updateRemoteDocumentDirty}
                    onSaved={() => {
                      const workspace = workspacesRef.current[document.connectionId];
                      if (workspace?.directory) void loadDirectory(document.connectionId, workspace.directory);
                    }}
                    onError={(error) => addIssue(document.connectionId, `远程文件：${document.name}`, error?.message || "远程文本操作失败。", error?.code || "SFTP_TEXT_FAILED")}
                  />
                ))}
              </NativeTerminalPane>
            </Suspense>
          ) : (
            <section className="terminal-pane native-empty-workspace">
              <HardDrives size={46} weight="duotone" />
              <strong>打开一个服务器工作区</strong>
              <span>每台服务器会保留独立的终端、远程目录和监控状态。</span>
              <button type="button" className="primary-button" onClick={() => openConnections(connections.length ? "list" : "new")}><Plus size={18} /> {connections.length ? "选择服务器" : "新增 SSH 服务器"}</button>
            </section>
          )}
          {bottomVisible && activeServer && <BottomPanel
            collapsed={bottomCollapsed}
            activeView={activeBottomView}
            filesContent={bottomFilesAvailable ? <ExplorerPanel {...explorerPanelProps} mode="files" layout="bottom" embedded /> : null}
            explorerPlacement={explorerPlacement}
            transfers={activeWorkspace?.transfers || []}
            servers={servers}
            onViewChange={(view) => {
              setBottomView(view);
              setBottomCollapsed(false);
            }}
            onExplorerPlacementChange={changeExplorerPlacement}
            onToggle={() => setBottomCollapsed((value) => !value)}
            onResize={setBottomPanelHeight}
            onResetResize={() => setBottomPanelHeight(DEFAULT_BOTTOM_PANEL_HEIGHT)}
            onCancel={(transferId) => void client.sftp.cancel(transferId).catch((error) => addIssue(activeConnectionId, "取消传输失败", error.message, error.code))}
            onRetry={(transferId) => void client.sftp.retry(transferId).catch((error) => addIssue(activeConnectionId, "重试传输失败", error.message, error.code))}
          />}
          <StatusBar server={activeServer} error={activeWorkspace?.error} />
        </div>
      </main>

      <ConnectionDialog
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
      <UploadConflictDialog
        request={uploadConflictRequest}
        onCancel={() => setUploadConflictRequest(null)}
        onConfirm={confirmUploadConflict}
      />
      <UnsavedChangesDialog
        request={unsavedChangesRequest}
        onCancel={() => resolveUnsavedChangesConfirmation(false)}
        onConfirm={() => resolveUnsavedChangesConfirmation(true)}
      />
      <CloseRequestDialog
        open={closeRequestOpen}
        activeSessionCount={closeRequestActiveSessionCount}
        activeTransferCount={closeDialogActiveTransferCount}
        unsavedDocuments={closeRequestDirtyDocuments}
        onResolve={resolveCloseRequest}
      />
      <SettingsDialog
        open={settingsOpen}
        theme={appearance}
        onThemeChange={(patch) => setAppearance((current) => ({ ...current, ...patch }))}
        onWallpaperChange={({ name, url }) => setAppearance((current) => ({ ...current, wallpaperName: name, wallpaperUrl: url }))}
        onRemoveWallpaper={() => setAppearance((current) => ({ ...current, wallpaperName: "", wallpaperUrl: "" }))}
        dataDirectoryStatus={dataDirectoryStatus}
        onChooseDataDirectory={chooseDataDirectory}
        onChangeDataDirectory={changeDataDirectory}
        closeBehavior={closeBehavior}
        closeBehaviorError={closeBehaviorError}
        onCloseBehaviorChange={changeCloseBehavior}
        commandAssistanceMode={commandAssistanceMode}
        onCommandAssistanceModeChange={setCommandAssistanceMode}
        uiPreferencesError={uiPreferencesError}
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
