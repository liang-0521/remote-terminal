import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  NativeClientError,
  createNativeClient,
  getNativeClient,
} from "../src/native/client.js";

function createTauriApi(overrides = {}) {
  const calls = [];
  const handlers = new Map();
  const api = {
    calls,
    handlers,
    async invoke(command, args) {
      calls.push({ type: "invoke", command, args });
      if ([
        "completion_catalog",
        "command_history_list",
        "command_history_record",
        "command_history_remove",
      ].includes(command)) return [];
      return { command, args };
    },
    async listen(eventName, handler) {
      calls.push({ type: "listen", eventName });
      handlers.set(eventName, handler);
      return () => {
        calls.push({ type: "unlisten", eventName });
        handlers.delete(eventName);
      };
    },
    async onDragDrop(handler) {
      calls.push({ type: "drag-listen" });
      api.dragHandler = handler;
      return () => {
        calls.push({ type: "drag-unlisten" });
        delete api.dragHandler;
      };
    },
    async openDialog() { return null; },
    async readText() { return "clipboard"; },
    async writeText(text) { calls.push({ type: "clipboard-write", text }); },
    async getVersion() { return "0.2.0"; },
    async checkForUpdate() { return null; },
    ...overrides,
  };
  return api;
}

test("Tauri 命令保持现有前端方法签名并映射到 snake_case 参数", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);

  await client.connections.save({ id: "server-1" });
  await client.ssh.connect({ connectionId: "server-1", dimensions: { cols: 120, rows: 32 } });
  await client.terminal.resize("session-1", { cols: 80, rows: 24 });
  await client.terminal.completions("session-1");
  await client.terminal.history.list("server-1");
  await client.terminal.history.record("server-1", "ls -lah");
  await client.terminal.history.remove("server-1", "ls -lah");
  await client.sftp.list("session-1", "/root");
  await client.sftp.remove("session-1", "/root/old.log", "file");
  await client.sftp.rename(
    "session-1",
    "/root/release.zip",
    "/root/archive/release.zip",
    "file",
  );
  await client.monitor.sample("session-1");

  assert.deepEqual(api.calls.filter((item) => item.type === "invoke"), [
    { type: "invoke", command: "connections_save", args: { connection: { id: "server-1" } } },
    {
      type: "invoke",
      command: "ssh_connect",
      args: { payload: { connectionId: "server-1", dimensions: { cols: 120, rows: 32 } } },
    },
    {
      type: "invoke",
      command: "terminal_resize",
      args: { sessionId: "session-1", dimensions: { cols: 80, rows: 24 } },
    },
    { type: "invoke", command: "completion_catalog", args: { sessionId: "session-1" } },
    { type: "invoke", command: "command_history_list", args: { connectionId: "server-1" } },
    {
      type: "invoke",
      command: "command_history_record",
      args: { connectionId: "server-1", command: "ls -lah" },
    },
    {
      type: "invoke",
      command: "command_history_remove",
      args: { connectionId: "server-1", command: "ls -lah" },
    },
    { type: "invoke", command: "sftp_list", args: { sessionId: "session-1", path: "/root" } },
    {
      type: "invoke",
      command: "sftp_remove",
      args: { sessionId: "session-1", path: "/root/old.log", expectedEntryType: "file" },
    },
    {
      type: "invoke",
      command: "sftp_rename",
      args: {
        sessionId: "session-1",
        sourcePath: "/root/release.zip",
        targetPath: "/root/archive/release.zip",
        expectedEntryType: "file",
      },
    },
    { type: "invoke", command: "monitor_sample", args: { sessionId: "session-1" } },
  ]);
});

test("Tauri 数据目录 API 只传递路径并返回原生状态", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);

  await client.storage.dataDirectoryStatus();
  await client.storage.changeDataDirectory("D:\\Remote Terminal Data");

  assert.deepEqual(api.calls.filter((item) => item.type === "invoke"), [
    { type: "invoke", command: "data_directory_status", args: undefined },
    {
      type: "invoke",
      command: "data_directory_change",
      args: { targetPath: "D:\\Remote Terminal Data" },
    },
  ]);
});

