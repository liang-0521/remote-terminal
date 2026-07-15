import { useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretRight,
  CircleNotch,
  CloudArrowUp,
  FileText,
  Folder,
  HardDrives,
  Link,
  Plus,
} from "@phosphor-icons/react";
import { IconButton } from "../shared/IconButton.jsx";
import { RemoteDeleteDialog } from "./RemoteDeleteDialog.jsx";
import { RemoteFileContextMenu } from "./RemoteFileContextMenu.jsx";
import { RemoteRenameDialog } from "./RemoteRenameDialog.jsx";

export function ExplorerPanel({ mode, server, servers, activeServerId, fileState, onUpload, onSelectUploadFiles, onNativeDragDropSubscribe, onDownloadRemoteFile, onRenameRemoteEntry, onDeleteRemoteEntry, onRefresh, onNavigate, onOpenBottomTab, onCreateSession, onSelectServer, onOpenConnections }) {
  if (mode === "connections") {
    return <ConnectionsPanel servers={servers} activeServerId={activeServerId} onSelectServer={onSelectServer} onOpenConnections={onOpenConnections} />;
  }
  if (mode !== "files") {
    return <ContextPanel mode={mode} server={server} onOpenBottomTab={onOpenBottomTab} onCreateSession={onCreateSession} />;
  }

  return <RemoteFiles fileState={fileState} onUpload={onUpload} onSelectUploadFiles={onSelectUploadFiles} onNativeDragDropSubscribe={onNativeDragDropSubscribe} onDownloadRemoteFile={onDownloadRemoteFile} onRenameRemoteEntry={onRenameRemoteEntry} onDeleteRemoteEntry={onDeleteRemoteEntry} onRefresh={onRefresh} onNavigate={onNavigate} />;
}

