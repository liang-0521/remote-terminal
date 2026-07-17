const TERMINAL_TRANSFER_STATES = new Set(["success", "failed", "cancelled"]);

export function shouldRefreshRemoteDirectory(previousState, nextState) {
  return nextState === "success" && previousState !== "success";
}

export function mergeDownloadProgressTransfer(previousTransfer, progressTransfer) {
  if (previousTransfer && TERMINAL_TRANSFER_STATES.has(previousTransfer.state)) {
    return previousTransfer;
  }
  return progressTransfer;
}
