import { getVersion } from "@tauri-apps/api/app";
import { invoke as tauriInvoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readText as tauriReadText, writeText as tauriWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { open as tauriOpenDialog } from "@tauri-apps/plugin-dialog";
import { check as tauriCheckForUpdate } from "@tauri-apps/plugin-updater";

const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

const TAURI_COMMANDS = Object.freeze({
  connectionsList: "connections_list",
  connectionsSave: "connections_save",
  connectionsRemove: "connections_remove",
  credentialsStatus: "credentials_status",
  credentialsRemove: "credentials_remove",
  hostKeysProbe: "host_keys_probe",
  hostKeysAccept: "host_keys_accept",
  sshConnect: "ssh_connect",
  sshDisconnect: "ssh_disconnect",
  terminalAttach: "terminal_attach",
  terminalWrite: "terminal_write",
  terminalResize: "terminal_resize",
  completionCatalog: "completion_catalog",
  sftpList: "sftp_list",
  sftpUpload: "sftp_upload",
  sftpCancel: "sftp_cancel",
  sftpRetry: "sftp_retry",
  monitorSample: "monitor_sample",
  updatesInstall: "updates_install",
  getCloseBehavior: "get_close_behavior",
  setCloseBehavior: "set_close_behavior",
  resolveCloseRequest: "resolve_close_request",
  showMainWindow: "show_main_window",
  quitApp: "quit_app",
});

const TAURI_EVENTS = Object.freeze({
  terminalData: "terminal-data",
  sessionState: "session-state",
  transferProgress: "transfer-progress",
  closeRequested: "app://close-requested",
});

const PRODUCTION_TAURI_API = Object.freeze({
  invoke: tauriInvoke,
  listen: tauriListen,
  openDialog: tauriOpenDialog,
  readText: tauriReadText,
  writeText: tauriWriteText,
  getVersion,
  checkForUpdate: tauriCheckForUpdate,
  onDragDrop: (callback) => getCurrentWebviewWindow().onDragDropEvent(callback),
});

export class NativeClientError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeClientError";
    this.code = code;
  }
}

function normalizeError(error, fallbackCode = "NATIVE_OPERATION_FAILED", fallbackMessage = "原生操作失败。") {
  if (error instanceof NativeClientError) return error;
  const candidate = error && typeof error === "object" && error.error
    ? error.error
    : error;
  const code = candidate && typeof candidate === "object" && typeof candidate.code === "string"
    ? candidate.code
    : fallbackCode;
  const message = candidate && typeof candidate === "object" && typeof candidate.message === "string"
    ? candidate.message
    : typeof candidate === "string" && candidate.trim()
      ? candidate
      : fallbackMessage;
  return new NativeClientError(code, message, error);
}

function invokeTauri(api, command, args = undefined) {
  return Promise.resolve()
    .then(() => api.invoke(command, args))
    .catch((error) => { throw normalizeError(error); });
}

function assertCallback(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("事件订阅必须提供回调函数");
  }
}

function subscribeTauri(api, eventName, callback) {
  assertCallback(callback);
  let disposed = false;
  let unlisten = null;
  const ready = Promise.resolve()
    .then(() => api.listen(eventName, (event) => callback(event.payload)))
    .then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
  // The existing UI contract needs a synchronous disposer while subscription
  // setup is asynchronous, so setup failures remain explicitly observable.
  ready.catch((error) => {
    const nativeError = normalizeError(error, "NATIVE_EVENT_SUBSCRIBE_FAILED", `无法订阅原生事件 ${eventName}。`);
    console.error(`[native-client] ${nativeError.code}: ${nativeError.message}`);
  });
  const dispose = () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
  Object.defineProperty(dispose, "ready", { value: ready, enumerable: false });
  return dispose;
}

