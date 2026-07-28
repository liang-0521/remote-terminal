import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  createDetachedDocumentUrl,
  DETACHED_DOCUMENT_ADD_EVENT,
  DETACHED_DOCUMENT_GROUP_LABEL,
  normalizeDetachedDocument,
} from "../services/detached-document.js";

const DETACHED_WINDOW_CREATED_EVENT = "tauri://created";
const DETACHED_WINDOW_ERROR_EVENT = "tauri://error";

export async function openDetachedDocumentWindow(document, runtime = {}) {
  const normalized = normalizeDetachedDocument(document);
  const WebviewWindowType = runtime.WebviewWindowType || WebviewWindow;
  const getByLabel = runtime.getByLabel
    || ((label) => WebviewWindowType.getByLabel(label));
  const existingWindow = await getByLabel(DETACHED_DOCUMENT_GROUP_LABEL);
  if (existingWindow) {
    await existingWindow.emitTo(
      DETACHED_DOCUMENT_GROUP_LABEL,
      DETACHED_DOCUMENT_ADD_EVENT,
      normalized,
    );
    await existingWindow.show();
    await existingWindow.setFocus();
    return existingWindow;
  }

  const detachedWindow = new WebviewWindowType(DETACHED_DOCUMENT_GROUP_LABEL, {
    url: createDetachedDocumentUrl(normalized),
    title: `${normalized.name} - Remote Terminal`,
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 440,
    center: true,
    resizable: true,
    decorations: true,
    dragDropEnabled: true,
    backgroundColor: "#071725",
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveCreated = () => {
      if (settled) return;
      settled = true;
      resolve(detachedWindow);
    };
    const rejectCreated = (event) => {
      if (settled) return;
      settled = true;
      const detail = typeof event?.payload === "string" ? event.payload : "";
      reject(new Error(detail || "无法创建独立文件窗口。"));
    };
    void detachedWindow.once(DETACHED_WINDOW_CREATED_EVENT, resolveCreated);
    void detachedWindow.once(DETACHED_WINDOW_ERROR_EVENT, rejectCreated);
  });
}
