import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

const application = <App />;
const runningInElectron = navigator.userAgent.includes("Electron");

createRoot(document.getElementById("root")).render(
  runningInElectron ? application : <React.StrictMode>{application}</React.StrictMode>,
);
