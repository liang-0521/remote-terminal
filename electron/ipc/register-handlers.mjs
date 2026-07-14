import channels from "./channels.cjs";
import { AppError, toPublicError } from "../services/app-error.mjs";
import { validateId, validatePassword } from "../services/validation.mjs";

// xterm may wrap pasted text with bracketed-paste markers before terminal IPC.
const MAX_CLIPBOARD_TEXT_LENGTH = 65_520;

function validateNoPayload(value, label) {
  if (value !== undefined) {
    throw new AppError("INVALID_INPUT", `${label}请求不能包含参数。`);
  }
}

function validateClipboardText(value) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", "剪贴板内容必须是文本。" );
  }
  if (value.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    throw new AppError("CLIPBOARD_TOO_LARGE", "剪贴板文本不能超过 65,520 个字符。" );
  }
  return value;
}

function validateClipboardWriteRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", "写入剪贴板请求格式不正确。" );
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new AppError("INVALID_INPUT", "写入剪贴板请求只能包含 text 字段。" );
  }
  return validateClipboardText(value.text);
}

function assertTrustedHostKey(result) {
  if (result?.status === "trusted") return;
  if (result?.status === "mismatch") {
    throw new AppError("HOST_KEY_MISMATCH", "服务器主机指纹与已信任记录不一致，连接已阻断。" );
  }
  if (result?.status === "unknown") {
    throw new AppError("HOST_KEY_UNTRUSTED", "服务器主机指纹尚未确认，请先核对并信任该指纹。" );
  }
  throw new AppError("HOST_KEY_UNTRUSTED", "服务器主机指纹未通过信任检查。" );
}

function validateCredentialRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", "SSH 凭证请求格式不正确。" );
  }
  if (value.source === "saved") return { source: "saved" };
  if (value.source !== "provided" || typeof value.saveAfterConnect !== "boolean") {
    throw new AppError("INVALID_INPUT", "SSH 凭证来源格式不正确。" );
  }
  return {
    source: "provided",
    password: validatePassword(value.password),
    saveAfterConnect: value.saveAfterConnect,
  };
}

function validateSender(event, window, development) {
  if (!window || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new AppError("IPC_FORBIDDEN", "已拒绝来自非主窗口的客户端请求。" );
  }

  const url = new URL(event.senderFrame.url);
  const allowed = development
    ? url.origin === "http://127.0.0.1:4173"
    : url.protocol === "app:" && url.host === "renderer";
  if (!allowed) throw new AppError("IPC_FORBIDDEN", "已拒绝来自未知页面的客户端请求。" );
}

export function registerIpcHandlers({
  ipcMain,
  clipboard,
  getWindow,
  development,
  connections,
  credentials,
  knownHosts,
  hostKeys,
  ssh,
  monitor,
  updates,
}) {
  const register = (channel, handler) => {
    ipcMain.handle(channel, async (event, payload) => {
      try {
        validateSender(event, getWindow(), development);
        return { ok: true, data: await handler(payload) };
      } catch (error) {
        return { ok: false, error: toPublicError(error) };
      }
    });
  };

  register(channels.connectionsList, async () => {
    const items = await connections.list();
    const savedIds = await credentials.savedIds(items.map((item) => item.id));
    return items.map((item) => ({ ...item, hasSavedPassword: savedIds.has(item.id) }));
  });
  register(channels.connectionsSave, (payload) => connections.save(payload));
  register(channels.connectionsRemove, async (payload) => {
    const connectionId = validateId(payload?.connectionId, "连接标识");
    await connections.get(connectionId);
    await credentials.remove(connectionId);
    return connections.remove(connectionId);
  });
  register(channels.credentialsStatus, () => credentials.status());
  register(channels.credentialsRemove, async (payload) => {
    const connectionId = validateId(payload?.connectionId, "连接标识");
    await connections.get(connectionId);
    return credentials.remove(connectionId);
  });
  register(channels.hostKeysProbe, (payload) => hostKeys.probe(payload?.connectionId));
  register(channels.hostKeysAccept, (payload) => hostKeys.accept(payload?.challengeId));
  register(channels.sshConnect, async (payload) => {
    const connectionId = validateId(payload?.connectionId, "连接标识");
    const credential = validateCredentialRequest(payload?.credential);
    const hostKeyResult = await hostKeys.probe(connectionId);
    assertTrustedHostKey(hostKeyResult);
    const connection = await connections.get(connectionId);
    const knownHost = await knownHosts.get(connection.host, connection.port);
    const password = credential.source === "saved"
      ? await credentials.get(connectionId)
      : credential.password;
    const result = await ssh.connect({
      connection,
      knownHost,
      password,
      dimensions: payload?.dimensions,
    });
    if (credential.source !== "provided" || !credential.saveAfterConnect) {
      return { ...result, credentialPersistence: { state: "not-requested" } };
    }
    try {
      await credentials.save(connectionId, credential.password);
      return { ...result, credentialPersistence: { state: "saved" } };
    } catch (error) {
      return {
        ...result,
        credentialPersistence: { state: "failed", error: toPublicError(error) },
      };
    }
  });
  register(channels.sshDisconnect, (payload) => ssh.disconnect(payload?.sessionId));
  register(channels.terminalAttach, (payload) => ssh.attachTerminal(payload?.sessionId));
  register(channels.terminalWrite, (payload) => ssh.writeTerminal(payload?.sessionId, payload?.data));
  register(channels.terminalResize, (payload) => ssh.resizeTerminal(payload?.sessionId, payload));
  register(channels.clipboardReadText, (payload) => {
    validateNoPayload(payload, "读取剪贴板");
    return validateClipboardText(clipboard.readText());
  });
  register(channels.clipboardWriteText, (payload) => {
    clipboard.writeText(validateClipboardWriteRequest(payload));
    return { written: true };
  });
  register(channels.sftpList, (payload) => ssh.listDirectory(payload?.sessionId, payload?.path));
  register(channels.sftpUpload, (payload) => ssh.uploadFiles(payload?.sessionId, payload?.remoteDirectory, payload?.files));
  register(channels.sftpCancel, (payload) => ssh.cancelTransfer(payload?.transferId));
  register(channels.sftpRetry, (payload) => ssh.retryTransfer(payload?.transferId));
  register(channels.monitorSample, (payload) => monitor.sample(payload?.sessionId));
  register(channels.updatesStatus, () => updates.getState());
  register(channels.updatesCheck, () => updates.check());
  register(channels.updatesInstall, () => updates.install());
}
