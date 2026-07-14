import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import ssh2 from "ssh2";
import { AppError, toPublicError } from "./app-error.mjs";
import {
  validateId,
  validatePassword,
  validateRemotePath,
  validateTerminalData,
  validateTerminalDimensions,
  validateUploadFiles,
} from "./validation.mjs";

const { Client, utils } = ssh2;
const TERMINAL_BUFFER_LIMIT = 2 * 1024 * 1024;
const EXEC_OUTPUT_LIMIT = 2 * 1024 * 1024;
const MAX_UPLOAD_CONCURRENCY = 3;
const ACTIVE_TRANSFER_STATES = new Set(["queued", "uploading", "cancelling", "finalizing"]);

function hostFingerprintFromRawKey(rawKey) {
  const digest = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "");
  const parsed = utils.parseKey(rawKey);
  const algorithm = parsed instanceof Error ? "unknown" : parsed.type;
  return { algorithm, fingerprint: `SHA256:${digest}` };
}

function hostFingerprintFromHex(hexDigest) {
  return `SHA256:${Buffer.from(hexDigest, "hex").toString("base64").replace(/=+$/, "")}`;
}

function mapConnectionError(error, hostKeyMismatch = false) {
  if (hostKeyMismatch) {
    return new AppError("HOST_KEY_MISMATCH", "服务器主机指纹与已信任记录不一致，连接已阻断。", { cause: error });
  }
  if (error?.level === "client-authentication") {
    return new AppError("AUTH_FAILED", "用户名或密码验证失败。", { cause: error });
  }
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(error?.code)
    || error?.level === "client-socket") {
    return new AppError("NETWORK_FAILED", "无法连接服务器，请检查地址、端口和网络。", { cause: error });
  }
  return new AppError("HANDSHAKE_FAILED", "SSH 握手失败，服务器可能不支持当前协商算法。", { cause: error });
}

function isRemoteNotFound(error) {
  return error?.code === 2 || error?.code === "ENOENT";
}

function callbackResult(register, code, message, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = timeoutMs > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AppError(code, message));
    }, timeoutMs) : null;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(new AppError(code, message, { cause: error }));
      else resolve(value);
    };
    try {
      register(done);
    } catch (error) {
      done(error);
    }
  });
}

export class SshManager {
  #sessions = new Map();
  #transfers = new Map();
  #activeUploadsBySession = new Map();
  #emit;

  constructor(emit) {
    this.#emit = emit;
  }

