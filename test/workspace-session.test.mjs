import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConnectedWorkspace,
  applyWorkspaceSessionEvent,
  canUseRemoteFiles,
  isRemoteFileRequestCurrent,
  isRemoteFileSessionCurrent,
} from "../src/services/workspace-session.js";

function connectedWorkspace(overrides = {}) {
  return {
    sessionId: "session-old",
    terminalSessionId: "session-old",
    state: "connected",
    error: "",
    directory: "/srv/releases",
    entries: [{ name: "app.zip", type: "file" }],
    filesLoading: true,
    filesError: "",
    sftpError: "",
    monitorLoading: true,
    ...overrides,
  };
}

test("断线只失效运行时会话并保留远程文件快照", () => {
  const current = connectedWorkspace();
  const next = applyWorkspaceSessionEvent(current, {
    sessionId: "session-old",
    state: "disconnected",
  });

  assert.equal(next.sessionId, null);
  assert.equal(next.terminalSessionId, "session-old");
  assert.equal(next.directory, "/srv/releases");
  assert.strictEqual(next.entries, current.entries);
  assert.equal(next.filesLoading, false);
  assert.equal(next.monitorLoading, false);
});

test("旧会话迟到的断线事件不能覆盖新会话", () => {
  const current = connectedWorkspace({
    sessionId: "session-new",
    terminalSessionId: "session-new",
  });
  const next = applyWorkspaceSessionEvent(current, {
    sessionId: "session-old",
    state: "disconnected",
  });

  assert.strictEqual(next, current);
});

test("重连刷新断线前路径，首次连接才使用服务器主目录", () => {
  const cachedEntries = [{ name: "app.zip", type: "file" }];
  const resumed = applyConnectedWorkspace(
    connectedWorkspace({ sessionId: null, state: "disconnected", entries: cachedEntries }),
    { sessionId: "session-new", home: "/root" },
  );
  const firstConnection = applyConnectedWorkspace(
    connectedWorkspace({ sessionId: null, state: "disconnected", directory: null, entries: [] }),
    { sessionId: "session-first", home: "/home/deploy" },
  );

  assert.equal(resumed.directory, "/srv/releases");
  assert.strictEqual(resumed.entries, cachedEntries);
  assert.equal(resumed.sessionId, "session-new");
  assert.equal(firstConnection.directory, "/home/deploy");
});

test("远程文件动作只在当前 SSH 与 SFTP 会话可用时启用", () => {
  assert.equal(canUseRemoteFiles(connectedWorkspace()), true);
  assert.equal(canUseRemoteFiles(connectedWorkspace({ state: "connecting" })), false);
  assert.equal(canUseRemoteFiles(connectedWorkspace({ sessionId: null, state: "disconnected" })), false);
  assert.equal(canUseRemoteFiles(connectedWorkspace({ sftpError: "SFTP 子系统不可用" })), false);
});

test("目录树请求同时按工作区和会话代次隔离", () => {
  const oldRequest = { treeKey: "server-1", sessionKey: "session-old" };

  assert.equal(isRemoteFileRequestCurrent(oldRequest, oldRequest), true);
  assert.equal(isRemoteFileRequestCurrent(oldRequest, { treeKey: "server-1", sessionKey: "session-new" }), false);
  assert.equal(isRemoteFileRequestCurrent(oldRequest, { treeKey: "server-2", sessionKey: "session-old" }), false);
  assert.equal(isRemoteFileSessionCurrent(connectedWorkspace(), "session-old"), true);
  assert.equal(isRemoteFileSessionCurrent(connectedWorkspace(), "session-new"), false);
});
