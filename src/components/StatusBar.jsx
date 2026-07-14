import { Circle } from "@phosphor-icons/react";

const NATIVE_STATE_LABELS = {
  connected: "SSH 已连接",
  connecting: "正在连接",
  disconnected: "SSH 未连接",
  error: "连接失败",
};

export function StatusBar({ server, runtimeMode = "demo", error }) {
  if (runtimeMode === "native") {
    return (
      <footer className="status-bar">
        <span><Circle size={11} weight="fill" /> {server ? `SSH: ${server.endpoint}` : "尚未选择服务器"}</span>
        <span>{server ? NATIVE_STATE_LABELS[server.state] || "状态未知" : "等待连接"}</span>
        <span className="status-bar__right">
          {error || (server?.hasSavedPassword ? "原生模式 · 密码已由 Windows 加密保存" : "原生模式 · 每次连接询问密码")}
        </span>
      </footer>
    );
  }
  return (
    <footer className="status-bar">
      <span><Circle size={11} weight="fill" /> 模拟 SSH: {server.endpoint}</span>
      <span>{server.state === "connected" ? "演示就绪" : "演示离线"}</span>
      <span className="status-bar__right">演示模式 · 未接入真实 SSH / SFTP</span>
    </footer>
  );
}
