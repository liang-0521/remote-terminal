// PTY dimensions and input share one queue: an editor must see the fitted size
// before receiving the keystrokes that open it. Every request belongs to one SSH session.
export function createTerminalTransport({ getSessionId, write, resize }) {
  let queue = Promise.resolve();
  let lastSizeRequest = null;

  function enqueue(sessionId, operation) {
    const request = queue.then(() => {
      if (!sessionId || getSessionId() !== sessionId) {
        throw new Error("SSH 会话当前不可用。");
      }
      return operation(sessionId);
    });
    // The caller receives the original rejection; keep subsequent operations usable.
    queue = request.catch(() => undefined);
    return request;
  }

  return {
    write(data) {
      return enqueue(getSessionId(), (sessionId) => write(sessionId, data));
    },
    resize({ cols, rows }) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) {
        return Promise.reject(new TypeError("终端尺寸无效。"));
      }
      const sessionId = getSessionId();
      if (sessionId && lastSizeRequest?.sessionId === sessionId
        && lastSizeRequest.cols === cols && lastSizeRequest.rows === rows) {
        return lastSizeRequest.promise;
      }
      const entry = { sessionId, cols, rows };
      entry.promise = enqueue(sessionId, (id) => resize(id, { cols, rows }))
        .catch((error) => {
          if (lastSizeRequest === entry) lastSizeRequest = null;
          throw error;
        });
      lastSizeRequest = entry;
      return entry.promise;
    },
  };
}
