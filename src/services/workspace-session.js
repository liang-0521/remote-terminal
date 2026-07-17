export function applyWorkspaceSessionEvent(workspace, event) {
  if (!workspace || !event?.sessionId || workspace.sessionId !== event.sessionId) return workspace;

  const disconnected = event.state === "disconnected";
  return {
    ...workspace,
    state: event.state,
    error: event.error?.message || (event.state === "error" ? "SSH 会话发生错误。" : ""),
    ...(disconnected ? {
      sessionId: null,
      filesLoading: false,
      monitorLoading: false,
    } : {}),
  };
}

export function applyConnectedWorkspace(workspace, result) {
  const sftpError = result.sftpError?.message || "";
  return {
    ...workspace,
    sessionId: result.sessionId,
    terminalSessionId: result.sessionId,
    state: "connected",
    error: "",
    directory: workspace.directory || result.home,
    filesLoading: false,
    sftpError,
    filesError: sftpError,
  };
}

export function canUseRemoteFiles(workspace) {
  return workspace?.state === "connected"
    && typeof workspace.sessionId === "string"
    && workspace.sessionId.length > 0
    && !workspace.sftpError;
}

export function isRemoteFileSessionCurrent(workspace, sessionId) {
  return typeof sessionId === "string"
    && sessionId.length > 0
    && workspace?.sessionId === sessionId;
}

export function isRemoteFileRequestCurrent(requestContext, currentContext) {
  return requestContext.treeKey === currentContext.treeKey
    && requestContext.sessionKey === currentContext.sessionKey;
}
export const STALE_REMOTE_FILE_REQUEST_CODE = "STALE_REMOTE_FILE_REQUEST";
