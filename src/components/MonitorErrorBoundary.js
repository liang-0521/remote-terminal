import { Component, createElement } from "react";
import { WarningCircle } from "@phosphor-icons/react";

function initialState() {
  return { error: null, hasError: false };
}

export class MonitorErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = initialState();
  }

  static getDerivedStateFromError(error) {
    return { error, hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("监控视图渲染失败", error, info.componentStack);
  }

  componentDidUpdate(previousProps) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState(initialState());
    }
  }

  retry = () => {
    this.props.onRetry?.();
    this.setState(initialState());
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return createElement(
      "div",
      { className: "monitor-dashboard monitor-dashboard--empty", role: "alert" },
      createElement(WarningCircle, { size: 26, weight: "duotone", "aria-hidden": "true" }),
      createElement("strong", null, "监控视图暂时不可用"),
      createElement("span", null, "监控组件未能加载或数据格式异常；终端、传输和其他工作区仍在运行。"),
      createElement(
        "button",
        { type: "button", className: "text-button", onClick: this.retry },
        "重试监控",
      ),
    );
  }
}
