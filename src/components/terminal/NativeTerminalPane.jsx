import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ClockCounterClockwise,
  MagnifyingGlass,
  Plus,
  Terminal as TerminalIcon,
  Trash,
  X,
} from "@phosphor-icons/react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  buildCommandCompletionCatalog,
  advanceTerminalInputState,
  calculateInlineCompletionPosition,
  collectExecutedTerminalCommands,
  createTerminalCompletionInput,
  createTerminalInputState,
  isImeCompositionKeyEvent,
  nextCommandCompletionIndex,
  resolveInlineCompletionKeyAction,
  searchCommandCompletions,
  searchInlineCommandCompletions,
  shouldAutoOpenCommandCompletion,
} from "../../services/command-completion.js";
import { IconButton } from "../shared/IconButton.jsx";

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
  const historyMutationQueueRef = useRef(Promise.resolve());
  const activeRef = useRef(active);
  const commandSearchInputRef = useRef(null);
  const completionCatalogRef = useRef([]);
  const inlineCompletionOpenRef = useRef(false);
  const commandSearchOpenRef = useRef(false);
  const terminalInputRef = useRef(createTerminalInputState());
  const suggestionIndexRef = useRef(0);
  const suggestionsRef = useRef([]);
  const [inlineCompletionOpen, setInlineCompletionOpen] = useState(false);
  const [commandSearchOpen, setCommandSearchOpen] = useState(false);
  const [commandSearchQuery, setCommandSearchQuery] = useState("");
  const [commandSearchIndex, setCommandSearchIndex] = useState(0);
  const [localHistory, setLocalHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyPendingCommands, setHistoryPendingCommands] = useState(() => new Set());
  const [historyCandidateNotice, setHistoryCandidateNotice] = useState("");
  const [terminalInput, setTerminalInput] = useState(() => createTerminalInputState());
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [inlineAnchor, setInlineAnchor] = useState({ left: 12, top: 42, placement: "below" });
  const localHistoryCompletions = useMemo(
    () => localHistory.map((command) => ({ command, source: "history" })),
    [localHistory],
  );
  const completionCatalog = useMemo(() => buildCommandCompletionCatalog({
    remoteCompletions: [
      ...localHistoryCompletions,
      ...(Array.isArray(remoteCompletions) ? remoteCompletions : []),
    ],
    directoryEntries,
  }), [
    directoryEntries,
    localHistoryCompletions,
    remoteCompletions,
  ]);
  const inlineSuggestions = useMemo(
    () => terminalInput.reliable
      ? searchInlineCommandCompletions(terminalInput.text, { completions: completionCatalog, limit: 10 })
      : [],
    [completionCatalog, terminalInput],
  );
  const commandSearchResults = useMemo(
    () => searchCommandCompletions(commandSearchQuery, { completions: completionCatalog, limit: 30 }),
    [commandSearchQuery, completionCatalog],
  );
  const selectedSuggestionIndex = inlineSuggestions.length ? Math.min(suggestionIndex, inlineSuggestions.length - 1) : -1;
  const selectedSearchIndex = commandSearchResults.length ? Math.min(commandSearchIndex, commandSearchResults.length - 1) : -1;
  const inlineCompletionId = `native-inline-completions-${connectionId}`;
  const commandSearchId = `native-command-search-${connectionId}`;
  const selectedInlineOptionId = selectedSuggestionIndex >= 0
    ? `${inlineCompletionId}-option-${selectedSuggestionIndex}`
    : undefined;
  const selectedSearchOptionId = selectedSearchIndex >= 0
    ? `${commandSearchId}-option-${selectedSearchIndex}`
    : undefined;
  completionCatalogRef.current = completionCatalog;
  suggestionsRef.current = inlineSuggestions;
  suggestionIndexRef.current = selectedSuggestionIndex;

  const focusTerminalSoon = useCallback(() => {
    window.requestAnimationFrame(() => terminalRef.current?.focus());
  }, []);

  const updateInlineAnchor = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const slot = container?.closest(".native-terminal-slot");
    const screen = container?.querySelector(".xterm-screen");
    if (!terminal || !slot || !screen || terminal.cols <= 0 || terminal.rows <= 0) return;
    const slotRect = slot.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const lineHeight = screenRect.height / terminal.rows;
    const popoverWidth = Math.max(1, Math.min(420, slotRect.width - 16));
    const popoverHeight = Math.max(38, Math.min(suggestionsRef.current.length, 10) * 36 + 2);
    const nextAnchor = calculateInlineCompletionPosition({
      cursorLeft: screenRect.left - slotRect.left + (terminal.buffer.active.cursorX * cellWidth) + 2,
      cursorTop: screenRect.top - slotRect.top + (terminal.buffer.active.cursorY * lineHeight),
      lineHeight,
      containerWidth: slotRect.width,
      containerHeight: slotRect.height,
      popoverWidth,
      popoverHeight,
    });
    setInlineAnchor(nextAnchor);
  }, []);

  const closeInlineCompletion = useCallback(() => {
    inlineCompletionOpenRef.current = false;
    suggestionIndexRef.current = 0;
    setInlineCompletionOpen(false);
    setSuggestionIndex(0);
  }, []);

  const closeCommandSearch = useCallback(({ returnFocus = true } = {}) => {
    commandSearchOpenRef.current = false;
    setCommandSearchOpen(false);
    setCommandSearchQuery("");
    setCommandSearchIndex(0);
    if (returnFocus) focusTerminalSoon();
  }, [focusTerminalSoon]);

  const openCommandSearch = useCallback(() => {
    closeInlineCompletion();
    commandSearchOpenRef.current = true;
    setCommandSearchOpen(true);
    setCommandSearchQuery("");
    setCommandSearchIndex(0);
    window.requestAnimationFrame(() => commandSearchInputRef.current?.focus());
  }, [closeInlineCompletion]);

  const toggleCommandSearch = useCallback(() => {
    if (commandSearchOpenRef.current) closeCommandSearch();
    else openCommandSearch();
  }, [closeCommandSearch, openCommandSearch]);

  const trackTerminalInput = useCallback((data) => {
    const nextState = advanceTerminalInputState(terminalInputRef.current, data);
    terminalInputRef.current = nextState;
    const nextSuggestions = nextState.reliable
      ? searchInlineCommandCompletions(nextState.text, { completions: completionCatalogRef.current, limit: 10 })
      : [];
    suggestionsRef.current = nextSuggestions;
    suggestionIndexRef.current = 0;
    setTerminalInput(nextState);
    setSuggestionIndex(0);
    if (!nextState.reliable || /[\r\n\u0003]/.test(data)) {
      closeInlineCompletion();
      return;
    }
    const nextOpen = shouldAutoOpenCommandCompletion(nextState, nextSuggestions.length);
    inlineCompletionOpenRef.current = nextOpen;
    setInlineCompletionOpen(nextOpen);
    if (nextOpen) window.requestAnimationFrame(updateInlineAnchor);
  }, [closeInlineCompletion, updateInlineAnchor]);

  const enqueueTerminalWrite = useCallback((data) => {
    const request = terminalWriteQueueRef.current.then(() => client.terminal.write(sessionId, data));
    terminalWriteQueueRef.current = request.catch(() => undefined);
    return request;
  }, [client, sessionId]);

  const enqueueHistoryMutation = useCallback((operation) => {
    const request = historyMutationQueueRef.current.then(operation);
    historyMutationQueueRef.current = request.catch(() => undefined);
    return request;
  }, []);

  const reportHistoryError = useCallback((error) => {
    const message = error instanceof Error && error.message
      ? error.message
      : "本机命令历史操作失败。";
    setHistoryError(message);
  }, []);

  const recordExecutedCommands = useCallback((commands) => {
    for (const command of commands) {
      void enqueueHistoryMutation(() => client.terminal.history.record(connectionId, command))
        .then((nextHistory) => {
          setLocalHistory(nextHistory);
          setHistoryError("");
        })
        .catch(reportHistoryError);
    }
  }, [client, connectionId, enqueueHistoryMutation, reportHistoryError]);

  const insertCompletion = useCallback((command) => {
    const input = createTerminalCompletionInput(terminalInputRef.current, command);
    if (!input) {
      closeInlineCompletion();
      closeCommandSearch({ returnFocus: false });
      focusTerminalSoon();
      return;
    }
    const nextState = { reliable: true, text: command };
    terminalInputRef.current = nextState;
    setTerminalInput(nextState);
    closeInlineCompletion();
    closeCommandSearch({ returnFocus: false });
    void enqueueTerminalWrite(input)
      .then(focusTerminalSoon)
      .catch((error) => {
        const unreliableState = { reliable: false, text: "" };
        terminalInputRef.current = unreliableState;
        setTerminalInput(unreliableState);
        onError?.(error, connectionId);
      });
  }, [closeCommandSearch, closeInlineCompletion, connectionId, enqueueTerminalWrite, focusTerminalSoon, onError]);

  const removeHistoryCandidate = useCallback((item) => {
    if (item?.source !== "history") return;
    setHistoryPendingCommands((current) => {
      const next = new Set(current);
      next.add(item.command);
      return next;
    });
    setHistoryCandidateNotice("");
    void enqueueHistoryMutation(() => client.terminal.history.remove(connectionId, item.command))
      .then((nextHistory) => {
        setLocalHistory(nextHistory);
        setHistoryError("");
        setCommandSearchIndex(0);
        setHistoryCandidateNotice(`已从本机为此服务器保存的命令历史中永久删除“${item.command}”。`);
      })
      .catch(reportHistoryError)
      .finally(() => {
        setHistoryPendingCommands((current) => {
          const next = new Set(current);
          next.delete(item.command);
          return next;
        });
        window.requestAnimationFrame(() => commandSearchInputRef.current?.focus());
      });
  }, [client, connectionId, enqueueHistoryMutation, reportHistoryError]);

  useEffect(() => {
    let cancelled = false;
    setLocalHistory([]);
    setHistoryLoading(true);
    setHistoryError("");
    setHistoryPendingCommands(new Set());
    setHistoryCandidateNotice("");
    const loadRequest = client.terminal.history.list(connectionId);
    historyMutationQueueRef.current = loadRequest.catch(() => undefined);
    void loadRequest
      .then((commands) => {
        if (cancelled) return;
        setLocalHistory(commands);
        setHistoryLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setHistoryLoading(false);
        reportHistoryError(error);
      });
    return () => { cancelled = true; };
  }, [client, connectionId, reportHistoryError]);

  useEffect(() => {
    if (!commandSearchOpen || selectedSearchIndex < 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`${commandSearchId}-option-${selectedSearchIndex}`)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [commandSearchId, commandSearchOpen, selectedSearchIndex]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      closeInlineCompletion();
      closeCommandSearch({ returnFocus: false });
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (focusTerminalOnActivate) terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, closeCommandSearch, closeInlineCompletion, focusTerminalOnActivate]);

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
        toggleCommandSearch();
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
        open: inlineCompletionOpenRef.current,
        reliable: terminalInputRef.current.reliable,
        suggestionCount: currentSuggestions.length,
      });
      if (keyAction === "close") {
        closeInlineCompletion();
        return false;
      }
      if (keyAction === "execute") {
        closeInlineCompletion();
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
      if (inlineCompletionOpenRef.current && event.key === "Tab") closeInlineCompletion();
      return true;
    });

    let attaching = true;
    const pendingData = [];
    const unsubscribe = client.events.onTerminalData((event) => {
      if (event?.sessionId !== sessionId || disposed) return;
      if (attaching) pendingData.push(event.data);
      else terminal.write(event.data, () => {
        if (inlineCompletionOpenRef.current) updateInlineAnchor();
      });
    });
    const inputSubscription = terminal.onData((data) => {
      const executedCommands = collectExecutedTerminalCommands(terminalInputRef.current, data);
      trackTerminalInput(data);
      void enqueueTerminalWrite(data)
        .then(() => recordExecutedCommands(executedCommands))
        .catch((error) => onError?.(error, connectionId));
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (!activeRef.current) return;
      void client.terminal.resize(sessionId, { cols, rows }).catch((error) => onError?.(error, connectionId));
    });
    const scrollSubscription = terminal.onScroll(() => {
      if (inlineCompletionOpenRef.current) updateInlineAnchor();
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) return;
      fit.fit();
      if (inlineCompletionOpenRef.current) updateInlineAnchor();
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
      scrollSubscription.dispose();
      resizeSubscription.dispose();
      inputSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [client, closeInlineCompletion, connectionId, enqueueTerminalWrite, insertCompletion, onError, recordExecutedCommands, sessionId, toggleCommandSearch, trackTerminalInput, updateInlineAnchor]);

  return (
    <>
      <div ref={containerRef} className="native-xterm" role="region" aria-label="SSH 交互终端" />
      <button
        type="button"
        className="native-completion-trigger"
        aria-expanded={commandSearchOpen}
        aria-controls={commandSearchId}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+Shift+P Control+Space"
        aria-label={`${commandSearchOpen ? "关闭" : "打开"}命令搜索，快捷键 Ctrl+Shift+P，兼容 Ctrl+Space`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleCommandSearch}
      >
        <MagnifyingGlass size={15} /> 命令搜索{completionLoading || historyLoading ? "（加载中）" : completionError || historyError ? "（部分可用）" : ""} <kbd>Ctrl+Shift+P</kbd>
      </button>
      {commandSearchOpen && active && (
        <section id={commandSearchId} className="native-command-search" role="dialog" aria-label="命令搜索">
          <header>
            <label className="native-command-search__field">
              <MagnifyingGlass size={17} aria-hidden="true" />
              <input
                ref={commandSearchInputRef}
                type="search"
                role="combobox"
                aria-label="搜索命令或用途"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls={`${commandSearchId}-options`}
                aria-activedescendant={selectedSearchOptionId}
                placeholder="搜索命令或用途，例如 ls / 查看文件 / memory"
                value={commandSearchQuery}
                onChange={(event) => {
                  setCommandSearchQuery(event.target.value);
                  setCommandSearchIndex(0);
                }}
                onKeyDown={(event) => {
                  if (isImeCompositionKeyEvent(event)) return;
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeCommandSearch();
                    return;
                  }
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    const nextIndex = nextCommandCompletionIndex(selectedSearchIndex, event.key, commandSearchResults.length);
                    if (nextIndex !== null) setCommandSearchIndex(nextIndex);
                    return;
                  }
                  if (event.key === "Enter" && selectedSearchIndex >= 0) {
                    event.preventDefault();
                    insertCompletion(commandSearchResults[selectedSearchIndex].command);
                  }
                }}
              />
            </label>
            <button type="button" aria-label="关闭命令搜索" onClick={() => closeCommandSearch()}><X size={17} /></button>
          </header>
          <div id={`${commandSearchId}-options`} className="native-command-search__options" role="listbox" aria-label="命令搜索结果">
            {commandSearchResults.length ? commandSearchResults.map((item, index) => (
              <CompletionOption
                key={item.command}
                id={`${commandSearchId}-option-${index}`}
                item={item}
                selected={selectedSearchIndex === index}
                onHover={() => setCommandSearchIndex(index)}
                onChoose={() => insertCompletion(item.command)}
                onRemove={item.source === "history" ? () => removeHistoryCandidate(item) : undefined}
                removePending={historyPendingCommands.has(item.command)}
              />
            )) : <div className="native-completion-empty">没有找到匹配的命令或用途</div>}
          </div>
          <footer>
            {historyCandidateNotice && <span className="native-command-search__notice" role="status">{historyCandidateNotice}</span>}
            <span>
              {completionLoading && "正在加载远端可执行命令；内置语义、当前目录和本机历史候选已可用。 "}
              {historyLoading && "正在加载本机为此服务器保存的命令历史。 "}
              {completionError && `远端命令加载失败：${completionError}；其他本机候选仍可用。 `}
              {historyError && `本机命令历史操作失败：${historyError} `}
              支持中文用途和英文命令/意图搜索 · ↑/↓ 选择 · Enter 插入 · Esc 关闭
            </span>
          </footer>
        </section>
      )}
      {inlineCompletionOpen && active && !commandSearchOpen && terminalInput.reliable && inlineSuggestions.length > 0 && (
        <div
          id={inlineCompletionId}
          className="native-inline-completions"
          role="listbox"
          aria-label={`匹配当前输入 ${terminalInput.text} 的命令候选`}
          aria-activedescendant={selectedInlineOptionId}
          data-placement={inlineAnchor.placement}
          style={{
            "--inline-completion-left": `${inlineAnchor.left}px`,
            "--inline-completion-top": `${inlineAnchor.top}px`,
          }}
        >
          {inlineSuggestions.map((item, index) => (
            <CompletionOption
              compact
              key={item.command}
              id={`${inlineCompletionId}-option-${index}`}
              item={item}
              selected={selectedSuggestionIndex === index}
              onHover={() => {
                suggestionIndexRef.current = index;
                setSuggestionIndex(index);
              }}
              onChoose={() => insertCompletion(item.command)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CompletionOption({ id, item, selected, compact = false, onHover, onChoose, onRemove, removePending = false }) {
  const CandidateIcon = item.source === "history" ? ClockCounterClockwise : TerminalIcon;
  const option = (
    <button
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      className={`native-completion-option ${item.description ? "has-description" : ""} ${compact ? "is-compact" : ""} ${selected ? "is-selected" : ""}`.trim()}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onHover}
      onClick={onChoose}
    >
      <CandidateIcon size={16} aria-hidden="true" />
      <code>{item.command}</code>
      {item.description && <span>{item.description}</span>}
      {!compact && <small>{item.sourceLabel || item.group}</small>}
    </button>
  );
  if (!onRemove || compact) return option;
  return (
    <div className={`native-completion-row ${selected ? "is-selected" : ""}`} role="presentation">
      {option}
      <button
        type="button"
        className="native-completion-option__remove"
        aria-label={`从本机为此服务器保存的命令历史中永久删除 ${item.command}`}
        title="从本机命令历史永久删除；不会删除远端可执行命令"
        disabled={removePending}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={onHover}
        onClick={onRemove}
      >
        <Trash size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