test("Tauri 智能补全目录必须是数组，畸形响应作为显式契约错误暴露", async () => {
  const api = createTauriApi({
    async invoke(command, args) {
      api.calls.push({ type: "invoke", command, args });
      if (command === "completion_catalog") return { items: [] };
      return null;
    },
  });
  const client = createNativeClient(api);

  await assert.rejects(
    client.terminal.completions("session-1"),
    (error) => error instanceof NativeClientError && error.code === "INVALID_COMPLETION_CATALOG",
  );

  api.invoke = async () => [{ command: "ls", source: "untrusted-source" }];
  await assert.rejects(
    client.terminal.completions("session-1"),
    (error) => error instanceof NativeClientError && error.code === "INVALID_COMPLETION_CATALOG",
  );
});

test("Tauri 远端补全只接受远端可执行命令，不再接受远端 Shell 历史", async () => {
  const expected = [{ command: "ls", source: "remote-command" }];
  const api = createTauriApi({ async invoke() { return expected; } });
  const client = createNativeClient(api);

  assert.deepEqual(await client.terminal.completions("session-1"), expected);

  api.invoke = async () => [{ command: "journalctl -xe", source: "history" }];
  await assert.rejects(
    client.terminal.completions("session-1"),
    (error) => error instanceof NativeClientError && error.code === "INVALID_COMPLETION_CATALOG",
  );
});

test("Tauri 本机命令历史按服务器调用并严格校验原生响应", async () => {
  const expected = ["ls -lah", "pwd"];
  const api = createTauriApi({ async invoke() { return expected; } });
  const client = createNativeClient(api);

  assert.deepEqual(await client.terminal.history.list("server-1"), expected);
  assert.deepEqual(await client.terminal.history.record("server-1", "whoami"), expected);
  assert.deepEqual(await client.terminal.history.remove("server-1", "pwd"), expected);

  for (const invalid of [
    ["duplicate", "duplicate"],
    ["contains\ncontrol"],
    { commands: [] },
  ]) {
    api.invoke = async () => invalid;
    await assert.rejects(
      client.terminal.history.list("server-1"),
      (error) => error instanceof NativeClientError && error.code === "INVALID_COMMAND_HISTORY",
    );
  }
});

test("Tauri 事件把 Event payload 还原为旧回调契约且支持提前取消", async () => {
  let resolveListen;
  let disposed = 0;
  const api = createTauriApi({
    listen: (_eventName, handler) => {
      api.handler = handler;
      return new Promise((resolve) => { resolveListen = resolve; });
    },
  });
  const client = createNativeClient(api);
  const received = [];
  const unsubscribe = client.events.onTerminalData((payload) => received.push(payload));

  await Promise.resolve();
  api.handler({ payload: { sessionId: "session-1", data: [104, 101, 108, 108, 111] } });
  unsubscribe();
  resolveListen(() => { disposed += 1; });
  await unsubscribe.ready;

  assert.deepEqual(received, [{
    sessionId: "session-1",
    data: Uint8Array.from([104, 101, 108, 108, 111]),
  }]);
  assert.equal(disposed, 1);
});

test("Tauri 终端 attach 把 Rust 字节数组转换为 xterm 可写入的 Uint8Array", async () => {
  const api = createTauriApi({
    async invoke(command, args) {
      api.calls.push({ type: "invoke", command, args });
      if (command === "terminal_attach") {
        return { sessionId: "session-1", initialData: [240, 159, 145, 139] };
      }
      return null;
    },
  });
  const client = createNativeClient(api);

  const attached = await client.terminal.attach("session-1");
  assert.deepEqual(attached.initialData, Uint8Array.from([240, 159, 145, 139]));

  api.invoke = async () => ({ sessionId: "session-1", initialData: [256] });
  await assert.rejects(
    client.terminal.attach("session-1"),
    (error) => error instanceof NativeClientError && error.code === "INVALID_TERMINAL_DATA",
  );
});

