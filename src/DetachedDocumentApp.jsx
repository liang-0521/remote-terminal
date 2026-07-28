import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, X } from "@phosphor-icons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { RemoteTextEditor } from "./components/files/RemoteTextEditor.jsx";
import { UnsavedChangesDialog } from "./components/files/UnsavedChangesDialog.jsx";
import { getNativeClient } from "./native/client.js";
import { accentContrast, DEFAULT_APPEARANCE } from "./services/appearance.js";
import {
  DETACHED_DOCUMENT_ADD_EVENT,
  mergeDetachedDocuments,
  normalizeDetachedDocument,
} from "./services/detached-document.js";
import { resolveInterfaceColorScheme } from "./services/interface-theme.js";
import "./native-styles.css";
import "./theme-styles.css";
import "./feature-styles.css";

export function DetachedDocumentApp({ document, parseError = "" }) {
  const client = useMemo(() => getNativeClient(), []);
  const nativeWindow = useMemo(() => getCurrentWebviewWindow(), []);
  const documentsRef = useRef(document ? [document] : []);
  const tabRefs = useRef(new Map());
  const closingRef = useRef(false);
  const [documents, setDocuments] = useState(() => (document ? [document] : []));
  const [activeDocumentKey, setActiveDocumentKey] = useState(document?.key || null);
  const [closeRequest, setCloseRequest] = useState(null);
  const [windowError, setWindowError] = useState("");
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);
  const [themeMode, setThemeMode] = useState("system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => (
    typeof window.matchMedia !== "function"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches
  ));
  documentsRef.current = documents;
  const activeDocument = documents.find((item) => item.key === activeDocumentKey) || documents[0] || null;

  useEffect(() => {
    let cancelled = false;
    void client.app.getUiPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setAppearance((current) => ({ ...current, ...preferences.appearance }));
        setThemeMode(preferences.interfaceThemeMode);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemPrefersDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    void nativeWindow.onCloseRequested((event) => {
      if (closingRef.current) return;
      const dirtyDocuments = documentsRef.current.filter((item) => item.dirty);
      if (!dirtyDocuments.length) return;
      event.preventDefault();
      setCloseRequest({
        kind: "window",
        actionLabel: "关闭窗口",
        documents: dirtyDocuments,
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeWindow]);

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    void nativeWindow.listen(DETACHED_DOCUMENT_ADD_EVENT, (event) => {
      try {
        const incoming = normalizeDetachedDocument(event.payload);
        setDocuments((current) => {
          const next = mergeDetachedDocuments(current, incoming);
          documentsRef.current = next;
          return next;
        });
        setActiveDocumentKey(incoming.key);
        setWindowError("");
      } catch (error) {
        setWindowError(error?.message || "无法把文件加入独立窗口。");
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      if (!disposed) setWindowError(error?.message || "无法监听独立窗口文件。");
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [nativeWindow]);

  useEffect(() => {
    if (!activeDocument) return;
    const title = documents.length > 1
      ? `${documents.length} 个文件 - Remote Terminal`
      : `${activeDocument.name} - Remote Terminal`;
    void nativeWindow.setTitle(title).catch((error) => {
      setWindowError(error?.message || "无法更新独立窗口标题。");
    });
  }, [activeDocument, documents.length, nativeWindow]);

  async function destroyWindow() {
    closingRef.current = true;
    setCloseRequest(null);
    try {
      await nativeWindow.destroy();
    } catch (error) {
      closingRef.current = false;
      setWindowError(error?.message || "无法关闭独立文件窗口。");
    }
  }

  function closeDocumentNow(key) {
    const current = documentsRef.current;
    const index = current.findIndex((item) => item.key === key);
    if (index < 0) return;
    const next = current.filter((item) => item.key !== key);
    if (!next.length) {
      void destroyWindow();
      return;
    }
    documentsRef.current = next;
    setDocuments(next);
    if (activeDocumentKey === key) {
      setActiveDocumentKey((next[index] || next[index - 1]).key);
    }
    setCloseRequest(null);
  }

  function requestDocumentClose(key) {
    const target = documentsRef.current.find((item) => item.key === key);
    if (!target) return;
    if (!target.dirty) {
      closeDocumentNow(key);
      return;
    }
    setCloseRequest({
      kind: "document",
      key,
      actionLabel: "关闭文件",
      documents: [target],
    });
  }

  function confirmCloseRequest() {
    if (!closeRequest) return;
    if (closeRequest.kind === "window") {
      void destroyWindow();
      return;
    }
    closeDocumentNow(closeRequest.key);
  }

  function updateDocumentDirty(key, dirty) {
    setDocuments((current) => {
      const next = current.map((item) => (
        item.key === key && item.dirty !== dirty ? { ...item, dirty } : item
      ));
      documentsRef.current = next;
      return next;
    });
  }

  function selectRelativeDocument(event, index) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? documents.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + documents.length) % documents.length;
    const next = documents[nextIndex];
    if (!next) return;
    setActiveDocumentKey(next.key);
    window.requestAnimationFrame(() => tabRefs.current.get(next.key)?.focus());
  }

  const colorScheme = resolveInterfaceColorScheme(themeMode, systemPrefersDark);

  if (!documents.length) {
    return (
      <main className="detached-document-error" role="alert">
        <FileText size={38} weight="duotone" />
        <strong>无法打开独立文件窗口</strong>
        <span>{parseError || "文件窗口参数无效。"}</span>
      </main>
    );
  }

  return (
    <div
      className="app-root detached-document-window"
      data-color-scheme={colorScheme}
      data-theme-mode={themeMode}
      style={{
        "--accent": appearance.accent,
        "--accent-contrast": accentContrast(appearance.accent),
        "--terminal-background": appearance.terminalBackground,
        "--terminal-foreground": appearance.terminalForeground,
      }}
    >
      <header className="detached-document-window__tabs" role="tablist" aria-label="独立文件">
        {documents.map((item, index) => {
          const selected = item.key === activeDocument?.key;
          return (
            <div key={item.key} className={`terminal-tab is-document ${selected ? "is-active" : ""}`}>
              <button
                ref={(element) => {
                  if (element) tabRefs.current.set(item.key, element);
                  else tabRefs.current.delete(item.key);
                }}
                id={`detached-document-tab-${item.key}`}
                type="button"
                className="terminal-tab__select"
                role="tab"
                aria-selected={selected}
                aria-controls={`detached-document-panel-${item.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveDocumentKey(item.key)}
                onKeyDown={(event) => selectRelativeDocument(event, index)}
              >
                <FileText size={18} />
                <span>{item.name}{item.dirty ? " •" : ""}</span>
              </button>
              <button
                type="button"
                className="terminal-tab__close"
                aria-label={`关闭 ${item.name}`}
                onClick={() => requestDocumentClose(item.key)}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </header>
      {documents.map((item) => (
        <RemoteTextEditor
          key={item.key}
          active={item.key === activeDocument?.key}
          connected
          client={client}
          document={item}
          appearance={appearance}
          onDirtyChange={updateDocumentDirty}
        />
      ))}
      {windowError && <div className="detached-document-window__error" role="alert">{windowError}</div>}
      <UnsavedChangesDialog
        request={closeRequest}
        onCancel={() => setCloseRequest(null)}
        onConfirm={confirmCloseRequest}
      />
    </div>
  );
}
