export class NativeClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeClientError";
    this.code = code;
  }
}

function unwrap(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new NativeClientError("INVALID_NATIVE_RESPONSE", "原生客户端返回了无法识别的响应。" );
  }
  if (!envelope.ok) {
    throw new NativeClientError(
      envelope.error?.code || "NATIVE_OPERATION_FAILED",
      envelope.error?.message || "原生操作失败。",
    );
  }
  return envelope.data;
}

function invoke(operation) {
  return Promise.resolve(operation()).then(unwrap);
}

export function isNativeRuntimeAvailable() {
  return window.remoteTerminal?.runtime?.kind === "electron"
    && window.remoteTerminal.runtime.version === 1;
}

export function isRunningInElectron() {
  return navigator.userAgent.includes("Electron");
}

export function getNativeClient() {
  if (!isNativeRuntimeAvailable()) {
    throw new NativeClientError("NATIVE_BRIDGE_UNAVAILABLE", "Electron 安全桥未正确加载。" );
  }
  const bridge = window.remoteTerminal;
  return Object.freeze({
    connections: Object.freeze({
      list: () => invoke(() => bridge.connections.list()),
      save: (connection) => invoke(() => bridge.connections.save(connection)),
      remove: (connectionId) => invoke(() => bridge.connections.remove(connectionId)),
    }),
    credentials: Object.freeze({
      status: () => invoke(() => bridge.credentials.status()),
      remove: (connectionId) => invoke(() => bridge.credentials.remove(connectionId)),
    }),
    hostKeys: Object.freeze({
      probe: (connectionId) => invoke(() => bridge.hostKeys.probe(connectionId)),
      accept: (challengeId) => invoke(() => bridge.hostKeys.accept(challengeId)),
    }),
    ssh: Object.freeze({
      connect: (payload) => invoke(() => bridge.ssh.connect(payload)),
      disconnect: (sessionId) => invoke(() => bridge.ssh.disconnect(sessionId)),
    }),
    terminal: Object.freeze({
      attach: (sessionId) => invoke(() => bridge.terminal.attach(sessionId)),
      write: (sessionId, data) => invoke(() => bridge.terminal.write(sessionId, data)),
      resize: (sessionId, dimensions) => invoke(() => bridge.terminal.resize(sessionId, dimensions)),
    }),
    clipboard: Object.freeze({
      readText: () => invoke(() => bridge.clipboard.readText()),
      writeText: (text) => invoke(() => bridge.clipboard.writeText(text)),
    }),
    sftp: Object.freeze({
      list: (sessionId, path) => invoke(() => bridge.sftp.list(sessionId, path)),
      upload: (sessionId, remoteDirectory, files) => invoke(() => bridge.sftp.upload(sessionId, remoteDirectory, files)),
      cancel: (transferId) => invoke(() => bridge.sftp.cancel(transferId)),
      retry: (transferId) => invoke(() => bridge.sftp.retry(transferId)),
    }),
    monitor: Object.freeze({
      sample: (sessionId) => invoke(() => bridge.monitor.sample(sessionId)),
    }),
    updates: Object.freeze({
      status: () => invoke(() => bridge.updates.status()),
      check: () => invoke(() => bridge.updates.check()),
      install: () => invoke(() => bridge.updates.install()),
    }),
    events: bridge.events,
  });
}
