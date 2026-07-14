import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppErrorBoundary,
  renderErrorMessage,
} from "../src/components/AppErrorBoundary.js";

test("错误边界保留原始渲染错误，并规范化可见信息", () => {
  const error = new Error("监控数据无法渲染");

  assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(error), { error, hasError: true });
  assert.equal(renderErrorMessage(error), "监控数据无法渲染");
  assert.equal(renderErrorMessage("  字符串错误  "), "字符串错误");
  assert.equal(renderErrorMessage(null), "未能获取渲染错误详情。");
});

test("错误边界正常时透传子界面，故障时显示可恢复的明确错误页", () => {
  const boundary = new AppErrorBoundary({
    children: createElement("span", null, "正常界面"),
  });

  assert.equal(renderToStaticMarkup(boundary.render()), "<span>正常界面</span>");

  boundary.state = AppErrorBoundary.getDerivedStateFromError(new Error("文件系统容量异常"));
  const fallback = renderToStaticMarkup(boundary.render());

  assert.match(fallback, /role="alert"/);
  assert.match(fallback, /应用界面发生错误/);
  assert.match(fallback, /文件系统容量异常/);
  assert.match(fallback, /重新加载客户端/);
});

test("错误边界即使捕获 falsey throw 也不会重新渲染故障子树", () => {
  const boundary = new AppErrorBoundary({
    children: createElement("span", null, "不应再次渲染"),
  });

  boundary.state = AppErrorBoundary.getDerivedStateFromError(null);
  const fallback = renderToStaticMarkup(boundary.render());

  assert.match(fallback, /应用界面发生错误/);
  assert.doesNotMatch(fallback, /不应再次渲染/);
  assert.match(fallback, /未能获取渲染错误详情/);
});