test("Tauri 关闭策略保持持久化命令和关闭请求事件契约", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);
  const received = [];
  const unsubscribe = client.events.onCloseRequested((payload) => received.push(payload));
  await unsubscribe.ready;

  const requestId = "8f2d624f-36cc-4a81-8724-73b165ea6f5f";
  api.handlers.get("app://close-requested")({
    payload: { requestId, behavior: "ask", activeSessionCount: 2, activeTransferCount: 1 },
  });
  await client.app.getCloseBehavior();
  await client.app.setCloseBehavior("background");
  const preferences = {
    interfaceThemeMode: "dark",
    appearance: {
      accent: "#60a5fa",
      terminalBackground: "#000000",
      terminalForeground: "#ffffff",
      wallpaperOpacity: 0.22,
    },
    explorerWidth: 360,
    railExpanded: true,
    bottomVisible: true,
    bottomCollapsed: false,
    bottomPanelHeight: 300,
    commandAssistanceMode: "shortcut",
  };
  await client.app.getUiPreferences();
  await client.app.setUiPreferences(preferences);
  await client.app.resolveCloseRequest(requestId, "background");

  assert.deepEqual(received, [{
    requestId,
    behavior: "ask",
    activeSessionCount: 2,
    activeTransferCount: 1,
  }]);
  assert.deepEqual(api.calls.filter((item) => item.type === "invoke").slice(-5), [
    { type: "invoke", command: "get_close_behavior", args: undefined },
    { type: "invoke", command: "set_close_behavior", args: { behavior: "background" } },
    { type: "invoke", command: "get_ui_preferences", args: undefined },
    { type: "invoke", command: "set_ui_preferences", args: { preferences } },
    { type: "invoke", command: "resolve_close_request", args: { requestId, action: "background" } },
  ]);
  unsubscribe();
});

test("Tauri 上传只接受原生来源的 Windows 绝对路径", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);

  await client.sftp.upload("session-1", "/root", [
    "D:\\release\\app.zip",
    { localPath: "\\\\fileserver\\share\\notes.txt" },
  ]);
  assert.deepEqual(api.calls.at(-1), {
    type: "invoke",
    command: "sftp_upload",
    args: {
      sessionId: "session-1",
      remoteDirectory: "/root",
      files: [
        { localPath: "D:\\release\\app.zip" },
        { localPath: "\\\\fileserver\\share\\notes.txt" },
      ],
    },
  });

  assert.throws(
    () => client.sftp.upload("session-1", "/root", [{ name: "browser-file.txt" }]),
    (error) => error instanceof NativeClientError && error.code === "LOCAL_FILE_PATH_UNAVAILABLE",
  );
});

test("Tauri 远程文件下载位置只由 Rust 原生保存窗口决定", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);

  await client.sftp.downloadToComputer("session-1", "/var/log/app.log");

  assert.deepEqual(api.calls.filter((item) => item.type === "invoke"), [
    {
      type: "invoke",
      command: "sftp_download_to_computer",
      args: { sessionId: "session-1", remotePath: "/var/log/app.log" },
    },
  ]);
});

test("远程文件菜单只保留下载到入口，不再暴露拖出交互", async () => {
  const menuUrl = new URL("../src/components/files/RemoteFileContextMenu.jsx", import.meta.url);
  const explorerUrl = new URL("../src/components/files/ExplorerPanel.jsx", import.meta.url);
  const [menuSource, explorerSource] = await Promise.all([
    readFile(menuUrl, "utf8"),
    readFile(explorerUrl, "utf8"),
  ]);

  assert.match(menuSource, /下载到…/);
  assert.doesNotMatch(menuSource, /拖到电脑|onPointerDown/);
  assert.doesNotMatch(explorerSource, /DragOut|CachedDrag|拖向 Windows/);
});

test("Tauri 原生拖放事件只暴露受信任的路径 payload", async () => {
  const api = createTauriApi();
  const client = createNativeClient(api);
  const received = [];
  const unsubscribe = client.events.onDragDrop((payload) => received.push(payload));
  await unsubscribe.ready;

  api.dragHandler({ payload: { type: "drop", paths: ["D:\\release\\app.zip"], position: { x: 20, y: 40 } } });
  assert.deepEqual(received, [{ type: "drop", paths: ["D:\\release\\app.zip"], position: { x: 20, y: 40 } }]);
  unsubscribe();
  assert.equal(api.calls.at(-1).type, "drag-unlisten");
});

test("Tauri 文件选择器和剪贴板使用官方插件并返回可上传路径", async () => {
  const dialogOptions = [];
  const api = createTauriApi({
    async openDialog(options) {
      dialogOptions.push(options);
      return options.directory
        ? "D:\\Remote Terminal Data"
        : ["C:\\logs\\one.log", "D:\\logs\\two.log"];
    },
  });
  const client = createNativeClient(api);

  assert.deepEqual(await client.dialog.openFiles({ title: "选择日志" }), [
    { localPath: "C:\\logs\\one.log" },
    { localPath: "D:\\logs\\two.log" },
  ]);
  assert.equal(
    await client.dialog.openDirectory({ title: "选择数据目录" }),
    "D:\\Remote Terminal Data",
  );
  assert.deepEqual(dialogOptions, [
    { title: "选择日志", directory: false, multiple: true },
    { title: "选择数据目录", directory: true, multiple: false },
  ]);
  assert.equal(await client.clipboard.readText(), "clipboard");
  await client.clipboard.writeText("copy me");
  assert.deepEqual(api.calls.at(-1), { type: "clipboard-write", text: "copy me" });
});

