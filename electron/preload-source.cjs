"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");
const channels = require("./ipc/channels.cjs");

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("事件订阅必须提供回调函数");
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function prepareLocalFiles(files) {
  const values = Array.from(files || []);
  const result = [];
  for (const file of values) {
    const localPath = webUtils.getPathForFile(file);
    if (!localPath) {
      return {
        ok: false,
        error: { code: "LOCAL_FILE_PATH_UNAVAILABLE", message: "无法读取该本地文件的磁盘路径。" },
      };
    }
    result.push({ localPath });
  }
  return { ok: true, files: result };
}

const api = Object.freeze({
  runtime: Object.freeze({ kind: "electron", version: 1 }),
  connections: Object.freeze({
    list: () => invoke(channels.connectionsList),
    save: (connection) => invoke(channels.connectionsSave, connection),
    remove: (connectionId) => invoke(channels.connectionsRemove, { connectionId }),
  }),
  credentials: Object.freeze({
    status: () => invoke(channels.credentialsStatus),
    remove: (connectionId) => invoke(channels.credentialsRemove, { connectionId }),
  }),
  hostKeys: Object.freeze({
    probe: (connectionId) => invoke(channels.hostKeysProbe, { connectionId }),
    accept: (challengeId) => invoke(channels.hostKeysAccept, { challengeId }),
  }),
  ssh: Object.freeze({
    connect: (payload) => invoke(channels.sshConnect, payload),
    disconnect: (sessionId) => invoke(channels.sshDisconnect, { sessionId }),
  }),
  terminal: Object.freeze({
    attach: (sessionId) => invoke(channels.terminalAttach, { sessionId }),
    write: (sessionId, data) => invoke(channels.terminalWrite, { sessionId, data }),
    resize: (sessionId, dimensions) => invoke(channels.terminalResize, { sessionId, ...dimensions }),
  }),
  clipboard: Object.freeze({
    readText: () => invoke(channels.clipboardReadText),
    writeText: (text) => invoke(channels.clipboardWriteText, { text }),
  }),
  sftp: Object.freeze({
    list: (sessionId, remotePath) => invoke(channels.sftpList, { sessionId, path: remotePath }),
    upload: (sessionId, remoteDirectory, files) => {
      const prepared = prepareLocalFiles(files);
      if (!prepared.ok) return Promise.resolve(prepared);
      return invoke(channels.sftpUpload, { sessionId, remoteDirectory, files: prepared.files });
    },
    cancel: (transferId) => invoke(channels.sftpCancel, { transferId }),
    retry: (transferId) => invoke(channels.sftpRetry, { transferId }),
  }),
  monitor: Object.freeze({
    sample: (sessionId) => invoke(channels.monitorSample, { sessionId }),
  }),
  updates: Object.freeze({
    status: () => invoke(channels.updatesStatus),
    check: () => invoke(channels.updatesCheck),
    install: () => invoke(channels.updatesInstall),
  }),
  events: Object.freeze({
    onTerminalData: (callback) => subscribe(channels.terminalData, callback),
    onSessionState: (callback) => subscribe(channels.sessionState, callback),
    onTransferProgress: (callback) => subscribe(channels.transferProgress, callback),
    onUpdateStatus: (callback) => subscribe(channels.updateStatus, callback),
  }),
});

contextBridge.exposeInMainWorld("remoteTerminal", api);
