import { useEffect, useRef } from "react";
import {
  ArrowsClockwise,
  CircleNotch,
  CloudArrowDown,
  FolderOpen,
  PencilSimple,
  Trash,
} from "@phosphor-icons/react";

export function RemoteFileContextMenu({
  request,
  downloading = false,
  onClose,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onRefresh,
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!request) return undefined;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request]);

  if (!request) return null;
  const parentEntry = request.key.startsWith("parent:");
  const fileEntry = request.entry.type === "file";
  const removable = !parentEntry && ["file", "directory", "symlink"].includes(request.entry.type);

  function moveFocus(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...menuRef.current.querySelectorAll("button:not(:disabled)")];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (Math.max(current, 0) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  return (
    <div
      ref={menuRef}
      className="remote-file-context-menu"
      role="menu"
      aria-label={`${request.entry.name} 的远程文件操作`}
      style={{ left: request.x, top: request.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        moveFocus(event);
      }}
    >
      <div className="remote-file-context-menu__title" title={request.entry.name}>{request.entry.name}</div>
      {onOpen && (
        <button type="button" role="menuitem" onClick={() => { onClose(); onOpen(); }}>
          <FolderOpen size={16} />
          <span>{parentEntry ? "返回上级目录" : "打开目录"}</span>
        </button>
      )}
      {fileEntry && (
        <button
          type="button"
          role="menuitem"
          disabled={downloading}
          onClick={() => { onClose(); onDownload(); }}
        >
          {downloading ? <CircleNotch size={16} className="is-spinning" /> : <CloudArrowDown size={16} />}
          <span>{downloading ? "正在下载…" : "下载到…"}</span>
        </button>
      )}
      {removable && (
        <>
          <div className="remote-file-context-menu__separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => { onClose(); onRename(); }}>
            <PencilSimple size={16} />
            <span>重命名或移动…</span>
          </button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { onClose(); onDelete(); }}>
            <Trash size={16} />
            <span>删除…</span>
          </button>
        </>
      )}
      <div className="remote-file-context-menu__separator" role="separator" />
      <button type="button" role="menuitem" onClick={() => { onClose(); onRefresh(); }}>
        <ArrowsClockwise size={16} />
        <span>刷新</span>
      </button>
    </div>
  );
}
