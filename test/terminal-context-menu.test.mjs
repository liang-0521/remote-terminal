import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  clampTerminalContextMenuPosition,
  copyTerminalSelection,
  isTerminalContextMenuKey,
  nextTerminalContextMenuFocusIndex,
  pasteTerminalClipboard,
  readTerminalSelection,
  shouldFocusTerminal,
} from "../src/services/terminal-context-menu.js";

test("终端右键菜单始终限制在当前窗口内", () => {
  assert.deepEqual(
    clampTerminalContextMenuPosition(
      { x: 790, y: 590 },
      { width: 220, height: 140 },
      { width: 800, height: 600 },
    ),
    { left: 572, top: 452 },
  );
  assert.deepEqual(
    clampTerminalContextMenuPosition(
      { x: -20, y: Number.NaN },
      { width: 220, height: 140 },
      { width: 800, height: 600 },
    ),
    { left: 8, top: 8 },
  );
});

test("终端右键菜单支持循环方向键和首尾导航", () => {
  assert.equal(nextTerminalContextMenuFocusIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextTerminalContextMenuFocusIndex("ArrowDown", 2, 3), 0);
  assert.equal(nextTerminalContextMenuFocusIndex("ArrowUp", -1, 3), 2);
  assert.equal(nextTerminalContextMenuFocusIndex("ArrowUp", 0, 3), 2);
  assert.equal(nextTerminalContextMenuFocusIndex("Home", 2, 3), 0);
  assert.equal(nextTerminalContextMenuFocusIndex("End", 0, 3), 2);
  assert.equal(nextTerminalContextMenuFocusIndex("Tab", 0, 3), null);
});

test("菜单键和 Shift+F10 都能打开终端菜单", () => {
  assert.equal(isTerminalContextMenuKey({ key: "ContextMenu" }), true);
  assert.equal(isTerminalContextMenuKey({ code: "ContextMenu" }), true);
  assert.equal(isTerminalContextMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isTerminalContextMenuKey({ key: "F10", shiftKey: false }), false);
});

test("后台连接完成不会从外部输入框抢回终端焦点", () => {
  const body = {};
  const terminalInput = {};
  const dialogInput = { id: "settings-accent", closest: () => null };
  const activeTab = { id: "terminal-tab-server-a", closest: () => null };
  const menuItem = { closest: (selector) => selector === ".terminal-context-menu" ? {} : null };
  const terminalSlot = { contains: (element) => element === terminalInput };
  const base = {
    active: true,
    contextMenuOpen: false,
    commandSearchOpen: false,
    body,
    terminalSlot,
    terminalTabId: "terminal-tab-server-a",
    focusTerminalOnActivate: true,
  };

  assert.equal(shouldFocusTerminal({ ...base, activeElement: body }), true);
  assert.equal(shouldFocusTerminal({ ...base, activeElement: terminalInput }), true);
  assert.equal(shouldFocusTerminal({ ...base, activeElement: menuItem }), true);
  assert.equal(shouldFocusTerminal({ ...base, activeElement: activeTab }), true);
  assert.equal(shouldFocusTerminal({ ...base, activeElement: dialogInput }), false);
  assert.equal(shouldFocusTerminal({ ...base, active: false, activeElement: body }), false);
  assert.equal(shouldFocusTerminal({ ...base, contextMenuOpen: true, activeElement: menuItem }), false);
  assert.equal(shouldFocusTerminal({ ...base, commandSearchOpen: true, activeElement: terminalInput }), false);
});

test("复制保留多行、中文和空白并忽略空选区", async () => {
  const writes = [];
  const clipboard = { async writeText(text) { writes.push(text); } };
  const selection = "  第一行\r\nsecond line  ";
  const terminal = { getSelection: () => selection };

  assert.equal(readTerminalSelection(terminal), selection);
  assert.equal(await copyTerminalSelection(clipboard, selection), true);
  assert.equal(await copyTerminalSelection(clipboard, ""), false);
  assert.deepEqual(writes, [selection]);
});

test("异步读取剪贴板期间切换会话会取消粘贴", async () => {
  let resolveClipboard;
  let active = true;
  const pasted = [];
  const clipboard = {
    readText() {
      return new Promise((resolve) => { resolveClipboard = resolve; });
    },
  };
  const terminal = { paste(text) { pasted.push(text); } };

  const request = pasteTerminalClipboard(clipboard, terminal, () => active);
  active = false;
  resolveClipboard("sudo reboot\r");

  assert.equal(await request, false);
  assert.deepEqual(pasted, []);
});

test("终端菜单绑定触发会话的选区快照且不破坏 Ctrl+C 中断语义", async () => {
  const paneUrl = new URL("../src/components/terminal/NativeTerminalPane.jsx", import.meta.url);
  const menuUrl = new URL("../src/components/terminal/TerminalContextMenu.jsx", import.meta.url);
  const [paneSource, menuSource] = await Promise.all([
    readFile(paneUrl, "utf8"),
    readFile(menuUrl, "utf8"),
  ]);

  assert.match(paneSource, /setTerminalContextMenu\(\{\s*connectionId,\s*x: anchor\.x,\s*y: anchor\.y,\s*selection: readTerminalSelection\(terminal\)/s);
  assert.match(paneSource, /terminalRef\.current === terminal/);
  assert.match(paneSource, /sessionIdRef\.current === targetSessionId/);
  assert.match(paneSource, /activeRef\.current = active/);
  assert.match(paneSource, /previousActiveRef\.current !== active/);
  assert.match(paneSource, /const queuedSessionId = sessionIdRef\.current/);
  assert.match(paneSource, /sessionIdRef\.current !== queuedSessionId/);
  assert.match(paneSource, /onMouseDownCapture=\{blockRemoteTerminalRightClick\}/);
  assert.match(paneSource, /onContextMenuCapture=\{handleTerminalContextMenu\}/);
  assert.match(paneSource, /ctrlShortcut && !event\.shiftKey && event\.code === "KeyC" && terminal\.hasSelection\(\)/);
  assert.doesNotMatch(paneSource, /navigator\.clipboard/);

  assert.match(menuSource, /role="menu"/);
  assert.match(menuSource, /<span>复制<\/span>/);
  assert.match(menuSource, /<span>粘贴<\/span>/);
  assert.match(menuSource, /<span>全选终端内容<\/span>/);
  assert.match(menuSource, /disabled=\{!request\.selection\}/);
  assert.match(menuSource, /event\.key === "Tab"/);
  assert.equal(menuSource.match(/tabIndex=\{-1\}/g)?.length, 3);
});

test("终端右键菜单在明暗界面中都保持白底深色文字", async () => {
  const styleUrl = new URL("../src/native-styles.css", import.meta.url);
  const styleSource = await readFile(styleUrl, "utf8");
  const contextMenuRule = styleSource.match(
    /\.remote-file-context-menu,\s*\.terminal-context-menu\s*\{([^}]+)\}/,
  );

  assert.ok(contextMenuRule, "应存在终端右键菜单样式");
  assert.match(contextMenuRule[1], /--context-menu-surface:\s*#fff/);
  assert.match(contextMenuRule[1], /--context-menu-text:\s*#253044/);
  assert.match(contextMenuRule[1], /background:\s*var\(--context-menu-surface\)/);
  assert.match(contextMenuRule[1], /box-shadow:\s*0 14px 36px var\(--context-menu-shadow\)/);
  assert.doesNotMatch(contextMenuRule[1], /surface-completion-native|terminal-background/);
});
