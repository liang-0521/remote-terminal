import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./styles.css";

const RuntimeApp = lazy(() => import("./App.jsx")
  .then(({ App }) => ({ default: App })));

const application = (
  <AppErrorBoundary>
    <Suspense fallback={<main className="native-startup-state" role="status">正在加载客户端…</main>}>
      <RuntimeApp />
    </Suspense>
  </AppErrorBoundary>
);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>{application}</React.StrictMode>,
);
