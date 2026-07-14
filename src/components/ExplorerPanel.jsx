import { useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CloudArrowUp,
  FileText,
  Folder,
  HardDrives,
  Link,
  Plus,
} from "@phosphor-icons/react";
import { formatFileSize, RELEASES } from "../demoData.js";
import { IconButton } from "./IconButton.jsx";

export function ExplorerPanel({ mode, server, servers, activeServerId, runtimeMode = "demo", fileState, onUpload, onRefresh, onNavigate, onOpenBottomTab, onCreateSession, onSelectServer, onOpenConnections }) {
  if (mode === "connections") {
    return <ConnectionsPanel servers={servers} activeServerId={activeServerId} onSelectServer={onSelectServer} onOpenConnections={onOpenConnections} />;
  }
  if (mode !== "files") {
    return <ContextPanel mode={mode} server={server} onOpenBottomTab={onOpenBottomTab} onCreateSession={onCreateSession} />;
  }

  return <RemoteFiles server={server} runtimeMode={runtimeMode} fileState={fileState} onUpload={onUpload} onRefresh={onRefresh} onNavigate={onNavigate} />;
}

function RemoteFiles({ server, runtimeMode, fileState, onUpload, onRefresh, onNavigate }) {
  const inputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const [expanded, setExpanded] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    if (runtimeMode === "native") {
      onRefresh?.();
      return;
    }
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 650);
  }

  function receiveFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length) onUpload(files);
    setDragging(false);
  }

  function beginFileDrag(event) {
    event.preventDefault();
    if (!Array.from(event.dataTransfer.types || []).includes("Files")) return;
    dragDepthRef.current += 1;
    setDragging(true);
  }

  function leaveFileDrag(event) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function dropFiles(event) {
    event.preventDefault();
    dragDepthRef.current = 0;
    receiveFiles(event.dataTransfer.files);
  }

  const native = runtimeMode === "native";
  const currentPath = native ? fileState?.path : server.directory;
  const isRefreshing = native ? Boolean(fileState?.loading) : refreshing;
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

  return (
    <aside className="explorer-panel" aria-label="远程文件">
      <div className="panel-title-row">
        <h2>资源管理器</h2>
      </div>
      <div className="section-heading">
        <h3>远程文件</h3>
        <span>
          <IconButton label="刷新远程文件" onClick={refresh} className={isRefreshing ? "is-spinning" : ""}>
            <ArrowsClockwise size={19} />
          </IconButton>
          <IconButton label="选择文件上传" onClick={() => inputRef.current?.click()}>
            <CloudArrowUp size={19} />
          </IconButton>
        </span>
      </div>
      <div className="path-select" aria-label={`当前远程路径：${currentPath || "SFTP 不可用"}`}>
        <span>{currentPath || "SFTP 不可用"}</span>
      </div>

      <div
        className={`file-tree-shell ${dragging ? "is-dragging" : ""}`}
        onDragEnter={beginFileDrag}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={leaveFileDrag}
        onDrop={dropFiles}
      >
        <div className={`file-tree ${isRefreshing ? "is-refreshing" : ""}`} aria-label="远程文件列表，可拖放上传" aria-busy={isRefreshing}>
          {native ? (
            <>
              {parentPath && <NativeFileRow entry={{ name: "..", type: "directory", size: 0 }} onOpen={() => onNavigate?.(parentPath)} />}
              {fileState?.error && <div className="file-tree__message is-error" role="alert">{fileState.error}</div>}
              {!fileState?.error && !fileState?.loading && fileState?.entries?.length === 0 && <div className="file-tree__message">此目录为空</div>}
              {(fileState?.entries || []).map((entry) => (
                <NativeFileRow
                  key={`${entry.type}:${entry.name}`}
                  entry={entry}
                  onOpen={entry.type === "directory" ? () => onNavigate?.(`${currentPath === "/" ? "" : currentPath}/${entry.name}`) : undefined}
                />
              ))}
            </>
          ) : (
            <>
              <TreeRow depth={0} label="/" icon="branch" expanded />
              <TreeRow depth={1} label="var" icon="branch" expanded />
              <TreeRow depth={2} label="www" icon="branch" expanded />
              <TreeRow depth={3} label="app" icon="branch" expanded />
              <button type="button" className="tree-row is-selected" style={{ "--depth": 4 }} onClick={() => setExpanded((value) => !value)}>
                {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                <span className="tree-icon-spacer" />
                <span>releases</span>
              </button>
              {expanded && RELEASES.map((release) => <TreeRow key={release} depth={5} label={release} icon="folder" />)}
              <TreeRow depth={3} label="current → 20260714_101530" icon="link" />
              <TreeRow depth={3} label=".release.lock" icon="file" />
            </>
          )}
        </div>
        {dragging && (
          <div className="file-tree__drop-overlay" role="status">
            <CloudArrowUp size={38} weight="duotone" />
            <strong>释放文件开始上传</strong>
            <span>{currentPath}</span>
          </div>
        )}
        <input ref={inputRef} type="file" multiple hidden onChange={(event) => { receiveFiles(event.target.files); event.currentTarget.value = ""; }} />
      </div>
      <span className="file-tree__status" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</span>
    </aside>
  );
}

function NativeFileRow({ entry, onOpen }) {
  const Icon = entry.type === "directory" ? Folder : entry.type === "symlink" ? Link : FileText;
  const parentEntry = entry.name === "..";
  const content = (
    <>
      {entry.type === "directory" ? <CaretRight size={14} /> : <span className="tree-spacer" />}
      <Icon size={18} weight={entry.type === "directory" ? "fill" : "regular"} />
      <span title={entry.name}>{entry.name}</span>
      <small>{entry.type === "file" ? formatFileSize(entry.size) : ""}</small>
    </>
  );
  if (!onOpen) return <div className="tree-row native-file-row">{content}</div>;
  return (
    <button
      type="button"
      className="tree-row native-file-row"
      onClick={parentEntry ? onOpen : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || parentEntry) return;
        event.preventDefault();
        onOpen();
      }}
      onDoubleClick={parentEntry ? undefined : onOpen}
    >
      {content}
    </button>
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
              <em>{item.group}</em>
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

function TreeRow({ depth, label, icon, expanded = false }) {
  const Icon = icon === "file" ? FileText : icon === "link" ? Link : Folder;
  const branch = icon === "branch";
  return (
    <button type="button" className="tree-row" style={{ "--depth": depth }}>
      {branch || icon === "folder" ? (expanded ? <CaretDown size={14} /> : <span className="tree-spacer" />) : <span className="tree-spacer" />}
      {branch ? <span className="tree-icon-spacer" /> : <Icon size={18} weight={icon === "folder" ? "fill" : "regular"} />}
      <span>{label}</span>
    </button>
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
