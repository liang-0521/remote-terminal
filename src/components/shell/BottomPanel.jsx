import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  CheckCircle,
  FileText,
} from "@phosphor-icons/react";
import { IconButton } from "../shared/IconButton.jsx";

const MIN_PANEL_HEIGHT = 120;
const MAX_PANEL_HEIGHT_RATIO = 0.45;

export function BottomPanel({ collapsed, activeView = "transfer", filesContent = null, explorerPlacement = "bottom", transfers, servers, onViewChange, onExplorerPlacementChange, onToggle, onResize, onResetResize, onCancel, onRetry }) {
  const dragState = useRef(null);
  const panelRef = useRef(null);
  const [panelHeight, setPanelHeight] = useState(MIN_PANEL_HEIGHT);
  const maxPanelHeight = Math.max(MIN_PANEL_HEIGHT, Math.round(window.innerHeight * MAX_PANEL_HEIGHT_RATIO));
  const announcedPanelHeight = Math.min(maxPanelHeight, Math.max(MIN_PANEL_HEIGHT, panelHeight));

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const updateHeight = () => {
      const nextHeight = Math.round(panel.getBoundingClientRect().height);
      setPanelHeight((current) => current === nextHeight ? current : nextHeight);
    };
    const observer = new ResizeObserver(updateHeight);
    observer.observe(panel);
    updateHeight();
    return () => observer.disconnect();
  }, []);

  function startResize(event) {
    if (collapsed) return;
    const panel = event.currentTarget.closest(".bottom-panel");
    dragState.current = { startY: event.clientY, startHeight: panel.getBoundingClientRect().height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event) {
    if (!dragState.current) return;
    const nextHeight = dragState.current.startHeight + dragState.current.startY - event.clientY;
    onResize(Math.round(Math.min(maxPanelHeight, Math.max(MIN_PANEL_HEIGHT, nextHeight))));
  }

  function endResize(event) {
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeWithKeyboard(event) {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const panelHeight = event.currentTarget.closest(".bottom-panel").getBoundingClientRect().height;
    const delta = event.key === "ArrowUp" ? 16 : -16;
    onResize(Math.round(Math.min(maxPanelHeight, Math.max(MIN_PANEL_HEIGHT, panelHeight + delta))));
  }

  return (
    <section ref={panelRef} className={`bottom-panel ${collapsed ? "is-collapsed" : ""}`}>
      {!collapsed && <div
        className="bottom-panel__resize-handle"
        role="separator"
        aria-label="调整底部面板高度"
        aria-orientation="horizontal"
        aria-valuemin={MIN_PANEL_HEIGHT}
        aria-valuemax={maxPanelHeight}
        aria-valuenow={announcedPanelHeight}
        aria-valuetext={`${announcedPanelHeight} 像素`}
        tabIndex={0}
        onDoubleClick={onResetResize}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />}
      <div className="bottom-panel__tabs">
        <div className="bottom-panel__views" role={filesContent ? "tablist" : undefined} aria-label={filesContent ? "底部面板" : undefined}>
          {filesContent && (
            <button type="button" role="tab" aria-selected={activeView === "files"} className={activeView === "files" ? "is-active" : ""} onClick={() => onViewChange?.("files")}>远程文件</button>
          )}
          <button type="button" role={filesContent ? "tab" : undefined} aria-selected={filesContent ? activeView === "transfer" : undefined} className={activeView === "transfer" ? "is-active" : ""} onClick={() => onViewChange?.("transfer")}>
            传输任务 <span className="tab-badge">{transfers.length}</span>
          </button>
        </div>
        <span className="bottom-panel__actions">
          {filesContent && activeView === "files" && (
            <span className="explorer-placement" role="group" aria-label="资源管理器位置">
              {[["left", "左"], ["bottom", "下"], ["right", "右"]].map(([value, label]) => (
                <button key={value} type="button" aria-pressed={explorerPlacement === value} onClick={() => onExplorerPlacementChange?.(value)}>{label}</button>
              ))}
            </span>
          )}
          <IconButton
            label={collapsed ? "展开面板" : "收起面板"}
            data-icon-direction={collapsed ? "up" : "down"}
            onClick={onToggle}
          >
            {collapsed ? <CaretUp size={18} /> : <CaretDown size={18} />}
          </IconButton>
        </span>
      </div>
      {!collapsed && (
        <div className={`bottom-panel__content is-${activeView}`} role="region" aria-label={activeView === "files" ? "远程文件列表" : "传输任务列表"} tabIndex={0}>
          {activeView === "files" && filesContent
            ? filesContent
            : <TransferView transfers={transfers} servers={servers} onCancel={onCancel} onRetry={onRetry} />}
        </div>
      )}
    </section>
  );
}
function TransferView({ transfers, servers, onCancel, onRetry }) {
  return (
    <div className="transfer-table" role="table" aria-label="传输任务" aria-colcount={8}>
      <div role="rowgroup">
        <div className="transfer-row transfer-row--header" role="row">
          <span role="columnheader">文件名</span><span role="columnheader">方向</span><span role="columnheader">服务器 / 目标</span><span role="columnheader">大小</span><span role="columnheader">进度</span><span role="columnheader">速度</span><span role="columnheader">状态</span><span role="columnheader">操作</span>
        </div>
      </div>
      <div role="rowgroup">
        {transfers.length === 0 && <div className="transfer-table__empty" role="row"><span role="cell" aria-colspan={8}>暂无传输任务，将文件拖到远程文件列表即可上传。</span></div>}
        {transfers.map((transfer) => {
        const stateLabel = {
          queued: "排队中",
          uploading: "上传中",
          cancelling: "正在取消",
          finalizing: "正在完成",
          success: "已完成",
          cancelled: "已取消",
          failed: "失败",
        }[transfer.state] || "未知";
        const transferServer = servers.find((item) => item.id === transfer.serverId);
        const destination = `${transferServer?.name || transfer.serverId} · ${transfer.target}`;
        const progress = Math.min(100, Math.max(0, Number(transfer.progress)));
        return <div key={transfer.id} className="transfer-row" role="row">
          <span role="cell" className="transfer-file">{transfer.state === "success" ? <CheckCircle size={18} weight="fill" aria-hidden="true" /> : <FileText size={18} aria-hidden="true" />} {transfer.fileName}</span>
          <span role="cell">↑ 上传</span>
          <span role="cell" className="transfer-target" title={destination}>{destination}</span>
          <span role="cell">{transfer.sizeLabel}</span>
          <span role="cell" className="transfer-progress"><progress max="100" value={progress} aria-label={`${transfer.fileName} 上传进度`} aria-valuetext={`${Math.round(progress)}%，${stateLabel}`} /> <b>{Math.round(progress)}%</b></span>
          <span role="cell">{transfer.state === "uploading" ? transfer.speed : "—"}</span>
          <span role="cell" title={transfer.error?.message}>{stateLabel}</span>
          <span role="cell">{["queued", "uploading"].includes(transfer.state)
            ? <button type="button" className="text-button" aria-label={`取消 ${transfer.fileName}`} onClick={() => onCancel(transfer.id)}>取消</button>
            : ["cancelled", "failed"].includes(transfer.state)
              ? <button type="button" className="text-button" aria-label={`重试 ${transfer.fileName}`} onClick={() => onRetry(transfer.id)}>重试</button>
              : "—"}</span>
        </div>;
      })}
      </div>
    </div>
  );
}