function subscribeTauriDragDrop(api, callback) {
  assertCallback(callback);
  let disposed = false;
  let unlisten = null;
  const ready = Promise.resolve()
    .then(() => api.onDragDrop((event) => callback(event.payload)))
    .then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
  ready.catch((error) => {
    const nativeError = normalizeError(error, "NATIVE_DRAG_DROP_SUBSCRIBE_FAILED", "无法订阅原生文件拖放事件。");
    console.error(`[native-client] ${nativeError.code}: ${nativeError.message}`);
  });
  const dispose = () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
  Object.defineProperty(dispose, "ready", { value: ready, enumerable: false });
  return dispose;
}

function normalizeLocalPath(value) {
  const localPath = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof value.localPath === "string"
      ? value.localPath
      : "";
  if (!WINDOWS_ABSOLUTE_PATH.test(localPath)) {
    throw new NativeClientError(
      "LOCAL_FILE_PATH_UNAVAILABLE",
      "无法取得待上传文件的 Windows 绝对路径。请通过客户端文件选择器或原生拖放事件重新选择。",
    );
  }
  return { localPath };
}

function prepareTauriFiles(files) {
  return Array.from(files || [], normalizeLocalPath);
}

function requireCompletionCatalog(value) {
  const validSources = new Set(["remote-command", "history"]);
  const valid = Array.isArray(value) && value.every((item) => (
    item
    && typeof item === "object"
    && typeof item.command === "string"
    && item.command.trim()
    && typeof item.source === "string"
    && validSources.has(item.source)
  ));
  if (!valid) {
    throw new NativeClientError(
      "INVALID_COMPLETION_CATALOG",
      "服务器返回了无法识别的智能补全目录。",
    );
  }
  return value;
}

function requireTerminalBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value)
    || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new NativeClientError("INVALID_TERMINAL_DATA", `${label}包含无法识别的终端字节。`);
  }
  return Uint8Array.from(value);
}

function normalizeTerminalEvent(value) {
  if (!value || typeof value !== "object" || typeof value.sessionId !== "string") {
    throw new NativeClientError("INVALID_TERMINAL_DATA", "原生客户端返回了无法识别的终端事件。");
  }
  return { ...value, data: requireTerminalBytes(value.data, "终端事件") };
}

