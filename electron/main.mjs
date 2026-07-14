import { app, BrowserWindow, clipboard, ipcMain, Menu, protocol, safeStorage, session } from "electron";
import electronUpdater from "electron-updater";
import path from "node:path";
import { fileURLToPath } from "node:url";
import channels from "./ipc/channels.cjs";
import { registerIpcHandlers } from "./ipc/register-handlers.mjs";
import { registerAppProtocol } from "./security/app-protocol.mjs";
import { ConnectionStore } from "./services/connection-store.mjs";
import { CredentialStore } from "./services/credential-store.mjs";
import { HostKeyService } from "./services/host-key-service.mjs";
import { KnownHostsStore } from "./services/known-hosts-store.mjs";
import { MonitorService } from "./services/monitor-service.mjs";
import { SshManager } from "./services/ssh-manager.mjs";
import { UpdateService } from "./services/update-service.mjs";

const { autoUpdater } = electronUpdater;

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const testUserDataPath = process.env.REMOTE_TERMINAL_TEST_USER_DATA;
if (!app.isPackaged && testUserDataPath) {
  const allowedRoot = path.resolve(currentDirectory, "..", "artifacts", "qa");
  const resolvedPath = path.resolve(testUserDataPath);
  const relativePath = path.relative(allowedRoot, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("测试 userData 路径必须位于 artifacts/qa 目录内。" );
  }
  app.setPath("userData", resolvedPath);
}
const development = !app.isPackaged && process.argv.includes("--dev");
const eventChannels = {
  "terminal-data": channels.terminalData,
  "session-state": channels.sessionState,
  "transfer-progress": channels.transferProgress,
  "update-status": channels.updateStatus,
};

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    codeCache: true,
  },
}]);
app.enableSandbox();

let mainWindow = null;
let ssh = null;
let updates = null;
const singleInstanceLock = app.requestSingleInstanceLock();

function sendEvent(type, payload) {
  const channel = eventChannels[type];
  if (!channel || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    backgroundColor: "#071525",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (targetUrl !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  let rendererLoaded = false;
  window.webContents.on("did-finish-load", () => { rendererLoaded = true; });
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (rendererLoaded && isMainFrame && !isInPlace) ssh?.disconnectAll();
  });
  window.webContents.on("render-process-gone", () => ssh?.disconnectAll());
  window.on("closed", () => {
    ssh?.disconnectAll();
    if (mainWindow === window) mainWindow = null;
  });

  if (development) window.loadURL("http://127.0.0.1:4173/");
  else window.loadURL("app://renderer/");
  return window;
}

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow && app.isReady()) mainWindow = createWindow();
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    const dataDirectory = path.join(app.getPath("userData"), "data");
    const connections = new ConnectionStore(path.join(dataDirectory, "connections.json"));
    const credentials = new CredentialStore(path.join(dataDirectory, "credentials.json"), safeStorage);
    const knownHosts = new KnownHostsStore(path.join(dataDirectory, "known-hosts.json"));
    ssh = new SshManager(sendEvent);
    const hostKeys = new HostKeyService({ connections, knownHosts, ssh });
    const monitor = new MonitorService(ssh);
    updates = new UpdateService({
      app,
      updater: autoUpdater,
      emit: sendEvent,
      hasActiveTransfers: () => ssh.hasActiveTransfers(),
      disconnectAll: () => ssh.disconnectAll(),
    });

    if (!development) registerAppProtocol(protocol, path.join(currentDirectory, "..", "dist"));
    registerIpcHandlers({
      ipcMain,
      clipboard,
      getWindow: () => mainWindow,
      development,
      connections,
      credentials,
      knownHosts,
      hostKeys,
      ssh,
      monitor,
      updates,
    });

    mainWindow = createWindow();
    updates.initialize();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on("before-quit", () => {
    updates?.dispose();
    ssh?.disconnectAll();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
