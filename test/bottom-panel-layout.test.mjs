import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBottomPanelMaxHeight,
  clampBottomPanelHeight,
} from "../src/services/bottom-panel-layout.js";

test("底部面板最高只保留标签栏、状态栏和一小块命令区", () => {
  assert.equal(calculateBottomPanelMaxHeight({
    workbenchHeight: 900,
    terminalTabsHeight: 56,
    statusBarHeight: 44,
  }), 728);
  assert.equal(clampBottomPanelHeight(880, 728), 728);
  assert.equal(clampBottomPanelHeight(40, 728), 120);
});
