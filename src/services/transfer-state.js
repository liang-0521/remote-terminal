export function shouldRefreshRemoteDirectory(previousState, nextState) {
  return nextState === "success" && previousState !== "success";
}
