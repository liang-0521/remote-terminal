import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./components/shared/AppErrorBoundary.js";
import { parseDetachedDocumentLocation } from "./services/detached-document.js";
import "./styles.css";

// WebView2 is application chrome: browser reload shortcuts can discard live
// terminal UI state, and its default context menu exposes browser-only actions.
document.addEventListener("contextmenu", (event) => event.preventDefault(), { capture: true });
document.addEventListener("keydown", (event) => {
  const reloadShortcut = event.key === "F5"
    || (event.ctrlKey && (event.key.toLowerCase() === "r" || event.code === "KeyR"));
  if (reloadShortcut) event.preventDefault();
}, { capture: true });

const detachedDocumentLocation = parseDetachedDocumentLocation(window.location.search);
const RuntimeApp = detachedDocumentLocation.requested
  ? lazy(() => import("./DetachedDocumentApp.jsx")
    .then(({ DetachedDocumentApp }) => ({ default: DetachedDocumentApp })))
  : lazy(() => import("./App.jsx")
    .then(({ App }) => ({ default: App })));

const application = (
  <AppErrorBoundary>
    <Suspense fallback={<main className="native-startup-state" role="status">正在加载客户端…</main>}>
      <RuntimeApp
        document={detachedDocumentLocation.document}
        parseError={detachedDocumentLocation.error || ""}
      />
    </Suspense>
  </AppErrorBoundary>
);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>{application}</React.StrictMode>,
);
