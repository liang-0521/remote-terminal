import { useRef } from "react";

export const MIN_EXPLORER_WIDTH = 220;
export const DEFAULT_EXPLORER_WIDTH = 320;
const MAX_EXPLORER_WIDTH = 520;
const MIN_TERMINAL_WIDTH = 520;

function clampWidth(width, workbenchWidth) {
  const availableMaximum = Math.max(MIN_EXPLORER_WIDTH, workbenchWidth - MIN_TERMINAL_WIDTH);
  return Math.round(Math.min(MAX_EXPLORER_WIDTH, availableMaximum, Math.max(MIN_EXPLORER_WIDTH, width)));
}

export function WorkspaceResizeHandle({ width, onResize, onReset }) {
  const dragState = useRef(null);

  function getWorkbenchWidth(element) {
    return element.closest(".workbench")?.getBoundingClientRect().width || window.innerWidth;
  }

  function startResize(event) {
    dragState.current = {
      startX: event.clientX,
      startWidth: width,
      workbenchWidth: getWorkbenchWidth(event.currentTarget),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event) {
    if (!dragState.current) return;
    const nextWidth = dragState.current.startWidth + event.clientX - dragState.current.startX;
    onResize(clampWidth(nextWidth, dragState.current.workbenchWidth));
  }

  function endResize(event) {
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeWithKeyboard(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const workbenchWidth = getWorkbenchWidth(event.currentTarget);
    const nextWidth = event.key === "Home"
      ? MIN_EXPLORER_WIDTH
      : event.key === "End"
        ? MAX_EXPLORER_WIDTH
        : width + (event.key === "ArrowRight" ? 16 : -16);
    onResize(clampWidth(nextWidth, workbenchWidth));
  }

  return (
    <div
      className="explorer-resize-handle"
      role="separator"
      aria-label="调整资源管理器宽度"
      aria-orientation="vertical"
      aria-valuemin={MIN_EXPLORER_WIDTH}
      aria-valuemax={MAX_EXPLORER_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      tabIndex={0}
      onDoubleClick={onReset}
      onKeyDown={resizeWithKeyboard}
      onPointerDown={startResize}
      onPointerMove={resize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
    />
  );
}
