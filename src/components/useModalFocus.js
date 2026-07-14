import { useEffect, useRef } from "react";
import { isImeCompositionKeyEvent } from "../services/command-completion.js";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden']):not([hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const openModalStack = [];

function pushModal(token) {
  const existingIndex = openModalStack.indexOf(token);
  if (existingIndex >= 0) openModalStack.splice(existingIndex, 1);
  openModalStack.push(token);
}

function removeModal(token) {
  const wasTopmost = openModalStack.at(-1) === token;
  const index = openModalStack.indexOf(token);
  if (index >= 0) openModalStack.splice(index, 1);
  return wasTopmost;
}

export function useModalFocus({ open, containerRef, initialFocusRef, canClose = true, onClose }) {
  const closeRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  const tokenRef = useRef(Symbol("modal-focus"));
  closeRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!open) return undefined;
    const token = tokenRef.current;
    pushModal(token);
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      if (openModalStack.at(-1) === token) initialFocusRef.current?.focus();
    });

    function handleKeyDown(event) {
      if (openModalStack.at(-1) !== token) return;
      if (event.key === "Escape") {
        if (isImeCompositionKeyEvent(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (canCloseRef.current) closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(containerRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || [])]
        .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const activeElement = document.activeElement;
      if (!containerRef.current?.contains(activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
      const wasTopmost = removeModal(token);
      if (wasTopmost) {
        const nextTopmost = openModalStack.at(-1);
        window.requestAnimationFrame(() => {
          if (openModalStack.at(-1) === nextTopmost && previousFocus?.isConnected) previousFocus.focus();
        });
      }
    };
  }, [containerRef, initialFocusRef, open]);
}
