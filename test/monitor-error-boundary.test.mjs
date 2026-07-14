import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MonitorErrorBoundary } from "../src/components/MonitorErrorBoundary.js";
import { toMonitorPercent } from "../src/services/monitor-metrics.js";

function renderBoundaryFallback(error, props = {}) {
  const boundary = new MonitorErrorBoundary({
    children: createElement("span", null, "监控内容"),
    resetKey: "sample-1",
    ...props,
  });
  boundary.state = MonitorErrorBoundary.getDerivedStateFromError(error);
  return { boundary, markup: renderToStaticMarkup(boundary.render()) };
}

test("无效监控指标由局部边界转换为可恢复视图，不使用应用级错误页", () => {
  let renderError;
  try {
    toMonitorPercent(0, 0, "内存");
  } catch (error) {
    renderError = error;
  }

  assert.match(renderError?.message || "", /内存/);
  const { markup } = renderBoundaryFallback(renderError);
  assert.match(markup, /role="alert"/);
  assert.match(markup, /监控视图暂时不可用/);
  assert.match(markup, /终端、传输和其他工作区仍在运行/);
  assert.match(markup, /重试监控/);
  assert.doesNotMatch(markup, /应用界面发生错误/);
});

test("懒加载失败停留在局部恢复视图，重试动作和新采样键可重置边界", () => {
  let retries = 0;
  const { boundary, markup } = renderBoundaryFallback(
    new Error("Failed to fetch dynamically imported module"),
    { onRetry: () => { retries += 1; } },
  );
  assert.match(markup, /监控视图暂时不可用/);
  assert.doesNotMatch(markup, /应用界面发生错误/);
  boundary.setState = (nextState) => {
    boundary.state = typeof nextState === "function" ? nextState(boundary.state) : nextState;
  };

  boundary.retry();
  assert.equal(retries, 1);
  assert.deepEqual(boundary.state, { error: null, hasError: false });

  boundary.state = MonitorErrorBoundary.getDerivedStateFromError(new Error("invalid sample"));
  boundary.props = { ...boundary.props, resetKey: "sample-2" };
  boundary.componentDidUpdate({ ...boundary.props, resetKey: "sample-1" });
  assert.deepEqual(boundary.state, { error: null, hasError: false });
});
