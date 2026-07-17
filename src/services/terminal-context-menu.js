const CONTEXT_MENU_MARGIN = 8;

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function clampTerminalContextMenuPosition(
  anchor,
  menuSize,
  viewportSize,
  margin = CONTEXT_MENU_MARGIN,
) {
  const safeMargin = Math.max(0, finiteNumber(margin, CONTEXT_MENU_MARGIN));
  const menuWidth = Math.max(0, finiteNumber(menuSize?.width, 0));
  const menuHeight = Math.max(0, finiteNumber(menuSize?.height, 0));
  const viewportWidth = Math.max(0, finiteNumber(viewportSize?.width, 0));
  const viewportHeight = Math.max(0, finiteNumber(viewportSize?.height, 0));
  const maxLeft = Math.max(safeMargin, viewportWidth - menuWidth - safeMargin);
  const maxTop = Math.max(safeMargin, viewportHeight - menuHeight - safeMargin);

  return {
    left: Math.max(safeMargin, Math.min(finiteNumber(anchor?.x, safeMargin), maxLeft)),
    top: Math.max(safeMargin, Math.min(finiteNumber(anchor?.y, safeMargin), maxTop)),
  };
}

export function nextTerminalContextMenuFocusIndex(key, currentIndex, itemCount) {
  if (!Number.isInteger(itemCount) || itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowDown") return currentIndex < 0 ? 0 : (currentIndex + 1) % itemCount;
  if (key === "ArrowUp") return currentIndex < 0 ? itemCount - 1 : (currentIndex - 1 + itemCount) % itemCount;
  return null;
}

export function isTerminalContextMenuKey(event) {
  return event?.key === "ContextMenu"
    || event?.code === "ContextMenu"
    || (event?.shiftKey && (event.key === "F10" || event.code === "F10"));
}

export function readTerminalSelection(terminal) {
  const selection = terminal?.getSelection?.();
  return typeof selection === "string" ? selection : "";
}

export function shouldFocusTerminal({
  active,
  contextMenuOpen,
  commandSearchOpen,
  activeElement,
  body,
  terminalSlot,
  terminalTabId,
  focusTerminalOnActivate,
}) {
  if (!active || contextMenuOpen || commandSearchOpen) return false;
  if (!activeElement || activeElement === body) return true;
  if (terminalSlot?.contains(activeElement)) return true;
  if (activeElement?.closest?.(".terminal-context-menu")) return true;
  return Boolean(focusTerminalOnActivate && activeElement.id === terminalTabId);
}

export async function copyTerminalSelection(clipboard, selection) {
  if (typeof selection !== "string" || !selection) return false;
  await clipboard.writeText(selection);
  return true;
}

export async function pasteTerminalClipboard(clipboard, terminal, canPaste = () => true) {
  if (!canPaste()) return false;
  const text = await clipboard.readText();
  if (typeof text !== "string" || !text || !canPaste()) return false;
  terminal.paste(text);
  return true;
}