  inspectHost(connection) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        client.destroy();
        reject(new AppError("HOST_PROBE_TIMEOUT", "获取服务器主机指纹超时。"));
      }, 12_000);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      client.on("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(mapConnectionError(error));
        }
      });
      client.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new AppError("HOST_PROBE_FAILED", "服务器在返回主机指纹前关闭了连接。"));
        }
      });

      client.connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        readyTimeout: 10_000,
        hostVerifier(rawKey) {
          const result = hostFingerprintFromRawKey(rawKey);
          finish(result);
          return false;
        },
      });
    });
  }

  connect({ connection, password, knownHost, dimensions }) {
    const secret = validatePassword(password);
    const { cols, rows } = validateTerminalDimensions(dimensions);
    if (!knownHost?.fingerprint) {
      throw new AppError("HOST_KEY_UNTRUSTED", "该服务器主机指纹尚未被信任。" );
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      const sessionId = crypto.randomUUID();
      let shell;
      let settled = false;
      let ready = false;
      let hostKeyMismatch = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        this.#sessions.delete(sessionId);
        shell?.destroy();
        client.destroy();
        reject(error instanceof AppError ? error : mapConnectionError(error, hostKeyMismatch));
      };

      client.on("ready", () => {
        ready = true;
        const shellTimeout = setTimeout(() => {
          fail(new AppError("SHELL_OPEN_TIMEOUT", "SSH 已连接，但打开交互终端超时。"));
        }, 10_000);
        client.shell({ term: "xterm-256color", cols, rows, width: 0, height: 0 }, (error, channel) => {
          clearTimeout(shellTimeout);
          if (settled) {
            channel?.destroy();
            return;
          }
          if (error) {
            fail(new AppError("SHELL_OPEN_FAILED", "SSH 已连接，但无法打开交互终端。", { cause: error }));
            return;
          }
          shell = channel;
          const session = {
            id: sessionId,
            connectionId: connection.id,
            client,
            shell,
            sftp: null,
            sftpPromise: null,
            attached: false,
            bufferedChunks: [],
            bufferedBytes: 0,
            closing: false,
          };
          this.#sessions.set(sessionId, session);
          this.#bindShell(session);

          this.#resolveRemoteHome(session)
            .then(({ home, sftpError }) => {
              if (settled) return;
              settled = true;
              resolve({
                sessionId,
                connectionId: connection.id,
                home,
                sftpError,
              });
              this.#emit("session-state", {
                sessionId,
                connectionId: connection.id,
                state: "connected",
              });
            });
        });
      });

      client.on("error", (error) => {
        if (!settled) {
          fail(mapConnectionError(error, hostKeyMismatch));
          return;
        }
        const session = this.#sessions.get(sessionId);
        if (session && !session.closing) {
          this.#emit("session-state", {
            sessionId,
            connectionId: connection.id,
            state: "error",
            error: toPublicError(mapConnectionError(error, hostKeyMismatch)),
          });
        }
      });

      client.on("close", () => {
        const session = this.#sessions.get(sessionId);
        if (!settled) {
          fail(new AppError("CONNECTION_CLOSED", ready
            ? "SSH 连接在终端初始化完成前关闭。"
            : "SSH 连接在认证完成前关闭。"));
          return;
        }
        if (session) {
          this.#abortSessionTransfers(sessionId);
          this.#sessions.delete(sessionId);
          this.#emit("session-state", {
            sessionId,
            connectionId: connection.id,
            state: "disconnected",
            expected: session.closing,
          });
        }
      });

      client.connect({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: secret,
        hostHash: "sha256",
        hostVerifier(hexDigest) {
          const actual = hostFingerprintFromHex(hexDigest);
          const accepted = actual === knownHost.fingerprint;
          hostKeyMismatch = !accepted;
          return accepted;
        },
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
      });
    });
  }

  async disconnect(sessionId) {
    const id = validateId(sessionId, "会话标识");
    const session = this.#sessions.get(id);
    if (!session) return { disconnected: false };
    session.closing = true;
    this.#abortSessionTransfers(id);
    session.shell.end();
    session.client.end();
    return { disconnected: true };
  }

  attachTerminal(sessionId) {
    const session = this.#getSession(sessionId);
    const initialData = session.bufferedBytes
      ? new Uint8Array(Buffer.concat(session.bufferedChunks, session.bufferedBytes))
      : new Uint8Array();
    session.bufferedChunks = [];
    session.bufferedBytes = 0;
    session.attached = true;
    return { sessionId: session.id, initialData };
  }

  async writeTerminal(sessionId, data) {
    const session = this.#getSession(sessionId);
    const input = validateTerminalData(data);
    if (!session.shell.writable) throw new AppError("SESSION_CLOSED", "终端会话已经关闭。" );
    if (session.shell.write(input)) return { accepted: true };
    await new Promise((resolve, reject) => {
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new AppError("SESSION_CLOSED", "终端会话在写入时关闭。")); };
      const cleanup = () => {
        session.shell.off("drain", onDrain);
        session.shell.off("close", onClose);
      };
      session.shell.once("drain", onDrain);
      session.shell.once("close", onClose);
    });
    return { accepted: true };
  }

  resizeTerminal(sessionId, dimensions) {
    const session = this.#getSession(sessionId);
    const { cols, rows } = validateTerminalDimensions(dimensions);
    session.shell.setWindow(rows, cols, 0, 0);
    return { cols, rows };
  }

  async listDirectory(sessionId, remotePath) {
    const session = this.#getSession(sessionId);
    const directory = validateRemotePath(remotePath);
    const sftp = await this.#getSftp(session);
    const list = await callbackResult(
      (done) => sftp.readdir(directory, done),
      "SFTP_LIST_FAILED",
      "无法读取远程目录，请检查路径和权限。",
    );
    const entries = list
      .filter((item) => item.filename !== "." && item.filename !== "..")
      .map((item) => ({
        name: item.filename,
        type: item.attrs.isDirectory()
          ? "directory"
          : item.attrs.isSymbolicLink()
            ? "symlink"
            : item.attrs.isFile()
              ? "file"
              : "other",
        size: item.attrs.size,
        modifiedAt: item.attrs.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : null,
      }))
      .sort((left, right) => {
        const leftDirectory = left.type === "directory" ? 0 : 1;
        const rightDirectory = right.type === "directory" ? 0 : 1;
        return leftDirectory - rightDirectory || left.name.localeCompare(right.name, "zh-CN");
      });
    return { path: directory, entries };
  }

  async uploadFiles(sessionId, remoteDirectory, files) {
    const session = this.#getSession(sessionId);
    const directory = validateRemotePath(remoteDirectory);
    const localFiles = validateUploadFiles(files);
    const sftp = await this.#getSftp(session);
    const preparedTransfers = [];
    const targetPaths = new Set();

    for (const file of localFiles) {
      const metadata = await lstat(file.localPath);
      if (!metadata.isFile()) {
        throw new AppError("INVALID_LOCAL_FILE", "只能上传普通文件，目录和符号链接暂不支持。" );
      }
      const fileName = path.basename(file.localPath);
      const targetPath = path.posix.join(directory, fileName);
      if (targetPaths.has(targetPath)) {
        throw new AppError("DUPLICATE_UPLOAD_TARGET", `所选文件中存在同名远程目标：${fileName}`);
      }
      targetPaths.add(targetPath);
      await this.#assertRemoteTargetAvailable(sftp, targetPath);
      const transfer = {
        id: crypto.randomUUID(),
        sessionId: session.id,
        connectionId: session.connectionId,
        localPath: file.localPath,
        fileName,
        target: targetPath,
        size: metadata.size,
        mode: metadata.mode & 0o777,
        state: "queued",
        transferred: 0,
        speed: 0,
        controller: null,
        temporaryPath: null,
        attemptId: null,
        runner: null,
      };
      preparedTransfers.push(transfer);
    }

    for (const transfer of preparedTransfers) {
      this.#transfers.set(transfer.id, transfer);
      this.#queueUpload(transfer);
    }
    return preparedTransfers.map((transfer) => this.#publicTransfer(transfer));
  }

  cancelTransfer(transferId) {
    const id = validateId(transferId, "传输标识");
    const transfer = this.#transfers.get(id);
    if (!transfer) throw new AppError("TRANSFER_NOT_FOUND", "未找到该传输任务。" );
    if (!["queued", "uploading"].includes(transfer.state)) {
      return this.#publicTransfer(transfer);
    }
    if (transfer.runner) {
      transfer.state = "cancelling";
      transfer.controller?.abort();
    } else {
      transfer.state = "cancelled";
    }
    this.#emitTransfer(transfer);
    return this.#publicTransfer(transfer);
  }

  retryTransfer(transferId) {
    const id = validateId(transferId, "传输标识");
    const transfer = this.#transfers.get(id);
    if (!transfer) throw new AppError("TRANSFER_NOT_FOUND", "未找到该传输任务。" );
    if (!["failed", "cancelled"].includes(transfer.state) || !transfer.localPath || transfer.runner) {
      throw new AppError("TRANSFER_NOT_RETRYABLE", "该传输任务当前不能重试。" );
    }
    this.#getSession(transfer.sessionId);
    this.#queueUpload(transfer);
    return this.#publicTransfer(transfer);
  }

  async exec(sessionId, command, { timeoutMs = 8_000, outputLimit = EXEC_OUTPUT_LIMIT } = {}) {
    const session = this.#getSession(sessionId);
    if (typeof command !== "string" || !command || command.length > 32_768) {
      throw new AppError("INVALID_INPUT", "远程命令格式不正确。" );
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeStream = null;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout = [];
      const stderr = [];
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        activeStream?.destroy();
        reject(new AppError("EXEC_TIMEOUT", "远程监控命令执行超时。"));
      }, timeoutMs);

      const finishError = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      session.client.exec(command, { pty: false }, (error, stream) => {
        if (error) {
          finishError(new AppError("EXEC_OPEN_FAILED", "无法打开远程监控命令通道。", { cause: error }));
          return;
        }
        activeStream = stream;
        const collect = (target, chunk, isStderr) => {
          if (settled) return;
          if (isStderr) stderrBytes += chunk.length;
          else stdoutBytes += chunk.length;
          if (stdoutBytes + stderrBytes > outputLimit) {
            stream.destroy();
            finishError(new AppError("EXEC_OUTPUT_LIMIT", "远程监控命令输出超过安全上限。"));
            return;
          }
          target.push(chunk);
        };
        stream.on("data", (chunk) => collect(stdout, chunk, false));
        stream.stderr.on("data", (chunk) => collect(stderr, chunk, true));
        stream.on("error", (streamError) => finishError(new AppError("EXEC_FAILED", "远程监控命令执行失败。", { cause: streamError })));
        stream.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const stderrText = Buffer.concat(stderr).toString("utf8").trim();
          if (typeof code === "number" && code !== 0) {
            reject(new AppError("EXEC_NONZERO", stderrText
              ? `远程监控命令失败：${stderrText.slice(0, 300)}`
              : `远程监控命令退出码为 ${code}。`));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: stderrText,
            code: typeof code === "number" ? code : null,
          });
        });
      });
    });
  }

  disconnectAll() {
    for (const session of this.#sessions.values()) {
      session.closing = true;
      this.#abortSessionTransfers(session.id);
      session.shell.end();
      session.client.end();
    }
  }

  hasActiveTransfers() {
    return [...this.#transfers.values()].some((transfer) => ACTIVE_TRANSFER_STATES.has(transfer.state));
  }

  #getSession(sessionId) {
    const id = validateId(sessionId, "会话标识");
    const session = this.#sessions.get(id);
    if (!session) throw new AppError("SESSION_CLOSED", "SSH 会话不存在或已经关闭。" );
    return session;
  }

  #bindShell(session) {
    const forward = (chunk) => {
      const bytes = Buffer.from(chunk);
      if (session.attached) {
        this.#emit("terminal-data", { sessionId: session.id, data: new Uint8Array(bytes) });
        return;
      }
      session.bufferedBytes += bytes.length;
      if (session.bufferedBytes > TERMINAL_BUFFER_LIMIT) {
        session.client.end();
        this.#emit("session-state", {
          sessionId: session.id,
          connectionId: session.connectionId,
          state: "error",
          error: {
            code: "TERMINAL_BUFFER_LIMIT",
            message: "终端初始化输出超过安全上限，会话已关闭。",
          },
        });
        return;
      }
      session.bufferedChunks.push(bytes);
    };
    session.shell.on("data", forward);
    session.shell.stderr?.on("data", forward);
    session.shell.on("close", () => {
      if (!session.closing) session.client.end();
    });
  }

  async #resolveRemoteHome(session) {
    try {
      const sftp = await this.#getSftp(session);
      const home = await callbackResult(
        (done) => sftp.realpath(".", done),
        "SFTP_HOME_FAILED",
        "SFTP 已启用，但无法获取远程主目录。",
        8_000,
      );
      return { home: validateRemotePath(home), sftpError: null };
    } catch (error) {
      return { home: null, sftpError: toPublicError(error) };
    }
  }

  async #getSftp(session) {
    if (session.sftp) return session.sftp;
    if (!session.sftpPromise) {
      session.sftpPromise = callbackResult(
        (done) => session.client.sftp(done),
        "SFTP_OPEN_FAILED",
        "服务器未启用 SFTP 或当前用户无权打开 SFTP。",
        10_000,
      ).then((sftp) => {
        session.sftp = sftp;
        return sftp;
      }).finally(() => {
        session.sftpPromise = null;
      });
    }
    return session.sftpPromise;
  }

  async #assertRemoteTargetAvailable(sftp, targetPath) {
    await new Promise((resolve, reject) => {
      sftp.lstat(targetPath, (error) => {
        if (!error) {
          reject(new AppError("REMOTE_FILE_EXISTS", `远程目标已存在：${path.posix.basename(targetPath)}`));
          return;
        }
        if (isRemoteNotFound(error)) resolve();
        else reject(new AppError("SFTP_STAT_FAILED", "无法检查远程目标是否已存在。", { cause: error }));
      });
    });
  }

  #queueUpload(transfer) {
    transfer.attemptId = crypto.randomUUID();
    transfer.state = "queued";
    transfer.error = null;
    transfer.transferred = 0;
    transfer.speed = 0;
    transfer.controller = null;
    transfer.temporaryPath = null;
    this.#emitTransfer(transfer);
    this.#pumpUploads(transfer.sessionId);
  }

  #pumpUploads(sessionId) {
    let active = this.#activeUploadsBySession.get(sessionId) || 0;
    if (active >= MAX_UPLOAD_CONCURRENCY) return;
    const queued = [...this.#transfers.values()]
      .filter((transfer) => transfer.sessionId === sessionId && transfer.state === "queued" && !transfer.runner);
    for (const transfer of queued) {
      if (active >= MAX_UPLOAD_CONCURRENCY) break;
      const attemptId = transfer.attemptId;
      active += 1;
      this.#activeUploadsBySession.set(sessionId, active);
      transfer.runner = this.#runUpload(transfer, attemptId)
        .finally(() => {
          if (transfer.attemptId === attemptId) transfer.runner = null;
          const remaining = Math.max(0, (this.#activeUploadsBySession.get(sessionId) || 1) - 1);
          if (remaining) this.#activeUploadsBySession.set(sessionId, remaining);
          else this.#activeUploadsBySession.delete(sessionId);
          this.#pumpUploads(sessionId);
        });
    }
  }

  async #runUpload(transfer, attemptId) {
    let sftp = null;
    const ensureCurrent = () => {
      if (transfer.attemptId !== attemptId) {
        throw new AppError("TRANSFER_SUPERSEDED", "传输任务已被新的重试替代。" );
      }
      if (["cancelling", "cancelled"].includes(transfer.state)) {
        throw new AppError("TRANSFER_CANCELLED", "传输已取消。" );
      }
    };

    try {
      const session = this.#getSession(transfer.sessionId);
      sftp = await this.#getSftp(session);
      ensureCurrent();
      await this.#assertRemoteTargetAvailable(sftp, transfer.target);
      ensureCurrent();
      transfer.state = "uploading";
      transfer.controller = new AbortController();
      transfer.temporaryPath = path.posix.join(
        path.posix.dirname(transfer.target),
        `.${transfer.fileName}.${crypto.randomUUID()}.part`,
      );
      const startedAt = Date.now();
      let lastEventAt = 0;
      const progress = new Transform({
        transform: (chunk, encoding, callback) => {
          transfer.transferred += chunk.length;
          const now = Date.now();
          transfer.speed = transfer.transferred / Math.max((now - startedAt) / 1000, 0.001);
          if (now - lastEventAt >= 120) {
            lastEventAt = now;
            this.#emitTransfer(transfer);
          }
          callback(null, chunk);
        },
      });
      this.#emitTransfer(transfer);
      await pipeline(
        createReadStream(transfer.localPath),
        progress,
        sftp.createWriteStream(transfer.temporaryPath, { flags: "wx", mode: transfer.mode }),
        { signal: transfer.controller.signal },
      );
      ensureCurrent();
      transfer.state = "finalizing";
      transfer.controller = null;
      this.#emitTransfer(transfer);
      await callbackResult(
        (done) => sftp.rename(transfer.temporaryPath, transfer.target, done),
        "SFTP_RENAME_FAILED",
        "文件已上传，但无法完成远程原子重命名。",
      );
      ensureCurrent();
      transfer.state = "success";
      transfer.transferred = transfer.size;
      transfer.speed = transfer.size / Math.max((Date.now() - startedAt) / 1000, 0.001);
      transfer.localPath = null;
      transfer.temporaryPath = null;
      transfer.controller = null;
      this.#emitTransfer(transfer);
    } catch (error) {
      if (transfer.attemptId !== attemptId) return;
      const cancelled = ["cancelling", "cancelled"].includes(transfer.state)
        || error?.code === "TRANSFER_CANCELLED"
        || error?.name === "AbortError"
        || error?.code === "ABORT_ERR";
      const temporaryPath = transfer.temporaryPath;
      transfer.state = cancelled ? "cancelled" : "failed";
      transfer.error = cancelled ? null : toPublicError(error instanceof AppError
        ? error
        : new AppError("SFTP_UPLOAD_FAILED", "上传失败，未生成最终远程文件。", { cause: error }));
      transfer.controller = null;
      if (temporaryPath && sftp) {
        const cleanupError = await new Promise((resolve) => sftp.unlink(temporaryPath, (unlinkError) => resolve(unlinkError)));
        if (cleanupError && !isRemoteNotFound(cleanupError)) {
          transfer.error = {
            code: "SFTP_CLEANUP_FAILED",
            message: `上传未完成，且远程临时文件清理失败：${path.posix.basename(temporaryPath)}`,
          };
        }
      }
      transfer.temporaryPath = null;
      this.#emitTransfer(transfer);
    }
  }

  #publicTransfer(transfer) {
    return {
      id: transfer.id,
      sessionId: transfer.sessionId,
      connectionId: transfer.connectionId,
      fileName: transfer.fileName,
      target: transfer.target,
      size: transfer.size,
      transferred: transfer.transferred,
      speed: transfer.speed,
      progress: transfer.size === 0 ? (transfer.state === "success" ? 100 : 0) : Math.min(100, (transfer.transferred / transfer.size) * 100),
      state: transfer.state,
      error: transfer.error || null,
    };
  }

  #emitTransfer(transfer) {
    this.#emit("transfer-progress", this.#publicTransfer(transfer));
  }

  #abortSessionTransfers(sessionId) {
    for (const transfer of this.#transfers.values()) {
      if (transfer.sessionId === sessionId && ["queued", "uploading"].includes(transfer.state)) {
        if (transfer.runner) {
          transfer.state = "cancelling";
          transfer.controller?.abort();
        } else {
          transfer.state = "cancelled";
        }
        this.#emitTransfer(transfer);
      }
    }
  }
}