function createUpdateController(api, invokeCommand) {
  const listeners = new Set();
  let pendingCheck = null;
  let state = {
    enabled: true,
    currentVersion: null,
    phase: "idle",
    availableVersion: null,
    progress: null,
    lastCheckedAt: null,
    error: null,
  };

  function snapshot() {
    return {
      ...state,
      progress: state.progress ? { ...state.progress } : null,
      error: state.error ? { ...state.error } : null,
    };
  }

  function publish(patch) {
    state = { ...state, ...patch };
    const next = snapshot();
    for (const listener of listeners) listener(next);
    return next;
  }

  async function ensureVersion() {
    if (!state.currentVersion) {
      let currentVersion;
      try {
        currentVersion = await api.getVersion();
      } catch (error) {
        throw new NativeClientError("APP_VERSION_UNAVAILABLE", "无法读取当前客户端版本。", error);
      }
      publish({ currentVersion });
    }
    return snapshot();
  }

  async function download(availableUpdate) {
    let transferred = 0;
    let total = 0;
    let startedAt = Date.now();
    publish({ phase: "downloading", progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } });
    try {
      await availableUpdate.download((event) => {
        if (event.event === "Started") {
          total = Number(event.data.contentLength) || 0;
          transferred = 0;
          startedAt = Date.now();
        } else if (event.event === "Progress") {
          transferred += Number(event.data.chunkLength) || 0;
        } else if (event.event === "Finished" && total > 0) {
          transferred = total;
        }
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
        publish({
          phase: event.event === "Finished" ? "ready" : "downloading",
          progress: {
            percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
            transferred,
            total,
            bytesPerSecond: transferred / elapsedSeconds,
          },
        });
      });
    } finally {
      // Rust performs the authoritative download again during installation.
      // Release the WebView updater resource and its byte buffer immediately.
      await availableUpdate.close();
    }
    return publish({
      phase: "ready",
      progress: {
        ...(state.progress || { transferred, total, bytesPerSecond: 0 }),
        percent: 100,
      },
    });
  }

  async function check() {
    if (pendingCheck) return pendingCheck;
    if (["downloading", "ready", "installing"].includes(state.phase)) return snapshot();
    pendingCheck = Promise.resolve()
      .then(ensureVersion)
      .then(async () => {
        publish({ phase: "checking", progress: null, error: null });
        const availableUpdate = await api.checkForUpdate();
        const checkedAt = new Date().toISOString();
        if (!availableUpdate) {
          return publish({
            phase: "idle",
            availableVersion: null,
            progress: null,
            lastCheckedAt: checkedAt,
            error: null,
          });
        }
        publish({
          phase: "available",
          availableVersion: availableUpdate.version || null,
          progress: null,
          lastCheckedAt: checkedAt,
          error: null,
        });
        return download(availableUpdate);
      })
      .catch((error) => {
        const downloadFailed = ["available", "downloading", "ready"].includes(state.phase);
        const nativeError = error instanceof NativeClientError && error.code === "APP_VERSION_UNAVAILABLE"
          ? error
          : new NativeClientError(
            downloadFailed ? "UPDATE_DOWNLOAD_FAILED" : "UPDATE_CHECK_FAILED",
            downloadFailed ? "更新下载失败，请稍后重试。" : "检查更新失败，请稍后重试。",
            error,
          );
        publish({
          phase: "error",
          progress: null,
          lastCheckedAt: new Date().toISOString(),
          error: { code: nativeError.code, message: nativeError.message },
        });
        throw nativeError;
      })
      .finally(() => { pendingCheck = null; });
    return pendingCheck;
  }

  async function install() {
    if (state.phase !== "ready" || typeof state.availableVersion !== "string") {
      throw new NativeClientError("UPDATE_NOT_READY", "更新尚未下载完成。");
    }
    publish({ phase: "installing", error: null });
    try {
      // The WebView can check and pre-download for progress display, but only
      // Rust may re-download, verify, gate active work, and start installation.
      return await invokeCommand(TAURI_COMMANDS.updatesInstall, {
        expectedVersion: state.availableVersion,
      });
    } catch (error) {
      const nativeError = error instanceof NativeClientError
        ? error
        : new NativeClientError(
          "UPDATE_INSTALL_FAILED",
          "无法启动更新安装，请稍后重试。",
          error,
        );
      publish({
        phase: "error",
        error: { code: nativeError.code, message: nativeError.message },
      });
      throw nativeError;
    }
  }

  return Object.freeze({
    status: ensureVersion,
    check,
    install,
    subscribe(callback) {
      assertCallback(callback);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  });
}

