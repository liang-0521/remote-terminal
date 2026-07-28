import assert from "node:assert/strict";
import test from "node:test";
import {
  createDetachedDocumentUrl,
  DETACHED_DOCUMENT_ADD_EVENT,
  DETACHED_DOCUMENT_GROUP_LABEL,
  isPointerOutsideWindow,
  mergeDetachedDocuments,
  parseDetachedDocumentLocation,
  shouldDetachDocumentTab,
} from "../src/services/detached-document.js";
import { openDetachedDocumentWindow } from "../src/native/detached-document-window.js";

const DOCUMENT = {
  key: "server-1:/opt/app.log",
  connectionId: "server-1",
  sessionId: "session-1",
  path: "/opt/app.log",
  name: "app.log",
  dirty: false,
};

test("独立文件窗口参数往返时只保留受控远程文档字段", () => {
  const url = createDetachedDocumentUrl(DOCUMENT);
  const parsed = parseDetachedDocumentLocation(new URL(url, "http://desktop.local/").search);

  assert.equal(parsed.requested, true);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.document, DOCUMENT);
});

test("独立文件窗口拒绝相对路径和控制字符", () => {
  const relative = encodeURIComponent(JSON.stringify({ ...DOCUMENT, path: "opt/app.log" }));
  const control = encodeURIComponent(JSON.stringify({ ...DOCUMENT, name: "app\n.log" }));

  assert.match(
    parseDetachedDocumentLocation(`?detachedDocument=${relative}`).error,
    /绝对远程路径/,
  );
  assert.match(
    parseDetachedDocumentLocation(`?detachedDocument=${control}`).error,
    /有效的 name/,
  );
});

test("连续拖出的文件合并到同一文档组且不会重复", () => {
  const secondDocument = {
    ...DOCUMENT,
    key: "server-1:/opt/second.log",
    path: "/opt/second.log",
    name: "second.log",
  };
  const first = mergeDetachedDocuments([], DOCUMENT);
  const merged = mergeDetachedDocuments(first, secondDocument);

  assert.equal(merged.length, 2);
  assert.deepEqual(mergeDetachedDocuments(merged, DOCUMENT), merged);
});

test("只有文件标签释放到主窗口边界外时才触发撕出", () => {
  const viewport = {
    innerWidth: 1200,
    innerHeight: 800,
    outerWidth: 1220,
    outerHeight: 840,
    screenX: 100,
    screenY: 60,
  };
  const outsidePointer = {
    clientX: 1300,
    clientY: 300,
    screenX: 1420,
    screenY: 380,
    dropEffect: "none",
  };

  assert.equal(isPointerOutsideWindow(outsidePointer, viewport), true);
  assert.equal(shouldDetachDocumentTab({
    tab: { type: "document", value: DOCUMENT },
    dropHandled: false,
    pointer: outsidePointer,
    viewport,
  }), true);
  assert.equal(shouldDetachDocumentTab({
    tab: { type: "session", value: {} },
    dropHandled: false,
    pointer: outsidePointer,
    viewport,
  }), false);
  assert.equal(shouldDetachDocumentTab({
    tab: { type: "document", value: DOCUMENT },
    dropHandled: true,
    pointer: outsidePointer,
    viewport,
  }), false);
});

test("分屏标签栏与左右内容区使用相同的二列网格", async () => {
  const [componentSource, styleSource] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(
      new URL("../src/components/terminal/NativeTerminalPane.jsx", import.meta.url),
      "utf8",
    )),
    import("node:fs/promises").then(({ readFile }) => readFile(
      new URL("../src/feature-styles.css", import.meta.url),
      "utf8",
    )),
  ]);

  const tabRowIndex = componentSource.indexOf("native-workspace-tab-row");
  const workspaceIndex = componentSource.indexOf("native-workspace-grid");
  assert.ok(tabRowIndex >= 0 && tabRowIndex < workspaceIndex);
  assert.match(styleSource, /\.native-workspace-tab-row\.is-split\s*\{[^}]*repeat\(2,/s);
  assert.match(styleSource, /\.native-workspace-grid\.is-split\s*\{[^}]*repeat\(2,/s);
  assert.doesNotMatch(styleSource, /\.native-workspace-grid\.is-split\s*\{[^}]*grid-template-rows:/s);
});

test("文件标签撕出创建带原生边框的独立窗口", async () => {
  let windowInstance = null;
  class FakeWebviewWindow {
    constructor(label, options) {
      this.label = label;
      this.options = options;
      this.listeners = new Map();
      windowInstance = this;
    }

    once(eventName, callback) {
      this.listeners.set(eventName, callback);
      return Promise.resolve(() => this.listeners.delete(eventName));
    }
  }

  const created = openDetachedDocumentWindow(DOCUMENT, {
    WebviewWindowType: FakeWebviewWindow,
    getByLabel: async () => null,
  });
  await Promise.resolve();
  windowInstance.listeners.get("tauri://created")();
  const result = await created;

  assert.equal(result, windowInstance);
  assert.equal(windowInstance.label, DETACHED_DOCUMENT_GROUP_LABEL);
  assert.equal(windowInstance.options.decorations, true);
  assert.equal(windowInstance.options.resizable, true);
  assert.match(windowInstance.options.url, /^index\.html\?detachedDocument=/);
  assert.equal(windowInstance.options.title, "app.log - Remote Terminal");
});

test("再次撕出文件时复用文档组并把新标签带到前台", async () => {
  const calls = [];
  const existingWindow = {
    emitTo: async (...args) => calls.push(["emitTo", ...args]),
    show: async () => calls.push(["show"]),
    setFocus: async () => calls.push(["focus"]),
  };

  const result = await openDetachedDocumentWindow(DOCUMENT, {
    WebviewWindowType: class UnexpectedWindow {},
    getByLabel: async (label) => {
      assert.equal(label, DETACHED_DOCUMENT_GROUP_LABEL);
      return existingWindow;
    },
  });

  assert.equal(result, existingWindow);
  assert.deepEqual(calls, [
    ["emitTo", DETACHED_DOCUMENT_GROUP_LABEL, DETACHED_DOCUMENT_ADD_EVENT, DOCUMENT],
    ["show"],
    ["focus"],
  ]);
});

test("独立文件窗口权限只作用于文件窗口标签并允许安全关闭", async () => {
  const { readFile } = await import("node:fs/promises");
  const [mainCapability, detachedCapability] = await Promise.all([
    readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../src-tauri/capabilities/detached-document.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.ok(mainCapability.permissions.includes("core:webview:allow-create-webview-window"));
  assert.ok(mainCapability.permissions.includes("core:webview:allow-get-all-webviews"));
  assert.ok(mainCapability.permissions.includes("core:event:allow-emit-to"));
  assert.deepEqual(detachedCapability.windows, ["document-*"]);
  assert.ok(detachedCapability.permissions.includes("core:window:allow-close"));
  assert.ok(detachedCapability.permissions.includes("core:window:allow-destroy"));
  assert.ok(detachedCapability.permissions.includes("core:window:allow-set-title"));
  assert.ok(!detachedCapability.permissions.includes("updater:allow-download"));
});
