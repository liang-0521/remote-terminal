import { useMemo, useRef } from "react";
import { ListBullets, Plus, Terminal, X } from "@phosphor-icons/react";
import { COMPLETIONS } from "../demoData.js";
import { IconButton } from "./IconButton.jsx";

export function TerminalPane({
  server,
  sessions,
  activeSessionId,
  lines,
  command,
  completionOpen,
  completionIndex,
  appearance,
  onSessionSelect,
  onSessionAdd,
  onSessionClose,
  onCommandChange,
  onCommandKeyDown,
  onCompletionOpen,
  onCompletionSelect,
}) {
  const inputRef = useRef(null);
  const suggestions = useMemo(() => {
    const query = command.trim().toLowerCase();
    if (!query) return COMPLETIONS;
    return COMPLETIONS.filter((item) => item.command.toLowerCase().includes(query));
  }, [command]);

  function moveTabFocus(event, sessionId) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = sessions.findIndex((session) => session.id === sessionId);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? sessions.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length;
    const nextSession = sessions[nextIndex];
    if (!nextSession) return;
    onSessionSelect(nextSession.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`demo-session-tab-${nextSession.id}`)?.focus();
    });
  }

  return (
    <section
      className="terminal-pane"
      style={{
        "--terminal-background": appearance.terminalBackground,
        "--terminal-foreground": appearance.terminalForeground,
      }}
      onClick={() => inputRef.current?.focus()}
    >
      <div className="terminal-tabs" role="tablist" aria-label="服务器工作区" onClick={(event) => event.stopPropagation()}>
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`terminal-tab ${activeSessionId === session.id ? "is-active" : ""}`}
          >
            <button
              id={`demo-session-tab-${session.id}`}
              type="button"
              role="tab"
              className="terminal-tab__select"
              aria-selected={activeSessionId === session.id}
              tabIndex={activeSessionId === session.id ? 0 : -1}
              onClick={() => onSessionSelect(session.id)}
              onKeyDown={(event) => moveTabFocus(event, session.id)}
            >
              <Terminal size={18} />
              <span>{session.label}</span>
            </button>
            <button type="button" className="terminal-tab__close" aria-label={`关闭 ${session.label}`} disabled={sessions.length === 1} title={sessions.length === 1 ? "演示模式至少保留一个工作区" : undefined} onClick={() => onSessionClose(session.id)}>
              <X size={15} />
            </button>
          </div>
        ))}
        <IconButton label="新增服务器工作区" onClick={onSessionAdd}><Plus size={21} /></IconButton>
        <button
          type="button"
          className="completion-trigger"
          aria-haspopup="listbox"
          aria-expanded={completionOpen}
          onClick={onCompletionOpen}
        >
          <ListBullets size={17} />
          命令模板
          <kbd>Ctrl Shift P</kbd>
        </button>
      </div>

      <div className="terminal-surface">
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
        <div className="terminal-transcript" aria-live="polite">
          {lines.map((line, index) => (
            <div key={`${line.text}-${index}`} className={`terminal-line terminal-line--${line.kind}`}>
              {line.prompt && <span className="terminal-prompt">{line.prompt}</span>}
              <span>{line.text}</span>
            </div>
          ))}
          <div className="terminal-command-row">
            <span className="terminal-prompt">[{server.username || "root"}@{server.name} 20260714_101530]$</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(event) => onCommandChange(event.target.value)}
              onKeyDown={(event) => onCommandKeyDown(event, suggestions)}
              aria-label="终端命令输入"
              aria-autocomplete="list"
              aria-controls="terminal-completion-list"
              aria-expanded={completionOpen}
              aria-activedescendant={completionOpen ? `terminal-completion-${completionIndex}` : undefined}
              autoComplete="off"
              spellCheck="false"
            />
          </div>
        </div>

        {completionOpen && (
          <div id="terminal-completion-list" className="completion-popover" role="listbox" aria-label="本地命令模板">
            {suggestions.length ? suggestions.map((item, index) => (
              <button
                key={item.command}
                id={`terminal-completion-${index}`}
                type="button"
                role="option"
                aria-selected={completionIndex === index}
                className={completionIndex === index ? "is-selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onCompletionSelect(item.command)}
              >
                <code>{item.command}</code>
                <span>{item.description}</span>
                <small>{item.source}</small>
              </button>
            )) : <div className="completion-empty">无匹配模板</div>}
            <div className="completion-help">↑↓ 选择 · Enter / Tab 插入 · Esc 关闭 · 不会自动执行</div>
          </div>
        )}
      </div>
    </section>
  );
}
