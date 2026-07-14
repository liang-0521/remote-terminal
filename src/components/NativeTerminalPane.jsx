import { useEffect, useRef, useState } from "react";
import { ListBullets, Plus, Terminal as TerminalIcon, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { IconButton } from "./IconButton.jsx";

const COMMAND_SUGGESTIONS = [
  { command: "ls -lah", description: "查看当前目录详细内容", group: "文件" },
  { command: "cd /var/log", description: "进入系统日志目录", group: "文件" },
  { command: "find . -type f -name '*.log'", description: "按名称查找日志文件", group: "文件" },
  { command: "grep -Rni -- 'ERROR' .", description: "递归查找错误内容", group: "文件" },
  { command: "tail -f /var/log/messages", description: "持续查看系统日志", group: "日志" },
  { command: "journalctl -xe", description: "查看近期系统错误", group: "日志" },
  { command: "journalctl -u nginx -f", description: "持续查看 nginx 服务日志", group: "日志" },
  { command: "systemctl status nginx", description: "查看 nginx 服务状态", group: "服务" },
  { command: "systemctl list-units --failed", description: "查看启动失败的服务", group: "服务" },
  { command: "ps aux --sort=-%cpu | head", description: "查看 CPU 占用最高的进程", group: "性能" },
  { command: "free -h", description: "查看内存与 Swap", group: "性能" },
  { command: "df -h", description: "查看文件系统容量", group: "性能" },
  { command: "ss -lntp", description: "查看正在监听的 TCP 端口", group: "网络" },
  { command: "ip address", description: "查看网络接口与地址", group: "网络" },
  { command: "docker ps", description: "查看运行中的容器", group: "容器" },
  { command: "docker compose ps", description: "查看 Compose 服务状态", group: "容器" },
];
const CLEAR_CURRENT_LINE = "\u0001\u000b";

function matchingCommands(query) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return COMMAND_SUGGESTIONS.slice(0, 8);
  return COMMAND_SUGGESTIONS
    .filter((item) => `${item.command} ${item.description} ${item.group}`.toLocaleLowerCase("zh-CN").includes(normalized))
    .sort((left, right) => {
      const leftPrefix = left.command.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
      const rightPrefix = right.command.toLocaleLowerCase("zh-CN").startsWith(normalized) ? 0 : 1;
      return leftPrefix - rightPrefix;
    })
    .slice(0, 8);
}

