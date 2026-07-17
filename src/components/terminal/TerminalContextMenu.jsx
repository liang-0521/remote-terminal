import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardText, Copy, SelectionAll } from "@phosphor-icons/react";
import {
  clampTerminalContextMenuPosition,
  nextTerminalContextMenuFocusIndex,
} from "../../services/terminal-context-menu.js";

export function TerminalContextMenu({
  request,
  pasteDisabled = false,
  onClose,
  onCopy,
  onPaste,
  onSelectAll,
}) {
  const menuRef = useRef(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!request || !menuRef.current) return;
    const menu = menuRef.current;
    setPosition(clampTerminalContextMenuPosition(
      { x: request.x, y: request.y },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [request]);

  useEffect(() => {
    if (!request) return undefined;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [request]);

  useEffect(() => {
    if (!request) return undefined;
    const closeForOutsideInteraction = () => {
      onClose(false);
    };
    const closeForOutsidePointer = (event) => {
      if (menuRef.current?.contains(event.target)) return;
      closeForOutsideInteraction();
    };
    window.addEventListener("pointerdown", closeForOutsidePointer, true);
    window.addEventListener("blur", closeForOutsideInteraction);
    window.addEventListener("resize", closeForOutsideInteraction);
    return () => {
      window.removeEventListener("pointerdown", closeForOutsidePointer, true);
      window.removeEventListener("blur", closeForOutsideInteraction);
      window.removeEventListener("resize", closeForOutsideInteraction);
    };
  }, [onClose, request]);

  if (!request) return null;

  function runCopy() {
    const selection = request.selection;
    onClose(false);
    onCopy(selection);
  }

  function runPaste() {
    onClose(false);
    onPaste();
  }

  function moveFocus(event) {
    const buttons = [...menuRef.current.querySelectorAll("button:not(:disabled)")];
    const nextIndex = nextTerminalContextMenuFocusIndex(
      event.key,
      buttons.indexOf(document.activeElement),
      buttons.length,
    );
    if (nextIndex === null) return false;
    event.preventDefault();
    buttons[nextIndex]?.focus();
    return true;
  }

  return createPortal((
    <div
      ref={menuRef}
      className="terminal-context-menu"
      role="menu"
      aria-label="终端操作"
      style={{ ...position, maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const ctrlShortcut = event.ctrlKey && !event.altKey && !event.metaKey;
        if (ctrlShortcut && event.code === "KeyC" && request.selection) {
          event.preventDefault();
          runCopy();
          return;
        }
        if (ctrlShortcut && event.shiftKey && event.code === "KeyV" && !pasteDisabled) {
          event.preventDefault();
          runPaste();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onClose(true);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          onClose(true);
          return;
        }
        moveFocus(event);
      }}
    >
      <div className="terminal-context-menu__title">
        {request.selection ? `已选择 ${request.selection.length} 个字符` : "终端操作"}
      </div>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-keyshortcuts="Control+C Control+Shift+C"
        disabled={!request.selection}
        onClick={runCopy}
      >
        <Copy size={16} aria-hidden="true" />
        <span>复制</span>
        <kbd>Ctrl+C</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-keyshortcuts="Control+Shift+V"
        disabled={pasteDisabled}
        onClick={runPaste}
      >
        <ClipboardText size={16} aria-hidden="true" />
        <span>粘贴</span>
        <kbd>Ctrl+Shift+V</kbd>
      </button>
      <div className="terminal-context-menu__separator" role="separator" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          onClose(false);
          onSelectAll();
        }}
      >
        <SelectionAll size={16} aria-hidden="true" />
        <span>全选终端内容</span>
      </button>
    </div>
  ), document.querySelector(".app-root") || document.body);
}