test("Tauri WebView 权限不允许直接安装更新或重启进程", async () => {
  const capabilityUrl = new URL("../src-tauri/capabilities/default.json", import.meta.url);
  const capability = JSON.parse(await readFile(capabilityUrl, "utf8"));

  assert.equal(capability.permissions.includes("updater:allow-check"), true);
  assert.equal(capability.permissions.includes("updater:allow-download"), true);
  assert.equal(capability.permissions.includes("updater:allow-install"), false);
  assert.equal(capability.permissions.includes("process:allow-restart"), false);
});

test("Tauri 更新下载后等待用户操作，安装只能交给 Rust 核心", async () => {
  const order = [];
  let webviewInstallCalls = 0;
  const update = {
    version: "0.2.1",
    async download(onEvent) {
      order.push("download");
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Finished" });
    },
    async close() { order.push("release"); },
    async install() { webviewInstallCalls += 1; },
  };
  const api = createTauriApi({
    async invoke(command, args) {
      api.calls.push({ type: "invoke", command, args });
      if (command === "updates_install") {
        order.push("rust-install");
        return { installing: true };
      }
      return null;
    },
    async checkForUpdate() { return update; },
  });
  const client = createNativeClient(api);
  const phases = [];
  client.events.onUpdateStatus((state) => phases.push(state.phase));

  assert.equal((await client.updates.status()).currentVersion, "0.2.0");
  const ready = await client.updates.check();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.availableVersion, "0.2.1");
  assert.equal(ready.progress.percent, 100);
  assert.equal(order.includes("install"), false);

  assert.deepEqual(await client.updates.install(), { installing: true });
  assert.deepEqual(order, ["download", "release", "rust-install"]);
  assert.equal(webviewInstallCalls, 0);
  assert.deepEqual(api.calls.filter((item) => item.command === "updates_install"), [{
    type: "invoke",
    command: "updates_install",
    args: { expectedVersion: "0.2.1" },
  }]);
  assert.equal(phases.includes("downloading"), true);
  assert.equal(phases.includes("installing"), true);
});

test("Rust 拒绝更新安装时 WebView 不会直接安装或重启", async () => {
  let installed = 0;
  let relaunched = 0;
  const api = createTauriApi({
    async invoke(command) {
      if (command === "updates_install") {
        throw { code: "UPDATE_INSTALL_BLOCKED", message: "仍有文件正在传输。" };
      }
      return null;
    },
    async checkForUpdate() {
      return {
        version: "0.2.1",
        async download(onEvent) { onEvent({ event: "Finished" }); },
        async close() {},
        async install() { installed += 1; },
      };
    },
    async relaunch() { relaunched += 1; },
  });
  const client = createNativeClient(api);
  await client.updates.check();

  await assert.rejects(
    client.updates.install(),
    (error) => error.code === "UPDATE_INSTALL_BLOCKED",
  );
  assert.equal(installed, 0);
  assert.equal(relaunched, 0);
});

test("更新插件异常不会把更新地址或内部错误泄露到 UI", async () => {
  const api = createTauriApi({
    async checkForUpdate() {
      throw new Error("https://updates.example.invalid/latest.json?token=private-value");
    },
  });
  const client = createNativeClient(api);

  await assert.rejects(
    client.updates.check(),
    (error) => error.code === "UPDATE_CHECK_FAILED"
      && error.message === "检查更新失败，请稍后重试。"
      && !error.message.includes("private-value"),
  );
});

test("客户端只接受完整 Tauri 适配器，缺少 Tauri 运行时会显式失败", () => {
  const previousIsTauri = globalThis.isTauri;
  try {
    assert.throws(
      () => createNativeClient({ invoke() {} }),
      (error) => error instanceof TypeError && error.message.includes("Tauri"),
    );
    globalThis.isTauri = false;
    assert.throws(
      () => getNativeClient(),
      (error) => error instanceof NativeClientError && error.code === "TAURI_RUNTIME_UNAVAILABLE",
    );
  } finally {
    if (previousIsTauri === undefined) delete globalThis.isTauri;
    else globalThis.isTauri = previousIsTauri;
  }
});