export function NativeTerminalPane({
  client,
  sessions,
  activeSessionId,
  appearance,
  onSessionSelect,
  onSessionAdd,
  onSessionClose,
  onTerminalError,
}) {
  const tabRefs = useRef([]);

  function selectRelativeSession(event, currentIndex) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? sessions.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length;
    const nextSession = sessions[nextIndex];
    if (!nextSession) return;
    onSessionSelect(nextSession.id);
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
  }

  function selectNextSession(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || sessions.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = Math.max(0, sessions.findIndex((session) => session.id === activeSessionId));
    const delta = event.shiftKey ? -1 : 1;
    onSessionSelect(sessions[(currentIndex + delta + sessions.length) % sessions.length].id);
  }

  return (
    <section
      className="terminal-pane native-terminal-pane"
      style={{
        "--terminal-background": appearance.terminalBackground,
        "--terminal-foreground": appearance.terminalForeground,
      }}
      onKeyDownCapture={selectNextSession}
    >
      <div className="terminal-tabs" role="tablist" aria-label="SSH 终端工作区">
        {sessions.map((session, index) => {
          const selected = activeSessionId === session.id;
          const tabId = `terminal-tab-${session.id}`;
          const panelId = `terminal-panel-${session.id}`;
          return (
            <div key={session.id} className={`terminal-tab ${selected ? "is-active" : ""}`}>
              <button
                ref={(element) => { tabRefs.current[index] = element; }}
                id={tabId}
                type="button"
                role="tab"
                className="terminal-tab__select"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSessionSelect(session.id)}
                onKeyDown={(event) => selectRelativeSession(event, index)}
              >
                <TerminalIcon size={18} />
                <span>{session.label}</span>
                <i className={`status-dot status-dot--${session.state}`} aria-hidden="true" />
              </button>
              <button type="button" className="terminal-tab__close" aria-label={`关闭 ${session.label}`} onClick={() => onSessionClose(session.id)}>
                <X size={15} />
              </button>
            </div>
          );
        })}
        <IconButton label="新增服务器工作区" onClick={onSessionAdd}><Plus size={21} /></IconButton>
      </div>

      <div className="native-terminal-stack">
        {sessions.map((session) => (
          <div
            key={session.id}
            id={`terminal-panel-${session.id}`}
            role="tabpanel"
            aria-labelledby={`terminal-tab-${session.id}`}
            hidden={activeSessionId !== session.id}
            className={`native-terminal-slot ${activeSessionId === session.id ? "is-active" : ""}`}
          >
            {appearance.wallpaperUrl && (
              <div
                className="terminal-wallpaper"
                aria-hidden="true"
                style={{
                  backgroundImage: `url(${JSON.stringify(appearance.wallpaperUrl)})`,
                  opacity: appearance.wallpaperOpacity,
                }}
              />
            )}
            {session.sessionId && session.state === "connected" ? (
              <XtermSurface
                client={client}
                sessionId={session.sessionId}
                connectionId={session.id}
                active={activeSessionId === session.id}
                appearance={appearance}
                onError={onTerminalError}
              />
            ) : (
              <div className={`native-terminal-placeholder is-${session.state}`} role="status">
                <TerminalIcon size={30} weight="duotone" />
                <strong>{session.state === "connecting" ? "正在建立 SSH 会话…" : session.state === "error" ? "SSH 会话未建立" : "SSH 会话已断开"}</strong>
                <span>{session.error || "请从连接管理器重新连接该服务器。"}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function XtermSurface({ client, sessionId, connectionId, active, appearance, onError }) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const activeRef = useRef(active);
  const paletteInputRef = useRef(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const suggestions = matchingCommands(paletteQuery);
  const selectedSuggestionIndex = suggestions.length ? Math.min(paletteIndex, suggestions.length - 1) : -1;
  const paletteId = `native-command-palette-${connectionId}`;
  const selectedOptionId = selectedSuggestionIndex >= 0 ? `${paletteId}-option-${selectedSuggestionIndex}` : undefined;

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      setPaletteOpen(false);
      setPaletteQuery("");
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = {
      background: appearance.terminalBackground,
      foreground: appearance.terminalForeground,
      cursor: appearance.accent,
      selectionBackground: `${appearance.accent}55`,
    };
  }, [appearance.accent, appearance.terminalBackground, appearance.terminalForeground]);

  useEffect(() => {
    if (!paletteOpen) return undefined;
    const frame = window.requestAnimationFrame(() => paletteInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [paletteOpen]);

  useEffect(() => {
    const element = containerRef.current;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      scrollback: 10_000,
      allowTransparency: true,
      theme: {
        background: appearance.terminalBackground,
        foreground: appearance.terminalForeground,
        cursor: appearance.accent,
        selectionBackground: `${appearance.accent}55`,
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;
    let disposed = false;

    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void client.clipboard.writeText(selection).catch((error) => onError?.(error, connectionId));
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing) return true;
      const ctrlShortcut = event.ctrlKey && !event.altKey && !event.metaKey;
      const opensPalette = ctrlShortcut && (
        (event.shiftKey && event.code === "KeyP")
        || (!event.shiftKey && event.code === "Space")
      );
      if (opensPalette) {
        setPaletteQuery("");
        setPaletteIndex(0);
        setPaletteOpen(true);
        return false;
      }
      if (ctrlShortcut && event.shiftKey && event.code === "KeyC") {
        copySelection();
        return false;
      }
      if (ctrlShortcut && !event.shiftKey && event.code === "KeyC" && terminal.hasSelection()) {
        copySelection();
        return false;
      }
      if (ctrlShortcut && event.shiftKey && event.code === "KeyV") {
        void client.clipboard.readText()
          .then((text) => {
            if (!disposed && text) terminal.paste(text);
          })
          .catch((error) => onError?.(error, connectionId));
        return false;
      }
      return true;
    });

    let attaching = true;
    const pendingData = [];
    const unsubscribe = client.events.onTerminalData((event) => {
      if (event?.sessionId !== sessionId || disposed) return;
      if (attaching) pendingData.push(event.data);
      else terminal.write(event.data);
    });
    const inputSubscription = terminal.onData((data) => {
      void client.terminal.write(sessionId, data).catch((error) => onError?.(error, connectionId));
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (!activeRef.current) return;
      void client.terminal.resize(sessionId, { cols, rows }).catch((error) => onError?.(error, connectionId));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (activeRef.current) fit.fit();
    });
    resizeObserver.observe(element);

    void client.terminal.attach(sessionId)
      .then(({ initialData }) => {
        if (disposed) return;
        terminal.write(initialData);
        for (const data of pendingData) terminal.write(data);
        pendingData.length = 0;
        attaching = false;
        if (activeRef.current) {
          fit.fit();
          terminal.focus();
        }
      })
      .catch((error) => onError?.(error, connectionId));

    return () => {
      disposed = true;
      unsubscribe();
      resizeObserver.disconnect();
      resizeSubscription.dispose();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [client, connectionId, sessionId, onError]);

  function closePalette() {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteIndex(0);
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }

  function insertCommand(command) {
    setPaletteOpen(false);
    setPaletteQuery("");
    setPaletteIndex(0);
    void client.terminal.write(sessionId, `${CLEAR_CURRENT_LINE}${command}`)
      .then(() => window.requestAnimationFrame(() => terminalRef.current?.focus()))
      .catch((error) => onError?.(error, connectionId));
  }

  function handlePaletteKeyDown(event) {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setPaletteIndex((current) => (current + delta + Math.max(suggestions.length, 1)) % Math.max(suggestions.length, 1));
      return;
    }
    if (["Enter", "Tab"].includes(event.key) && suggestions.length) {
      event.preventDefault();
      insertCommand(suggestions[selectedSuggestionIndex].command);
    }
  }

  return (
    <>
      <div ref={containerRef} className="native-xterm" role="region" aria-label="SSH 交互终端" />
      <button
        type="button"
        className="native-completion-trigger"
        aria-expanded={paletteOpen}
        aria-controls={paletteId}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+Shift+P Control+Space"
        aria-label="打开命令模板，快捷键 Ctrl+Shift+P，兼容 Ctrl+Space"
        onClick={() => {
          setPaletteQuery("");
          setPaletteIndex(0);
          setPaletteOpen(true);
        }}
      >
        <ListBullets size={15} /> 命令模板 <kbd>Ctrl+Shift+P</kbd>
      </button>
      {paletteOpen && active && (
        <div id={paletteId} className="completion-popover native-command-palette" role="dialog" aria-label="本地命令模板">
          <div className="native-command-palette__search">
            <ListBullets size={17} />
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              placeholder="搜索命令、用途或分类"
              role="combobox"
              aria-label="搜索命令模板"
              aria-autocomplete="list"
              aria-controls={`${paletteId}-options`}
              aria-expanded="true"
              aria-activedescendant={selectedOptionId}
              onChange={(event) => { setPaletteQuery(event.target.value); setPaletteIndex(0); }}
              onKeyDown={handlePaletteKeyDown}
            />
            <kbd>Esc</kbd>
          </div>
          <div id={`${paletteId}-options`} className="native-command-palette__options" role="listbox" aria-label="匹配的命令模板">
            {suggestions.length ? suggestions.map((item, index) => (
              <button
                key={item.command}
                id={`${paletteId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selectedSuggestionIndex === index}
                className={selectedSuggestionIndex === index ? "is-selected" : ""}
                onMouseEnter={() => setPaletteIndex(index)}
                onClick={() => insertCommand(item.command)}
              >
                <code>{item.command}</code>
                <span>{item.description}</span>
                <small>{item.group}</small>
              </button>
            )) : <div className="completion-empty">没有匹配的命令模板</div>}
          </div>
          <footer>↑/↓ 选择 · Enter/Tab 插入 · Esc 关闭；仅在 Shell 提示符使用，不会自动执行</footer>
        </div>
      )}
    </>
  );
}
