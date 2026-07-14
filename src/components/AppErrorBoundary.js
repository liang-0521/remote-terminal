import { Component, createElement } from "react";
import { WarningCircle } from "@phosphor-icons/react";

const UNKNOWN_RENDER_ERROR = "未能获取渲染错误详情。";

export function renderErrorMessage(error) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return UNKNOWN_RENDER_ERROR;
}

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { error, hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("React 界面渲染失败", error, info.componentStack);
  }

  reloadApplication = () => {
    window.location.reload();
  };

  render() {
    const { error, hasError } = this.state;
    if (!hasError) return this.props.children;

    return createElement(
      "main",
      { className: "app-error-boundary", role: "alert", "aria-live": "assertive" },
      createElement(
        "section",
        { className: "app-error-boundary__panel", "aria-labelledby": "app-render-error-title" },
        createElement(
          "span",
          { className: "app-error-boundary__mark", "aria-hidden": "true" },
          createElement(WarningCircle, { size: 24, weight: "duotone" }),
        ),
        createElement("h1", { id: "app-render-error-title" }, "应用界面发生错误"),
        createElement(
          "p",
          null,
          "某个界面组件未能正常渲染。客户端已停止显示故障界面，并保留本次错误信息。",
        ),
        createElement(
          "div",
          { className: "app-error-boundary__details" },
          createElement("span", null, "错误信息"),
          createElement("code", null, renderErrorMessage(error)),
        ),
        createElement(
          "button",
          { type: "button", onClick: this.reloadApplication },
          "重新加载客户端",
        ),
        createElement("small", null, "如果问题重复出现，请记录触发操作后再反馈。"),
      ),
    );
  }
}
