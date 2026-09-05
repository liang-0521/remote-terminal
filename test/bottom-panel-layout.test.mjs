import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateBottomPanelMaxHeight,
  clampBottomPanelHeight,
  observeBottomPanelLayout,
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

test("终端延迟挂载后重新计入标签栏高度并保留最小编辑区", () => {
  let tabs = null;
  const statusBar = { offsetHeight: 44 };
  const workbench = {
    clientHeight: 795,
    querySelector: (selector) => selector === ".status-bar" ? statusBar : tabs,
  };
  const panel = { offsetHeight: 657, closest: () => workbench };
  const measurements = [];
  const observers = [];
  class Observer {
    observed = new Set();
    disconnected = false;
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(element, options) { this.observed.add(element); this.options = options; }
    unobserve(element) { this.observed.delete(element); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  }
  const dispose = observeBottomPanelLayout(panel, (value) => measurements.push(value), {
    ResizeObserver: Observer,
    MutationObserver: Observer,
  });
  const [resize, children] = observers;
  assert.deepEqual(measurements.at(-1), { height: 657, maxHeight: 679 });
  assert.deepEqual(children.options, { childList: true });

  tabs = { offsetHeight: 56 };
  children.callback();
  assert.equal(measurements.at(-1).maxHeight, 623);
  assert.equal(clampBottomPanelHeight(panel.offsetHeight, measurements.at(-1).maxHeight), 623);
  assert.ok(resize.observed.has(tabs));

  tabs.offsetHeight = 64;
  resize.callback();
  assert.equal(measurements.at(-1).maxHeight, 615);
  const previousTabs = tabs;
  tabs = { offsetHeight: 48 };
  children.callback();
  assert.equal(measurements.at(-1).maxHeight, 631);
  assert.equal(resize.observed.has(previousTabs), false);
  assert.ok(resize.observed.has(tabs));

  dispose();
  assert.ok(observers.every((observer) => observer.disconnected));
});