function createTauriClient(api) {
  const call = (command, args) => invokeTauri(api, command, args);
  const updates = createUpdateController(api, call);
  return Object.freeze({
    connections: Object.freeze({
      list: () => call(TAURI_COMMANDS.connectionsList),
      save: (connection) => call(TAURI_COMMANDS.connectionsSave, { connection }),
      remove: (connectionId) => call(TAURI_COMMANDS.connectionsRemove, { connectionId }),
    }),
    credentials: Object.freeze({
      status: () => call(TAURI_COMMANDS.credentialsStatus),
      remove: (connectionId) => call(TAURI_COMMANDS.credentialsRemove, { connectionId }),
    }),
    hostKeys: Object.freeze({
      probe: (connectionId) => call(TAURI_COMMANDS.hostKeysProbe, { connectionId }),
      accept: (challengeId) => call(TAURI_COMMANDS.hostKeysAccept, { challengeId }),
    }),
    ssh: Object.freeze({
      connect: (payload) => call(TAURI_COMMANDS.sshConnect, { payload }),
      disconnect: (sessionId) => call(TAURI_COMMANDS.sshDisconnect, { sessionId }),
    }),
    terminal: Object.freeze({
      attach: (sessionId) => call(TAURI_COMMANDS.terminalAttach, { sessionId })
        .then((result) => ({
          ...result,
          initialData: requireTerminalBytes(result?.initialData, "终端初始数据"),
        })),
      write: (sessionId, data) => call(TAURI_COMMANDS.terminalWrite, { sessionId, data }),
      resize: (sessionId, dimensions) => call(TAURI_COMMANDS.terminalResize, { sessionId, dimensions }),
      completions: (sessionId) => call(TAURI_COMMANDS.completionCatalog, { sessionId })
        .then(requireCompletionCatalog),
    }),
    clipboard: Object.freeze({
      readText: () => Promise.resolve()
        .then(() => api.readText())
        .catch((error) => { throw normalizeError(error, "CLIPBOARD_READ_FAILED", "无法读取系统剪贴板。"); }),
      writeText: (text) => Promise.resolve()
        .then(() => api.writeText(text))
        .catch((error) => { throw normalizeError(error, "CLIPBOARD_WRITE_FAILED", "无法写入系统剪贴板。"); }),
    }),
    dialog: Object.freeze({
      openFiles: async (options = {}) => {
        try {
          const selection = await api.openDialog({ ...options, directory: false, multiple: true });
          if (selection === null) return [];
          return (Array.isArray(selection) ? selection : [selection]).map(normalizeLocalPath);
        } catch (error) {
          throw normalizeError(error, "FILE_DIALOG_FAILED", "无法打开系统文件选择器。");
        }
      },
    }),
    sftp: Object.freeze({
      list: (sessionId, path) => call(TAURI_COMMANDS.sftpList, { sessionId, path }),
      upload: (sessionId, remoteDirectory, files) => {
        const preparedFiles = prepareTauriFiles(files);
        return call(TAURI_COMMANDS.sftpUpload, { sessionId, remoteDirectory, files: preparedFiles });
      },
      cancel: (transferId) => call(TAURI_COMMANDS.sftpCancel, { transferId }),
      retry: (transferId) => call(TAURI_COMMANDS.sftpRetry, { transferId }),
    }),
    monitor: Object.freeze({
      sample: (sessionId) => call(TAURI_COMMANDS.monitorSample, { sessionId }),
    }),
    app: Object.freeze({
      getCloseBehavior: () => call(TAURI_COMMANDS.getCloseBehavior),
      setCloseBehavior: (behavior) => call(TAURI_COMMANDS.setCloseBehavior, { behavior }),
      resolveCloseRequest: (requestId, action) => call(TAURI_COMMANDS.resolveCloseRequest, { requestId, action }),
      showMainWindow: () => call(TAURI_COMMANDS.showMainWindow),
      quit: () => call(TAURI_COMMANDS.quitApp),
    }),
    updates: Object.freeze({
      status: updates.status,
      check: updates.check,
      install: updates.install,
    }),
    events: Object.freeze({
      onTerminalData: (callback) => subscribeTauri(
        api,
        TAURI_EVENTS.terminalData,
        (event) => callback(normalizeTerminalEvent(event)),
      ),
      onSessionState: (callback) => subscribeTauri(api, TAURI_EVENTS.sessionState, callback),
      onTransferProgress: (callback) => subscribeTauri(api, TAURI_EVENTS.transferProgress, callback),
      onUpdateStatus: (callback) => updates.subscribe(callback),
      onCloseRequested: (callback) => subscribeTauri(api, TAURI_EVENTS.closeRequested, callback),
      onDragDrop: (callback) => subscribeTauriDragDrop(api, callback),
    }),
  });
}

export function createNativeClient(api) {
  const requiredMethods = [
    "invoke",
    "listen",
    "openDialog",
    "readText",
    "writeText",
    "getVersion",
    "checkForUpdate",
    "onDragDrop",
  ];
  if (!api || requiredMethods.some((method) => typeof api[method] !== "function")) {
    throw new TypeError("Tauri 客户端缺少完整的 API 适配器");
  }
  return createTauriClient(api);
}

export function getNativeClient() {
  if (!tauriIsTauri()) {
    throw new NativeClientError(
      "TAURI_RUNTIME_UNAVAILABLE",
      "未检测到 Tauri 原生运行时，请从已安装的桌面客户端启动。",
    );
  }
  return createNativeClient(PRODUCTION_TAURI_API);
}
