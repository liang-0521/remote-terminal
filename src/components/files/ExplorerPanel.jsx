import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CircleNotch,
  CloudArrowUp,
  ChartLine,
  FileText,
  Files,
  Folder,
  HardDrives,
  Link,
  Plus,
} from "@phosphor-icons/react";
import { IconButton } from "../shared/IconButton.jsx";
import { MonitorDashboard } from "../monitoring/MonitorDashboard.jsx";
import { MonitorErrorBoundary } from "../monitoring/MonitorErrorBoundary.js";
import { RemoteDeleteDialog } from "./RemoteDeleteDialog.jsx";
import { RemoteCreateDialog } from "./RemoteCreateDialog.jsx";
import { RemoteFileContextMenu } from "./RemoteFileContextMenu.jsx";
import { RemoteRenameDialog } from "./RemoteRenameDialog.jsx";
import {
  isRemoteFileRequestCurrent,
  STALE_REMOTE_FILE_REQUEST_CODE,
} from "../../services/workspace-session.js";

export function ExplorerPanel({ mode, layout = "left", collapsed = false, embedded = false, server, servers, activeServerId, fileState, metrics, sampledAt, monitorLoading = false, monitorError = "", monitorIntervalSeconds = 1, onMonitorIntervalChange, onUpload, onSelectUploadFiles, onNativeDragDropSubscribe, onDownloadRemoteFile, onRenameRemoteEntry, onDeleteRemoteEntry, onCreateRemoteEntry, onOpenTextFile, onRefresh, onNavigate, onListDirectory, onPlacementChange, onToggleCollapsed, onSelectServer, onOpenConnections }) {
  if (mode === "connections") {
    return <ConnectionsPanel servers={servers} activeServerId={activeServerId} onSelectServer={onSelectServer} onOpenConnections={onOpenConnections} />;
  }
  if (!server && mode === "files") {
    return <FeatureUnavailablePanel mode="files" onOpenConnections={onOpenConnections} />;
  }
  if (!server && mode === "monitor") {
    return <FeatureUnavailablePanel mode="monitor" onOpenConnections={onOpenConnections} />;
  }
  if (mode === "monitor") {
    return <MonitorPanel server={server} metrics={metrics} sampledAt={sampledAt} loading={monitorLoading} error={monitorError} intervalSeconds={monitorIntervalSeconds} onIntervalChange={onMonitorIntervalChange} />;
  }

  return <RemoteFiles treeKey={activeServerId} layout={layout} collapsed={collapsed} embedded={embedded} fileState={fileState} onUpload={onUpload} onSelectUploadFiles={onSelectUploadFiles} onNativeDragDropSubscribe={onNativeDragDropSubscribe} onDownloadRemoteFile={onDownloadRemoteFile} onRenameRemoteEntry={onRenameRemoteEntry} onDeleteRemoteEntry={onDeleteRemoteEntry} onCreateRemoteEntry={onCreateRemoteEntry} onOpenTextFile={onOpenTextFile} onRefresh={onRefresh} onNavigate={onNavigate} onListDirectory={onListDirectory} onPlacementChange={onPlacementChange} onToggleCollapsed={onToggleCollapsed} />;
}

function FeatureUnavailablePanel({ mode, onOpenConnections }) {
  const filesMode = mode === "files";
  return (
    <aside className="explorer-panel feature-unavailable-panel" aria-label={filesMode ? "资源管理器" : "性能监控"}>
      <div className="panel-title-row"><h2>{filesMode ? "资源管理器" : "性能监控"}</h2></div>
      <div className="feature-unavailable-panel__content" role="status">
        {filesMode ? <Files size={34} weight="duotone" /> : <ChartLine size={34} weight="duotone" />}
        <strong>尚未打开服务器</strong>
        <span>{filesMode ? "连接服务器后可浏览和编辑远程文件。" : "连接服务器后可查看实时性能数据。"}</span>
        <button type="button" className="primary-button" onClick={() => onOpenConnections?.("list")}>
          <HardDrives size={17} /> 打开服务器
        </button>
      </div>
    </aside>
  );
}