function RemoteFiles({ fileState, onUpload, onSelectUploadFiles, onNativeDragDropSubscribe, onDownloadRemoteFile, onRenameRemoteEntry, onDeleteRemoteEntry, onRefresh, onNavigate }) {
  const shellRef = useRef(null);
  const uploadRef = useRef(onUpload);
  const fileRowRefs = useRef([]);
  const downloadRequestRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [downloadState, setDownloadState] = useState({ key: "", phase: "idle", message: "" });
  const [contextMenu, setContextMenu] = useState(null);
  const [deleteRequest, setDeleteRequest] = useState(null);
  const [renameRequest, setRenameRequest] = useState(null);
  const [focusedFileRow, setFocusedFileRow] = useState(0);
  uploadRef.current = onUpload;

  useEffect(() => () => {
    downloadRequestRef.current += 1;
  }, []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeForOutsideInteraction = (event) => {
      if (event.type === "pointerdown" && event.target.closest?.(".remote-file-context-menu")) return;
      setContextMenu(null);
    };
    window.addEventListener("pointerdown", closeForOutsideInteraction, true);
    window.addEventListener("blur", closeForOutsideInteraction);
    window.addEventListener("resize", closeForOutsideInteraction);
    return () => {
      window.removeEventListener("pointerdown", closeForOutsideInteraction, true);
      window.removeEventListener("blur", closeForOutsideInteraction);
      window.removeEventListener("resize", closeForOutsideInteraction);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (typeof onNativeDragDropSubscribe !== "function") return undefined;
    const unsubscribe = onNativeDragDropSubscribe((event) => {
      const shell = shellRef.current;
      if (!shell) return;
      if (event?.type === "leave") {
        setDragging(false);
        return;
      }
      const physicalX = Number(event?.position?.x);
      const physicalY = Number(event?.position?.y);
      const scale = window.devicePixelRatio || 1;
      const x = physicalX / scale;
      const y = physicalY / scale;
      const rect = shell.getBoundingClientRect();
      const inside = Number.isFinite(x) && Number.isFinite(y)
        && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      if (["enter", "over"].includes(event?.type)) {
        setDragging(inside);
        return;
      }
      if (event?.type === "drop") {
        setDragging(false);
        if (inside && Array.isArray(event.paths) && event.paths.length) {
          uploadRef.current?.(event.paths.map((localPath) => ({ localPath })));
        }
      }
    });
    return unsubscribe;
  }, [onNativeDragDropSubscribe]);

  const currentPath = fileState?.path;
  const isRefreshing = Boolean(fileState?.loading);
  const parentPath = currentPath && currentPath !== "/"
    ? currentPath.slice(0, currentPath.lastIndexOf("/")) || "/"
    : null;
  const liveStatus = isRefreshing
    ? "正在刷新远程文件"
    : fileState?.error
      ? ""
      : currentPath
        ? `已显示远程路径 ${currentPath}`
        : "SFTP 不可用";
  const rows = [
    ...(parentPath ? [{
      key: "parent:..",
      entry: { name: "..", type: "directory", size: 0 },
      onOpen: () => onNavigate?.(parentPath),
    }] : []),
    ...(fileState?.entries || []).map((entry) => ({
      key: `${entry.type}:${entry.name}`,
      entry,
      remotePath: `${currentPath === "/" ? "" : currentPath}/${entry.name}`,
      onOpen: entry.type === "directory"
        ? () => onNavigate?.(`${currentPath === "/" ? "" : currentPath}/${entry.name}`)
        : undefined,
    })),
  ];

  useEffect(() => {
    setFocusedFileRow((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    downloadRequestRef.current += 1;
    setDownloadState({ key: "", phase: "idle", message: "" });
    setContextMenu(null);
    setDeleteRequest(null);
    setRenameRequest(null);
  }, [currentPath]);

  async function downloadRemoteFile(key, entry, remotePath) {
    if (entry.type !== "file" || downloadState.phase === "downloading") return;
    const requestId = downloadRequestRef.current + 1;
    downloadRequestRef.current = requestId;
    setDownloadState({ key, phase: "downloading", message: `正在下载 ${entry.name}…` });
    try {
      const result = await onDownloadRemoteFile?.(remotePath);
      if (downloadRequestRef.current !== requestId) return;
      setDownloadState({
        key,
        phase: result ? "done" : "cancelled",
        message: result ? `${entry.name} 已下载到所选位置。` : `已取消下载 ${entry.name}。`,
      });
    } catch (error) {
      if (downloadRequestRef.current !== requestId) return;
      setDownloadState({ key, phase: "error", message: error?.message || `无法下载 ${entry.name}。` });
    }
  }

  function openContextMenu(event, request) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const requestedX = event.clientX > 0 ? event.clientX : rect.left + 28;
    const requestedY = event.clientY > 0 ? event.clientY : rect.top + 24;
    setContextMenu({
      ...request,
      x: Math.max(8, Math.min(requestedX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(requestedY, window.innerHeight - 276)),
    });
  }

  async function confirmRemoteDelete(request) {
    await onDeleteRemoteEntry?.(request.remotePath, request.entry.type);
    setDeleteRequest(null);
    onRefresh?.();
  }

  async function confirmRemoteRename(request) {
    await onRenameRemoteEntry?.(request.remotePath, request.targetPath, request.entry.type);
    setRenameRequest(null);
    onRefresh?.();
  }

  function moveFileRowFocus(event, currentIndex) {
    if (!rows.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    setFocusedFileRow(nextIndex);
    window.requestAnimationFrame(() => fileRowRefs.current[nextIndex]?.focus());
  }

  return (
    <aside className="explorer-panel" aria-label="远程文件">
      <div className="panel-title-row">
        <h2>资源管理器</h2>
      </div>
      <div className="section-heading">
        <h3>远程文件</h3>
        <span>
          <IconButton label="刷新远程文件" onClick={onRefresh} className={isRefreshing ? "is-spinning" : ""}>
            <ArrowsClockwise size={19} />
          </IconButton>
          <IconButton
            label="选择文件上传"
            onClick={() => void onSelectUploadFiles?.()}
          >
            <CloudArrowUp size={19} />
          </IconButton>
        </span>
      </div>
      <div className="path-select" aria-label={`当前远程路径：${currentPath || "SFTP 不可用"}`}>
        <span>{currentPath || "SFTP 不可用"}</span>
      </div>

      <div
        ref={shellRef}
        className={`file-tree-shell ${dragging ? "is-dragging" : ""}`}
      >
        <div
          className={`file-tree ${isRefreshing ? "is-refreshing" : ""}`}
          role="tree"
          aria-label="远程文件列表，可拖放上传"
          aria-busy={isRefreshing}
        >
          {fileState?.error && <div className="file-tree__message is-error" role="alert">{fileState.error}</div>}
          {!fileState?.error && !fileState?.loading && fileState?.entries?.length === 0 && <div className="file-tree__message">此目录为空</div>}
          {rows.map(({ key, entry, remotePath, onOpen }, index) => (
            <NativeFileRow
              key={key}
              entry={entry}
              onOpen={onOpen}
              rowRef={(element) => { fileRowRefs.current[index] = element; }}
              tabIndex={focusedFileRow === index ? 0 : -1}
              onFocus={() => setFocusedFileRow(index)}
              onMove={(event) => moveFileRowFocus(event, index)}
              onContextMenu={(event) => openContextMenu(event, { key, entry, remotePath, onOpen })}
            />
          ))}
        </div>
        {dragging && (
          <div className="file-tree__drop-overlay" role="status">
            <CloudArrowUp size={38} weight="duotone" />
            <strong>释放文件开始上传</strong>
            <span>{currentPath}</span>
          </div>
        )}
      </div>
      {downloadState.message && (
        <div className={`file-tree__download-status is-${downloadState.phase}`} role="status">
          {downloadState.phase === "downloading" && <CircleNotch size={14} className="is-spinning" />}
          <span>{downloadState.message}</span>
        </div>
      )}
      <span className="file-tree__status" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</span>
      <RemoteFileContextMenu
        request={contextMenu}
        downloading={downloadState.phase === "downloading"}
        onClose={() => setContextMenu(null)}
        onOpen={contextMenu?.onOpen}
        onDownload={() => contextMenu && void downloadRemoteFile(contextMenu.key, contextMenu.entry, contextMenu.remotePath)}
        onRename={() => contextMenu && setRenameRequest(contextMenu)}
        onDelete={() => contextMenu && setDeleteRequest(contextMenu)}
        onRefresh={onRefresh}
      />
      <RemoteDeleteDialog
        request={deleteRequest}
        onCancel={() => setDeleteRequest(null)}
        onConfirm={confirmRemoteDelete}
      />
      <RemoteRenameDialog
        request={renameRequest}
        onCancel={() => setRenameRequest(null)}
        onConfirm={confirmRemoteRename}
      />
    </aside>
  );
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex > 1 ? 1 : 0)} ${units[unitIndex]}`;
}

function NativeFileRow({ entry, onOpen, rowRef, tabIndex, onFocus, onMove, onContextMenu }) {
  const Icon = entry.type === "directory" ? Folder : entry.type === "symlink" ? Link : FileText;
  const parentEntry = entry.name === "..";
  const content = (
    <>
      {entry.type === "directory" ? <CaretRight size={14} /> : <span className="tree-spacer" />}
      <Icon size={18} weight={entry.type === "directory" ? "fill" : "regular"} />
      <span className="native-file-row__name" title={entry.name}>{entry.name}</span>
      <small>{entry.type === "file" ? formatFileSize(entry.size) : ""}</small>
    </>
  );
  return (
    <div
      ref={rowRef}
      className={`tree-row native-file-row ${onOpen ? "" : "is-static"}`}
      role="treeitem"
      tabIndex={tabIndex}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      onClick={parentEntry ? onOpen : undefined}
      onKeyDown={(event) => {
        onMove(event);
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          onContextMenu(event);
          return;
        }
        if (!["Enter", " "].includes(event.key)) return;
        if (!event.defaultPrevented) event.preventDefault();
        onOpen?.();
      }}
      onDoubleClick={parentEntry ? undefined : onOpen}
    >
      {content}
    </div>
  );
}

function ConnectionsPanel({ servers, activeServerId, onSelectServer, onOpenConnections }) {
  return (
    <aside className="explorer-panel connections-panel" aria-label="服务器连接">
      <div className="panel-title-row">
        <h2>服务器连接</h2>
        <IconButton label="新增服务器" onClick={() => onOpenConnections("new")}><Plus size={20} /></IconButton>
      </div>
      <div className="section-heading">
        <h3>已保存连接</h3>
        <span>{servers.length}</span>
      </div>
      <div className="connection-list">
        {servers.map((item) => (
          <button key={item.id} type="button" className={activeServerId === item.id ? "is-active" : ""} onClick={() => onSelectServer(item.id)}>
            <HardDrives size={20} weight={activeServerId === item.id ? "duotone" : "regular"} />
            <span>
              <strong>{item.name}</strong>
              <small>{item.endpoint}</small>
            </span>
            <i className={`status-dot status-dot--${item.state}`} />
          </button>
        ))}
      </div>
      <button type="button" className="connection-list__add" onClick={() => onOpenConnections("list")}>
        <HardDrives size={19} /> 管理连接与密码
      </button>
    </aside>
  );
}

function ContextPanel({ mode, server, onOpenBottomTab, onCreateSession }) {
  const copy = {
    sessions: ["终端会话", "管理此服务器上的终端标签"],
    transfers: ["传输任务", "查看上传进度、失败与重试"],
    monitor: ["性能监控", "查看当前采样状态与实时指标"],
  }[mode];
  const targetTab = mode === "monitor" ? "monitor" : "transfer";
  const isSessionMode = mode === "sessions";

  return (
    <aside className="explorer-panel context-panel">
      <div className="panel-title-row"><h2>{copy[0]}</h2></div>
      <HardDrives size={34} weight="duotone" />
      <strong>{server.name}</strong>
      <span>{server.endpoint}</span>
      <p>{copy[1]}</p>
      <button type="button" className="secondary-button" onClick={isSessionMode ? onCreateSession : () => onOpenBottomTab(targetTab)}>
        {isSessionMode ? "打开服务器工作区" : "打开底部面板"}
      </button>
    </aside>
  );
}
