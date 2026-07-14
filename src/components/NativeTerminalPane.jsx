import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListBullets, Plus, Terminal as TerminalIcon, X } from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  buildCommandCompletionCatalog,
  advanceTerminalInputState,
  createTerminalCompletionInput,
  createTerminalInputState,
  isImeCompositionKeyEvent,
  nextCommandCompletionIndex,
  resolveInlineCompletionKeyAction,
  searchCommandCompletions,
} from "../services/command-completion.js";
import { IconButton } from "./IconButton.jsx";

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
  const keyboardTabTargetRef = useRef(null);

  useEffect(() => {
    const targetId = keyboardTabTargetRef.current;
    if (!targetId || targetId !== activeSessionId) return undefined;
    const targetIndex = sessions.findIndex((session) => session.id === targetId);
    if (targetIndex < 0) {
      keyboardTabTargetRef.current = null;
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      tabRefs.current[targetIndex]?.focus();
      keyboardTabTargetRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeSessionId, sessions]);

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
    keyboardTabTargetRef.current = nextSession.id;
    onSessionSelect(nextSession.id);
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
                focusTerminalOnActivate={keyboardTabTargetRef.current !== session.id}
                appearance={appearance}
                remoteCompletions={session.completionCatalog}
                completionLoading={session.completionLoading}
                completionError={session.completionError}
                directoryEntries={session.directoryEntries}
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

function XtermSurface({
  client,
  sessionId,
  connectionId,
  active,
  focusTerminalOnActivate,
  appearance,
  remoteCompletions,
  completionLoading,
  completionError,
  directoryEntries,
  onError,
}) {
  const containerRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const terminalWriteQueueRef = useRef(Promise.resolve());
  const activeRef = useRef(active);
  const completionCatalogRef = useRef([]);
  const completionOpenRef = useRef(false);
  const terminalInputRef = useRef(createTerminalInputState());
  const suggestionIndexRef = useRef(0);
  const suggestionsRef = useRef([]);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState(() => createTerminalInputState());
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const completionCatalog = useMemo(() => buildCommandCompletionCatalog({
    remoteCompletions,
    directoryEntries,
  }), [directoryEntries, remoteCompletions]);
  const suggestions = useMemo(
    () => terminalInput.reliable
      ? searchCommandCompletions(terminalInput.text, { completions: completionCatalog })
      : [],
    [completionCatalog, terminalInput],
  );
  const selectedSuggestionIndex = suggestions.length ? Math.min(suggestionIndex, suggestions.length - 1) : -1;
  const completionId = `native-inline-completions-${connectionId}`;
  const selectedOptionId = selectedSuggestionIndex >= 0 ? `${completionId}-option-${selectedSuggestionIndex}` : undefined;
  completionCatalogRef.current = completionCatalog;
  suggestionsRef.current = suggestions;
  suggestionIndexRef.current = selectedSuggestionIndex;

  const focusTerminalSoon = useCallback(() => {
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, []);

  const closeCompletion = useCallback(() => {
    completionOpenRef.current = false;
    suggestionIndexRef.current = 0;
    setCompletionOpen(false);
    setSuggestionIndex(0);
  }, []);

  const toggleCompletion = useCallback(() => {
    const nextOpen = !completionOpenRef.current;
    completionOpenRef.current = nextOpen;
    suggestionIndexRef.current = 0;
    setCompletionOpen(nextOpen);
    setSuggestionIndex(0);
    focusTerminalSoon();
  }, [focusTerminalSoon]);

  const trackTerminalInput = useCallback((data) => {
    const nextState = advanceTerminalInputState(terminalInputRef.current, data);
    terminalInputRef.current = nextState;
    suggestionsRef.current = nextState.reliable
      ? searchCommandCompletions(nextState.text, { completions: completionCatalogRef.current })
      : [];
    suggestionIndexRef.current = 0;
    setTerminalInput(nextState);
    setSuggestionIndex(0);
    if (!nextState.reliable || /[\r\n\u0003]/.test(data)) closeCompletion();
  }, [closeCompletion]);

  const enqueueTerminalWrite = useCallback((data) => {
    const request = terminalWriteQueueRef.current.then(() => client.terminal.write(sessionId, data));
    terminalWriteQueueRef.current = request.catch(() => undefined);
    return request;
  }, [client, sessionId]);

  const insertCompletion = useCallback((command) => {
    const input = createTerminalCompletionInput(terminalInputRef.current, command);
    if (!input) {
      closeCompletion();
      focusTerminalSoon();
      return;
    }
    const nextState = { reliable: true, text: command };
    terminalInputRef.current = nextState;
    setTerminalInput(nextState);
    closeCompletion();
    void enqueueTerminalWrite(input)
      .then(focusTerminalSoon)
      .catch((error) => {
        const unreliableState = { reliable: false, text: "" };
        terminalInputRef.current = unreliableState;
        setTerminalInput(unreliableState);
        onError?.(error, connectionId);
      });
  }, [closeCompletion, connectionId, enqueueTerminalWrite, focusTerminalSoon, onError]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      closeCompletion();
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (focusTerminalOnActivate) terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, closeCompletion, focusTerminalOnActivate]);

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
      if (event.type !== "keydown" || isImeCompositionKeyEvent(event)) return true;
      const ctrlShortcut = event.ctrlKey && !event.altKey && !event.metaKey;
      const togglesCompletion = ctrlShortcut && (
        (event.shiftKey && event.code === "KeyP")
        || (!event.shiftKey && event.code === "Space")
      );
      if (togglesCompletion) {
        toggleCompletion();
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

      const currentSuggestions = suggestionsRef.current;
      const keyAction = resolveInlineCompletionKeyAction({
        key: event.key,
        open: completionOpenRef.current,
        reliable: terminalInputRef.current.reliable,
        suggestionCount: currentSuggestions.length,
      });
      if (keyAction === "close") {
        closeCompletion();
        return false;
      }
      if (keyAction === "execute") {
        closeCompletion();
        return true;
      }
      if (keyAction === "navigate") {
        const currentIndex = Math.max(0, Math.min(suggestionIndexRef.current, currentSuggestions.length - 1));
        const nextIndex = nextCommandCompletionIndex(currentIndex, event.key, currentSuggestions.length);
        if (nextIndex !== null) {
          suggestionIndexRef.current = nextIndex;
          setSuggestionIndex(nextIndex);
        }
        return false;
      }
      if (keyAction === "insert") {
        const currentIndex = Math.max(0, Math.min(suggestionIndexRef.current, currentSuggestions.length - 1));
        insertCompletion(currentSuggestions[currentIndex].command);
        return false;
      }
      if (completionOpenRef.current && event.key === "Tab") closeCompletion();
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
      trackTerminalInput(data);
      void enqueueTerminalWrite(data).catch((error) => onError?.(error, connectionId));
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
  }, [client, closeCompletion, connectionId, enqueueTerminalWrite, insertCompletion, onError, sessionId, toggleCompletion, trackTerminalInput]);

  return (
    <>
      <div ref={containerRef} className="native-xterm" role="region" aria-label="SSH 交互终端" />
      <button
        type="button"
        className="native-completion-trigger"
        aria-expanded={completionOpen}
        aria-controls={completionId}
        aria-haspopup="listbox"
        aria-keyshortcuts="Control+Shift+P Control+Space"
        aria-label={`${completionOpen ? "关闭" : "打开"}行内智能补全，快捷键 Ctrl+Shift+P，兼容 Ctrl+Space`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleCompletion}
      >
        <ListBullets size={15} /> 智能补全{completionLoading ? "（加载中）" : completionError ? "（部分可用）" : ""} <kbd>Ctrl+Shift+P</kbd>
      </button>
      {completionOpen && active && (
        <div id={completionId} className="native-inline-completions" aria-label="终端行内智能补全">
          <header>
            <span>
              <ListBullets size={17} />
              <strong>{terminalInput.reliable ? "基于当前输入实时匹配" : "当前行不可可靠补全"}</strong>
            </span>
            <kbd>Esc</kbd>
          </header>
          {terminalInput.reliable ? (
            <div
              id={`${completionId}-options`}
              className="native-inline-completions__options"
              role="listbox"
              aria-label="匹配当前终端输入的补全"
              aria-activedescendant={selectedOptionId}
            >
              {suggestions.length ? suggestions.map((item, index) => (
              <button
                key={item.command}
                id={`${completionId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={selectedSuggestionIndex === index}
                className={selectedSuggestionIndex === index ? "is-selected" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => {
                  suggestionIndexRef.current = index;
                  setSuggestionIndex(index);
                }}
                onClick={() => insertCompletion(item.command)}
              >
                <code>{item.command}</code>
                <span>{item.description}</span>
                <small>{item.sourceLabel || item.group}</small>
              </button>
              )) : <div className="native-inline-completions__empty">当前输入没有匹配的补全候选</div>}
            </div>
          ) : (
            <div className="native-inline-completions__empty">
              当前行经过了光标移动、远端 Tab 补全或未知控制输入。请按 Enter 或 Ctrl+C 建立新输入行后再试。
            </div>
          )}
          <footer>
            {completionLoading && "正在加载远端命令与 Shell 历史；内置语义和当前目录候选已可用。 "}
            {completionError && `远端补全加载失败：${completionError}；内置语义和当前目录候选仍可用。 `}
            ↑/↓ 选择 · Tab 插入 · Enter 执行当前行 · Esc 关闭；命令数据不离开本机与当前 SSH 会话
          </footer>
        </div>
      )}
    </>
  );
}
