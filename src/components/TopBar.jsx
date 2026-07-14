import { useEffect, useRef } from "react";
import {
  ArrowsDownUp,
  CaretDown,
  Circle,
  Cpu,
  HardDrives,
  List,
  Memory,
  Plus,
} from "@phosphor-icons/react";
import { IconButton } from "./IconButton.jsx";

const NATIVE_CONNECTION_LABELS = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "未连接",
  error: "连接失败",
};

export function TopBar({ server, servers, metrics, runtimeMode = "demo", menuOpen, onToggleMenu, onSelectServer, onAddServer, onToggleRail, onOpenMonitor }) {
  const pickerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuItemRefs = useRef([]);
  const pendingFocusIndexRef = useRef(null);
  const toggleMenuRef = useRef(onToggleMenu);
  const connected = server?.state === "connected";
  const memoryPercent = metrics && metrics.memoryTotal > 0 ? (metrics.memoryUsed / metrics.memoryTotal) * 100 : null;
  const swapPercent = metrics && metrics.swapTotal > 0 ? (metrics.swapUsed / metrics.swapTotal) * 100 : metrics?.swapTotal === 0 ? 0 : null;
  const connectionLabel = runtimeMode === "native"
    ? (server ? NATIVE_CONNECTION_LABELS[server.state] || "状态未知" : "未选择服务器")
    : connected ? "模拟连接" : "模拟离线";
  const currentServerIndex = Math.max(0, servers.findIndex((item) => item.id === server?.id));

  useEffect(() => {
    toggleMenuRef.current = onToggleMenu;
  }, [onToggleMenu]);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const focusIndex = pendingFocusIndexRef.current ?? currentServerIndex;
    pendingFocusIndexRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => menuItemRefs.current[focusIndex]?.focus());

    function handleOutsidePointerDown(event) {
      if (!pickerRef.current?.contains(event.target)) toggleMenuRef.current?.();
    }

    function handleEscape(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMenuRef.current?.();
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [currentServerIndex, menuOpen]);

  function toggleServerMenu() {
    if (!menuOpen) pendingFocusIndexRef.current = currentServerIndex;
    onToggleMenu();
  }

  function openMenuFromKeyboard(event) {
    const focusByKey = {
      ArrowDown: 0,
      ArrowUp: Math.max(servers.length - 1, 0),
      Home: 0,
      End: Math.max(servers.length - 1, 0),
    };
    if (!(event.key in focusByKey) || menuOpen) return;
    event.preventDefault();
    pendingFocusIndexRef.current = focusByKey[event.key];
    onToggleMenu();
  }

  function handleMenuKeyDown(event) {
    if (event.key === "Tab") {
      toggleMenuRef.current?.();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || servers.length === 0) return;
    event.preventDefault();
    const focusedIndex = Math.max(0, menuItemRefs.current.indexOf(document.activeElement));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? servers.length - 1
        : (focusedIndex + (event.key === "ArrowDown" ? 1 : -1) + servers.length) % servers.length;
    menuItemRefs.current[nextIndex]?.focus();
  }

  return (
    <header className="top-bar">
      <IconButton label="折叠导航" className="top-bar__menu" onClick={onToggleRail}>
        <List size={24} />
      </IconButton>
      <span className="top-bar__product">服务器</span>
      <div ref={pickerRef} className="server-picker">
        <button
          ref={triggerRef}
          id="server-picker-trigger"
          type="button"
          className="server-picker__trigger"
          aria-controls="server-picker-menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={toggleServerMenu}
          onKeyDown={openMenuFromKeyboard}
        >
          <span>{server?.endpoint || "选择或新增服务器"}</span>
          <CaretDown size={16} />
        </button>
        {menuOpen && (
          <div id="server-picker-menu" className="server-picker__menu" role="menu" aria-labelledby="server-picker-trigger" onKeyDown={handleMenuKeyDown}>
            {servers.map((item, index) => {
              const current = item.id === server?.id;
              return <button
                ref={(element) => { menuItemRefs.current[index] = element; }}
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={current ? "is-current" : ""}
                aria-current={current ? "true" : undefined}
                onClick={() => onSelectServer(item.id)}
              >
                <HardDrives size={18} weight={current ? "duotone" : "regular"} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.endpoint}</small>
                </span>
                <i className={`status-dot status-dot--${item.state}`} />
              </button>;
            })}
          </div>
        )}
      </div>
      <IconButton label="新增服务器" className="server-add-button" onClick={onAddServer}>
        <Plus size={20} />
      </IconButton>

      <div className={`connection-pill ${connected ? "is-connected" : ""} ${server?.state === "error" ? "is-error" : ""}`}>
        <Circle size={10} weight="fill" />
        {connectionLabel}
      </div>

      <button type="button" className="top-health" aria-label="打开性能监控" onClick={onOpenMonitor}>
        <HealthSummary icon={<Cpu size={16} />} label="CPU" value={metrics ? `${metrics.cpu}%` : "—"} percent={metrics?.cpu ?? null} />
        <HealthSummary icon={<Memory size={16} />} label="内存" value={metrics ? `${metrics.memoryUsed} / ${metrics.memoryTotal} GB` : "—"} percent={memoryPercent} />
        <HealthSummary icon={<ArrowsDownUp size={16} />} label="Swap" value={metrics ? `${metrics.swapUsed} / ${metrics.swapTotal} GB` : "—"} percent={swapPercent} />
      </button>
    </header>
  );
}

function HealthSummary({ icon, label, value, percent }) {
  return (
    <span className={`top-health__item ${percent === null ? "is-unavailable" : ""}`}>
      <span className="top-health__copy">{icon}<strong>{label}</strong><small>{value}</small></span>
      {percent === null ? <span className="top-health__placeholder" aria-hidden="true" /> : <progress max="100" value={percent} aria-label={`${label} 使用率`} />}
    </span>
  );
}