function RemoteFiles({ treeKey, layout, collapsed, embedded, fileState, onUpload, onSelectUploadFiles, onNativeDragDropSubscribe, onDownloadRemoteFile, onRenameRemoteEntry, onDeleteRemoteEntry, onCreateRemoteEntry, onOpenTextFile, onRefresh, onNavigate, onListDirectory, onPlacementChange, onToggleCollapsed }) {
  const shellRef = useRef(null);
  const uploadRef = useRef(onUpload);
  const fileRowRefs = useRef([]);
  const downloadRequestRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [downloadState, setDownloadState] = useState({ key: "", phase: "idle", message: "", progress: null });
  const [contextMenu, setContextMenu] = useState(null);
  const [deleteRequest, setDeleteRequest] = useState(null);
  const [renameRequest, setRenameRequest] = useState(null);
  const [createRequest, setCreateRequest] = useState(null);
  const [focusedFileRow, setFocusedFileRow] = useState(0);
  const [pathDraft, setPathDraft] = useState(fileState?.path || "");
  const available = Boolean(fileState?.available);
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
    if (!available || typeof onNativeDragDropSubscribe !== "function") return undefined;
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
  }, [available, onNativeDragDropSubscribe]);

  useEffect(() => {
    if (available) return;
    setDragging(false);
    setContextMenu(null);
    setDeleteRequest(null);
    setRenameRequest(null);
    setCreateRequest(null);
  }, [available]);

  const currentPath = fileState?.path;
  const isRefreshing = available && Boolean(fileState?.loading);
  const parentPath = currentPath && currentPath !== "/"
    ? currentPath.slice(0, currentPath.lastIndexOf("/")) || "/"
    : null;
  const hasSnapshot = Boolean(currentPath);
  const disconnectedMessage = fileState?.connectionState === "connecting"
    ? hasSnapshot ? "正在重新连接，已保留上次目录内容。" : "正在连接服务器…"
    : fileState?.connectionState === "connected"
      ? hasSnapshot ? "SFTP 当前不可用，已保留上次目录内容。" : "SFTP 当前不可用。"
      : hasSnapshot
        ? "连接已断开，已保留上次目录内容；重连后将自动刷新。"
        : "连接已断开，暂无可显示的远程目录。";
  const liveStatus = !available
    ? disconnectedMessage
    : isRefreshing
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
      onOpen: available ? () => onNavigate?.(parentPath) : undefined,
    }] : []),
    ...(fileState?.entries || []).map((entry) => ({
      key: `${entry.type}:${entry.name}`,
      entry,
      remotePath: `${currentPath === "/" ? "" : currentPath}/${entry.name}`,
      onOpen: !available
        ? undefined
        : entry.type === "directory"
        ? () => onNavigate?.(`${currentPath === "/" ? "" : currentPath}/${entry.name}`)
        : entry.type === "file"
          ? () => onOpenTextFile?.({ entry, path: `${currentPath === "/" ? "" : currentPath}/${entry.name}` })
          : undefined,
    })),
  ];

  useEffect(() => {
    setPathDraft(currentPath || "");
  }, [currentPath]);

  useEffect(() => {
    setFocusedFileRow((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    downloadRequestRef.current += 1;
    setDownloadState({ key: "", phase: "idle", message: "", progress: null });
    setContextMenu(null);
    setDeleteRequest(null);
    setRenameRequest(null);
    setCreateRequest(null);
  }, [currentPath]);

  async function downloadRemoteFile(key, entry, remotePath) {
    if (entry.type !== "file" || downloadState.phase === "downloading") return;
    const requestId = downloadRequestRef.current + 1;
    downloadRequestRef.current = requestId;
    setDownloadState({ key, phase: "downloading", message: `正在下载 ${entry.name}…`, progress: 0 });
    try {
      const result = await onDownloadRemoteFile?.(remotePath, (event) => {
        if (downloadRequestRef.current !== requestId) return;
        const progress = Math.min(100, Math.max(0, Math.round(Number(event?.progress) || 0)));
        setDownloadState({ key, phase: "downloading", message: `正在下载 ${entry.name}…`, progress });
      });
      if (downloadRequestRef.current !== requestId) return;
      setDownloadState({
        key,
        phase: result ? "done" : "cancelled",
        message: result ? `${entry.name} 已下载到所选位置。` : `已取消下载 ${entry.name}。`,
        progress: result ? 100 : null,
      });
    } catch (error) {
      if (downloadRequestRef.current !== requestId) return;
      setDownloadState({ key, phase: "error", message: error?.message || `无法下载 ${entry.name}。`, progress: null });
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

  async function confirmRemoteCreate(request) {
    await onCreateRemoteEntry?.(request.directory, request.name, request.entryType);
    setCreateRequest(null);
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

  if (collapsed && layout !== "bottom") {
    return (
      <aside className={`explorer-panel explorer-panel--${layout} is-collapsed`} aria-label="已收起的远程文件">
        <Files size={21} />
        <IconButton label="展开资源管理器" onClick={onToggleCollapsed}>
          {layout === "left" ? <CaretRight size={18} /> : <CaretLeft size={18} />}
        </IconButton>
      </aside>
    );
  }

  return (
    <aside className={`explorer-panel explorer-panel--${layout} ${embedded ? "is-embedded" : ""}`} aria-label="远程文件">
      {!embedded && <div className="panel-title-row">
        <h2>资源管理器</h2>
        <span className="explorer-panel__dock-actions">
          <span className="explorer-placement" role="group" aria-label="资源管理器位置">
            {[['left', '左'], ['bottom', '下'], ['right', '右']].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={layout === value} onClick={() => onPlacementChange?.(value)}>{label}</button>
            ))}
          </span>
          {layout !== "bottom" && (
            <IconButton label="收起资源管理器" onClick={onToggleCollapsed}>
              {layout === "left" ? <CaretLeft size={18} /> : <CaretRight size={18} />}
            </IconButton>
          )}
        </span>
      </div>}
      <div className="section-heading">
        <h3>远程文件</h3>
        <span>
          <IconButton label="刷新远程文件" disabled={!available} onClick={onRefresh} className={isRefreshing ? "is-spinning" : ""}>
            <ArrowsClockwise size={19} />
          </IconButton>
          <IconButton
            label="选择文件上传"
            disabled={!available}
            onClick={() => void onSelectUploadFiles?.()}
          >
            <CloudArrowUp size={19} />
          </IconButton>
        </span>
      </div>
      <form
        className="path-select"
        aria-label={`当前远程路径：${currentPath || "SFTP 不可用"}`}
        onSubmit={(event) => {
          event.preventDefault();
          const nextPath = pathDraft.trim();
          if (nextPath) onNavigate?.(nextPath);
        }}
      >
        <input value={pathDraft} disabled={!available || !currentPath} aria-label="远程路径" onChange={(event) => setPathDraft(event.target.value)} />
        <button type="submit" disabled={!available || !pathDraft.trim() || pathDraft.trim() === currentPath}>转到</button>
      </form>

      <div className={`remote-file-manager is-${layout}`}>
        <RemoteDirectoryTree
          treeKey={treeKey}
          currentPath={currentPath}
          sessionKey={fileState?.sessionKey}
          available={available}
          onListDirectory={onListDirectory}
          onNavigate={onNavigate}
        />
        <div
          ref={shellRef}
          className={`file-tree-shell ${dragging ? "is-dragging" : ""}`}
          onContextMenu={(event) => {
            if (!available) {
              event.preventDefault();
              return;
            }
            if (event.target.closest?.(".native-file-row")) return;
            openContextMenu(event, {
              key: "background:current-directory",
              entry: { name: currentPath, type: "background" },
              remotePath: currentPath,
              createDirectory: currentPath,
            });
          }}
        >
          <div
            className={`file-tree ${layout === "bottom" ? "file-tree--table" : ""} ${isRefreshing ? "is-refreshing" : ""}`}
            role={layout === "bottom" ? "table" : "tree"}
            aria-label="远程文件列表，可拖放上传"
            aria-busy={isRefreshing}
            aria-disabled={!available}
          >
            {layout === "bottom" && (
              <div className="remote-file-table__header" role="row">
                <span role="columnheader">文件名</span><span role="columnheader">大小</span><span role="columnheader">类型</span><span role="columnheader">修改时间</span><span role="columnheader">权限</span><span role="columnheader">用户/用户组</span>
              </div>
            )}
            {!available && <div className="file-tree__message" role="status">{disconnectedMessage}</div>}
            {available && fileState?.error && <div className="file-tree__message is-error" role="alert">{fileState.error}</div>}
            {available && !fileState?.error && !fileState?.loading && fileState?.entries?.length === 0 && <div className="file-tree__message">此目录为空</div>}
            {rows.map(({ key, entry, remotePath, onOpen }, index) => (
              <NativeFileRow
                key={key}
                entry={entry}
                layout={layout}
                onOpen={onOpen}
                rowRef={(element) => { fileRowRefs.current[index] = element; }}
                tabIndex={focusedFileRow === index ? 0 : -1}
                onFocus={() => setFocusedFileRow(index)}
                onMove={(event) => moveFileRowFocus(event, index)}
                onContextMenu={(event) => {
                  if (!available) {
                    event.preventDefault();
                    return;
                  }
                  openContextMenu(event, {
                    key,
                    entry,
                    remotePath,
                    onOpen,
                    createDirectory: entry.type === "directory" && entry.name !== ".." ? remotePath : currentPath,
                  });
                }}
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
      </div>
      {downloadState.message && (
        <div className={`file-tree__download-status is-${downloadState.phase}`} role="status">
          {downloadState.phase === "downloading" && <CircleNotch size={14} className="is-spinning" />}
          <span>{downloadState.message}</span>
          {downloadState.progress !== null && <b>{downloadState.progress}%</b>}
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
        onCreateFile={() => contextMenu && setCreateRequest({ directory: contextMenu.createDirectory, entryType: "file" })}
        onCreateDirectory={() => contextMenu && setCreateRequest({ directory: contextMenu.createDirectory, entryType: "directory" })}
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
      <RemoteCreateDialog
        request={createRequest}
        onCancel={() => setCreateRequest(null)}
        onConfirm={confirmRemoteCreate}
      />
    </aside>
  );
}

function remotePathAncestors(path) {
  if (!path || path === "/") return ["/"];
  const segments = path.split("/").filter(Boolean);
  return ["/", ...segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`)];
}

function joinRemotePath(parent, name) {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function RemoteDirectoryTree({ treeKey, sessionKey, available, currentPath, onListDirectory, onNavigate }) {
  const nodesRef = useRef({});
  const requestsRef = useRef(new Map());
  const treeKeyRef = useRef(treeKey);
  const sessionKeyRef = useRef(sessionKey);
  const [nodes, setNodes] = useState({});
  const [expandedPaths, setExpandedPaths] = useState(() => new Set(["/"]));
  treeKeyRef.current = treeKey;
  sessionKeyRef.current = sessionKey;

  useEffect(() => {
    nodesRef.current = {};
    requestsRef.current.clear();
    setNodes({});
    setExpandedPaths(new Set(["/"]));
  }, [treeKey]);

  useEffect(() => {
    if (available) return;
    requestsRef.current.clear();
    const retainedNodes = Object.fromEntries(Object.entries(nodesRef.current).map(([path, node]) => [
      path,
      { ...node, loading: false },
    ]));
    nodesRef.current = retainedNodes;
    setNodes(retainedNodes);
  }, [available]);

  const ensureNode = useCallback((path) => {
    if (!available || typeof onListDirectory !== "function") return Promise.resolve();
    if (nodesRef.current[path]?.loaded && nodesRef.current[path]?.sessionKey === sessionKeyRef.current) return Promise.resolve();
    const requestKey = `${treeKeyRef.current || "none"}:${sessionKeyRef.current || "offline"}:${path}`;
    const existingRequest = requestsRef.current.get(requestKey);
    if (existingRequest) return existingRequest;
    const requestContext = { treeKey: treeKeyRef.current, sessionKey: sessionKeyRef.current };
    const loadingNode = { ...(nodesRef.current[path] || {}), loading: true, error: "" };
    nodesRef.current = { ...nodesRef.current, [path]: loadingNode };
    setNodes(nodesRef.current);
    const request = onListDirectory(path)
      .then((result) => {
        if (!isRemoteFileRequestCurrent(requestContext, {
          treeKey: treeKeyRef.current,
          sessionKey: sessionKeyRef.current,
        })) return;
        const nextNode = {
          loaded: true,
          loading: false,
          error: "",
          sessionKey: requestContext.sessionKey,
          entries: (result?.entries || []).filter((entry) => entry.type === "directory" && ![".", ".."].includes(entry.name)),
        };
        nodesRef.current = { ...nodesRef.current, [path]: nextNode };
        setNodes(nodesRef.current);
      })
      .catch((error) => {
        if (error?.code === STALE_REMOTE_FILE_REQUEST_CODE) return;
        if (!isRemoteFileRequestCurrent(requestContext, {
          treeKey: treeKeyRef.current,
          sessionKey: sessionKeyRef.current,
        })) return;
        const previousNode = nodesRef.current[path] || {};
        nodesRef.current = {
          ...nodesRef.current,
          [path]: {
            ...previousNode,
            loaded: false,
            loading: false,
            entries: previousNode.entries || [],
            error: error?.message || "无法读取目录",
          },
        };
        setNodes(nodesRef.current);
      })
      .finally(() => requestsRef.current.delete(requestKey));
    requestsRef.current.set(requestKey, request);
    return request;
  }, [available, onListDirectory]);

  useEffect(() => {
    const ancestors = remotePathAncestors(currentPath);
    setExpandedPaths((current) => new Set([...current, ...ancestors]));
    let disposed = false;
    void (async () => {
      for (const path of ancestors) {
        if (disposed) return;
        await ensureNode(path);
      }
    })();
    return () => { disposed = true; };
  }, [available, currentPath, ensureNode, sessionKey, treeKey]);

  function toggleNode(path) {
    const expanding = !expandedPaths.has(path);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (expanding) void ensureNode(path);
  }

  function renderNode(path, name, depth) {
    const node = nodes[path];
    const expanded = expandedPaths.has(path);
    const entries = node?.entries || [];
    const hasKnownChildren = !node?.loaded || entries.length > 0;
    return (
      <Fragment key={path}>
        <div
          className={`remote-directory-tree__row ${currentPath === path ? "is-selected" : ""}`}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={hasKnownChildren ? expanded : undefined}
          style={{ "--tree-depth": depth }}
        >
          {hasKnownChildren ? (
            <button type="button" disabled={!available} className="remote-directory-tree__toggle" aria-label={`${expanded ? "收起" : "展开"}${name}`} onClick={() => toggleNode(path)}>
              {node?.loading ? <CircleNotch size={13} className="is-spinning" /> : expanded ? <CaretDown size={13} /> : <CaretRight size={13} />}
            </button>
          ) : <span className="remote-directory-tree__toggle" />}
          <button
            type="button"
            disabled={!available}
            className="remote-directory-tree__name"
            title={path}
            onClick={() => {
              setExpandedPaths((current) => new Set([...current, path]));
              void ensureNode(path);
              onNavigate?.(path);
            }}
          >
            <Folder size={16} weight="fill" /> <span>{name}</span>
          </button>
        </div>
        {expanded && entries.map((entry) => renderNode(joinRemotePath(path, entry.name), entry.name, depth + 1))}
      </Fragment>
    );
  }

  return (
    <aside className="remote-directory-tree" aria-label="远程目录树">
      <div className="remote-directory-tree__title">目录</div>
      <div className="remote-directory-tree__items" role="tree">
        {renderNode("/", "/", 0)}
      </div>
    </aside>
  );
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex > 1 ? 1 : 0)} ${units[unitIndex]}`;
}

function NativeFileRow({ entry, layout, onOpen, rowRef, tabIndex, onFocus, onMove, onContextMenu }) {
  const Icon = entry.type === "directory" ? Folder : entry.type === "symlink" ? Link : FileText;
  const parentEntry = entry.name === "..";
  const content = layout === "bottom" ? (
    <>
      <span className="remote-file-table__name" role="cell">
        {entry.type === "directory" ? <CaretRight size={14} /> : <span className="tree-spacer" />}
        <Icon size={18} weight={entry.type === "directory" ? "fill" : "regular"} />
        <span className="native-file-row__name" title={entry.name}>{entry.name}</span>
      </span>
      <small role="cell">{entry.type === "file" ? formatFileSize(entry.size) : ""}</small>
      <small role="cell">{{ directory: "文件夹", file: "文件", symlink: "符号链接" }[entry.type] || "其他"}</small>
      <small role="cell">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString("zh-CN", { hour12: false }) : "—"}</small>
      <small role="cell" className="remote-file-table__permission">{entry.permissions || "—"}</small>
      <small role="cell">{entry.owner || "—"}</small>
    </>
  ) : (
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
      className={`tree-row native-file-row ${layout === "bottom" ? "is-table" : ""} ${onOpen ? "" : "is-static"}`}
      role={layout === "bottom" ? "row" : "treeitem"}
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

function MonitorPanel({ server, metrics, sampledAt, loading, error, intervalSeconds, onIntervalChange }) {
  return (
    <aside className="explorer-panel monitor-side-panel" aria-label="性能监控">
      <div className="panel-title-row">
        <h2>性能监控</h2>
        <label className="monitor-side-panel__interval">
          <span>刷新</span>
          <select aria-label="监控刷新间隔" value={intervalSeconds} onChange={(event) => onIntervalChange?.(Number(event.target.value))}>
            {[1, 2, 5, 10, 30].map((seconds) => <option key={seconds} value={seconds}>{seconds} 秒</option>)}
          </select>
        </label>
      </div>
      <MonitorErrorBoundary resetKey={`${server?.id || "none"}:${sampledAt}`}>
        <MonitorDashboard compact server={server} metrics={metrics} sampledAt={sampledAt} loading={loading} error={error} />
      </MonitorErrorBoundary>
    </aside>
  );
}
