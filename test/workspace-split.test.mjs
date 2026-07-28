import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileSecondaryTabKey,
  resolveWorkspaceSplit,
  visibleWorkspaceTabKeys,
} from "../src/services/workspace-split.js";

const TABS = ["session:server-1", "session:server-2", "document:server-1:/var/log/app.log"];

test("拖拽非活动标签时保留主视图并在右侧打开目标", () => {
  assert.deepEqual(
    resolveWorkspaceSplit("session:server-2", TABS, "session:server-1"),
    {
      primaryTabKey: "session:server-1",
      secondaryTabKey: "session:server-2",
    },
  );
});

test("拖拽活动标签时自动选择另一个标签作为主视图", () => {
  assert.deepEqual(
    resolveWorkspaceSplit("session:server-1", TABS, "session:server-1"),
    {
      primaryTabKey: "session:server-2",
      secondaryTabKey: "session:server-1",
    },
  );
});

test("关闭、激活或移除右侧标签都会清理无效分屏", () => {
  assert.equal(reconcileSecondaryTabKey("session:server-2", TABS, "session:server-1"), "session:server-2");
  assert.equal(reconcileSecondaryTabKey("session:server-2", TABS, "session:server-2"), null);
  assert.equal(reconcileSecondaryTabKey("session:missing", TABS, "session:server-1"), null);
});

test("右侧标签从顶部标签栏移除而不是重复显示", () => {
  assert.deepEqual(visibleWorkspaceTabKeys(TABS, "session:server-2"), [
    "session:server-1",
    "document:server-1:/var/log/app.log",
  ]);
});
