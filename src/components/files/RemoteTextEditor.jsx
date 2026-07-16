import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretUp,
  Eye,
  FloppyDisk,
  MagnifyingGlass,
  PencilSimple,
} from "@phosphor-icons/react";
import { IconButton } from "../shared/IconButton.jsx";
import { findTextMatches } from "../../lib/text-search.js";

const LIVE_REFRESH_INTERVAL = 1_000;
const EDITOR_MEMORY_LIMIT = 2 * 1024 * 1024;

function isLogFile(path) {
  return path.toLocaleLowerCase().endsWith(".log");
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function mergeLiveContent(current, chunk) {
  const next = chunk.reset ? chunk.content : `${current}${chunk.content}`;
  return next.length > EDITOR_MEMORY_LIMIT ? next.slice(-EDITOR_MEMORY_LIMIT) : next;
}

export function RemoteTextEditor({ active = false, client, document, appearance, onDirtyChange, onSaved, onError }) {
  const textareaRef = useRef(null);
  const searchRef = useRef(null);
  const inFlightRef = useRef(false);
  const revisionRef = useRef(null);
  const followTailRef = useRef(true);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);
  const reportedErrorRef = useRef("");
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [revision, setRevision] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regularExpression, setRegularExpression] = useState(false);
  const [live, setLive] = useState(() => isLogFile(document.path));
  const [editing, setEditing] = useState(false);
  const dirty = content !== baseline;
  onDirtyChangeRef.current = onDirtyChange;
  onSavedRef.current = onSaved;
  onErrorRef.current = onError;

  function reportError(nextError, fallbackMessage) {
    const message = nextError?.message || fallbackMessage;
    setError(message);
    if (reportedErrorRef.current !== message) {
      reportedErrorRef.current = message;
      onErrorRef.current?.(nextError);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setContent("");
    setBaseline("");
    setRevision(null);
    revisionRef.current = null;
    followTailRef.current = true;
    const nextLive = isLogFile(document.path);
    setLive(nextLive);
    setEditing(false);
    void client.sftp.readText(document.sessionId, document.path, null)
      .then((chunk) => {
        if (cancelled) return;
        const nextRevision = {
          size: chunk.size,
          modifiedAt: chunk.modifiedAt || null,
          nextOffset: chunk.nextOffset,
          truncated: chunk.truncated,
          encodingLossy: chunk.encodingLossy,
          editable: chunk.editable,
        };
        revisionRef.current = nextRevision;
        reportedErrorRef.current = "";
        setContent(chunk.content);
        setBaseline(chunk.content);
        setRevision(nextRevision);
        setEditing(!nextLive && chunk.editable);
      })
      .catch((nextError) => {
        if (cancelled) return;
        reportError(nextError, "无法读取远程文本文件。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, document.path, document.sessionId]);

  useEffect(() => {
    if (!active || !live || loading || !revisionRef.current) return undefined;
    let disposed = false;
    const refresh = async () => {
      if (disposed || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const currentRevision = revisionRef.current;
        const chunk = await client.sftp.readText(
          document.sessionId,
          document.path,
          currentRevision?.nextOffset ?? null,
        );
        if (disposed) return;
        setContent((current) => mergeLiveContent(current, chunk));
        const nextRevision = {
          size: chunk.size,
          modifiedAt: chunk.modifiedAt || null,
          nextOffset: chunk.nextOffset,
          truncated: chunk.truncated || currentRevision?.truncated,
          encodingLossy: chunk.encodingLossy || currentRevision?.encodingLossy,
          editable: chunk.editable && !chunk.reset,
        };
        revisionRef.current = nextRevision;
        setRevision(nextRevision);
        setBaseline((current) => mergeLiveContent(current, chunk));
        reportedErrorRef.current = "";
        setError("");
      } catch (nextError) {
        if (disposed) return;
        reportError(nextError, "实时刷新远程日志失败。");
      } finally {
        inFlightRef.current = false;
      }
    };
    const interval = window.setInterval(() => { void refresh(); }, LIVE_REFRESH_INTERVAL);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [active, client, document.path, document.sessionId, live, loading]);

  useEffect(() => {
    onDirtyChangeRef.current?.(document.key, dirty);
  }, [dirty, document.key]);

  useEffect(() => {
    if (!live || !followTailRef.current) return;
    const textarea = textareaRef.current;
    if (textarea) textarea.scrollTop = textarea.scrollHeight;
  }, [content, live]);

  const searchResult = useMemo(() => findTextMatches(content, query, {
    caseSensitive,
    wholeWord,
    regularExpression,
  }), [caseSensitive, content, query, regularExpression, wholeWord]);

  function find(direction) {
    const textarea = textareaRef.current;
    if (!textarea || !query || !searchResult.matches.length) return;
    const match = direction > 0
      ? searchResult.matches.find((item) => item.index >= textarea.selectionEnd) || searchResult.matches[0]
      : [...searchResult.matches].reverse().find((item) => item.index < textarea.selectionStart) || searchResult.matches.at(-1);
    const index = match.index;
    textarea.focus();
    textarea.setSelectionRange(index, index + match.length);
    const line = content.slice(0, index).split("\n").length;
    textarea.scrollTop = Math.max(0, (line - 3) * 20);
  }

  async function refreshNow() {
    if (loading || saving) return;
    setLoading(true);
    setError("");
    try {
      const chunk = await client.sftp.readText(document.sessionId, document.path, null);
      const nextRevision = {
        size: chunk.size,
        modifiedAt: chunk.modifiedAt || null,
        nextOffset: chunk.nextOffset,
        truncated: chunk.truncated,
        encodingLossy: chunk.encodingLossy,
        editable: chunk.editable,
      };
      revisionRef.current = nextRevision;
      reportedErrorRef.current = "";
      setRevision(nextRevision);
      setContent(chunk.content);
      setBaseline(chunk.content);
      setEditing((current) => current && chunk.editable && !live);
      followTailRef.current = true;
    } catch (nextError) {
      reportError(nextError, "无法刷新远程文本文件。");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!editing || !revision?.editable || !dirty || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await client.sftp.writeText(document.sessionId, document.path, content, revision);
      const nextRevision = {
        ...revision,
        size: result.size,
        modifiedAt: result.modifiedAt || null,
        nextOffset: result.size,
      };
      revisionRef.current = nextRevision;
      setRevision(nextRevision);
      setBaseline(content);
      onSavedRef.current?.();
    } catch (nextError) {
      reportError(nextError, "无法保存远程文本文件。");
    } finally {
      setSaving(false);
    }
  }

  const canEdit = Boolean(revision?.editable && !revision?.truncated && !revision?.encodingLossy);

  return (
    <section
      className="remote-text-editor"
      id={`document-panel-${document.key}`}
      hidden={!active}
      aria-label={`远程文本编辑器：${document.name}`}
      style={{
        "--terminal-background": appearance?.terminalBackground,
        "--terminal-foreground": appearance?.terminalForeground,
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key.toLocaleLowerCase() === "f") {
          event.preventDefault();
          searchRef.current?.focus();
        }
        if (event.ctrlKey && event.key.toLocaleLowerCase() === "s") {
          event.preventDefault();
          void save();
        }
      }}
    >
      <div className="remote-text-editor__toolbar">
        <label className="remote-text-editor__search">
          <MagnifyingGlass size={16} />
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索（Ctrl+F）"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                find(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span>{query ? searchResult.error || `${searchResult.matches.length} 处` : ""}</span>
        </label>
        <span className="remote-text-editor__search-options" role="group" aria-label="搜索匹配方式">
          <button type="button" aria-label="区分大小写" title="区分大小写" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
          <button type="button" aria-label="全字匹配" title="全字匹配" aria-pressed={wholeWord} onClick={() => setWholeWord((value) => !value)}>全字</button>
          <button type="button" aria-label="使用正则表达式" title="使用正则表达式" aria-pressed={regularExpression} onClick={() => setRegularExpression((value) => !value)}>.*</button>
        </span>
        <IconButton label="上一个匹配项" disabled={!query || !searchResult.matches.length} onClick={() => find(-1)}><CaretUp size={17} /></IconButton>
        <IconButton label="下一个匹配项" disabled={!query || !searchResult.matches.length} onClick={() => find(1)}><CaretDown size={17} /></IconButton>
        <span className="remote-text-editor__toolbar-spacer" />
        {isLogFile(document.path) && (
          <button
            type="button"
            className={`remote-text-editor__mode ${live ? "is-active" : ""}`}
            aria-pressed={live}
            onClick={() => {
              if (!live && dirty) return;
              setLive((current) => !current);
              setEditing(false);
              followTailRef.current = true;
            }}
          >
            <Eye size={16} /> {live ? "实时跟随 · 1 秒" : "开启实时跟随"}
          </button>
        )}
        {!editing && canEdit && !live && (
          <button type="button" className="remote-text-editor__mode" onClick={() => setEditing(true)}>
            <PencilSimple size={16} /> 编辑
          </button>
        )}
        <IconButton label="刷新文件" disabled={loading || dirty} onClick={() => void refreshNow()}><ArrowsClockwise size={18} /></IconButton>
        <button type="button" className="remote-text-editor__save" disabled={!editing || !dirty || saving} onClick={() => void save()}>
          <FloppyDisk size={16} /> {saving ? "保存中…" : "保存"}
        </button>
      </div>
      <div className="remote-text-editor__path" title={document.path}>{document.path}</div>
      <div className="remote-text-editor__body">
        {error && <div className="remote-text-editor__error" role="alert">{error}</div>}
        <textarea
          ref={textareaRef}
          className="remote-text-editor__content"
          aria-label={`${document.name} 内容`}
          value={content}
          readOnly={!editing}
          spellCheck={false}
          onChange={(event) => setContent(event.target.value)}
          onScroll={(event) => {
            const target = event.currentTarget;
            followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32;
          }}
        />
      </div>
      <footer className="remote-text-editor__status">
        <span>{loading ? "正在读取…" : editing ? "编辑模式" : live ? "实时只读" : "只读预览"}</span>
        <span>{revision?.truncated ? "仅显示文件尾部 · " : ""}{revision?.encodingLossy ? "部分字符无法按 UTF-8 解码 · " : ""}{formatBytes(revision?.size)}</span>
      </footer>
    </section>
  );
}
