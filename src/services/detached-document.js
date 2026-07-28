const DOCUMENT_QUERY_KEY = "detachedDocument";
export const DETACHED_DOCUMENT_GROUP_LABEL = "document-group";
export const DETACHED_DOCUMENT_ADD_EVENT = "detached-document-add";
const MAX_FIELD_LENGTHS = Object.freeze({
  key: 8_192,
  connectionId: 256,
  sessionId: 256,
  path: 8_192,
  name: 512,
});

function requireDocumentField(document, field) {
  const value = document?.[field];
  const maxLength = MAX_FIELD_LENGTHS[field];
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || [...value].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(`独立文件窗口缺少有效的 ${field}。`);
  }
  return value;
}

export function normalizeDetachedDocument(document) {
  const normalized = {
    key: requireDocumentField(document, "key"),
    connectionId: requireDocumentField(document, "connectionId"),
    sessionId: requireDocumentField(document, "sessionId"),
    path: requireDocumentField(document, "path"),
    name: requireDocumentField(document, "name"),
    dirty: false,
  };
  if (!normalized.path.startsWith("/")) {
    throw new TypeError("独立文件窗口只接受绝对远程路径。");
  }
  return normalized;
}

export function createDetachedDocumentUrl(document) {
  const payload = encodeURIComponent(JSON.stringify(normalizeDetachedDocument(document)));
  return `index.html?${DOCUMENT_QUERY_KEY}=${payload}`;
}

export function mergeDetachedDocuments(documents, incomingDocument) {
  const normalized = normalizeDetachedDocument(incomingDocument);
  if (documents.some((document) => document.key === normalized.key)) return documents;
  return [...documents, normalized];
}

export function parseDetachedDocumentLocation(search) {
  const parameters = new URLSearchParams(search || "");
  if (!parameters.has(DOCUMENT_QUERY_KEY)) {
    return { requested: false, document: null, error: null };
  }
  try {
    const payload = parameters.get(DOCUMENT_QUERY_KEY);
    return {
      requested: true,
      document: normalizeDetachedDocument(JSON.parse(payload)),
      error: null,
    };
  } catch (error) {
    return {
      requested: true,
      document: null,
      error: error instanceof Error ? error.message : "独立文件窗口参数无效。",
    };
  }
}

export function isPointerOutsideWindow(pointer, viewport) {
  const clientOutside = Number.isFinite(pointer?.clientX)
    && Number.isFinite(pointer?.clientY)
    && (
      pointer.clientX < 0
      || pointer.clientY < 0
      || pointer.clientX > viewport.innerWidth
      || pointer.clientY > viewport.innerHeight
    );
  const screenOutside = Number.isFinite(pointer?.screenX)
    && Number.isFinite(pointer?.screenY)
    && (
      pointer.screenX < viewport.screenX
      || pointer.screenY < viewport.screenY
      || pointer.screenX > viewport.screenX + viewport.outerWidth
      || pointer.screenY > viewport.screenY + viewport.outerHeight
    );
  return clientOutside || screenOutside;
}

export function shouldDetachDocumentTab({ tab, dropHandled, pointer, viewport }) {
  return Boolean(
    tab?.type === "document"
    && !dropHandled
    && pointer?.dropEffect === "none"
    && isPointerOutsideWindow(pointer, viewport),
  );
}
