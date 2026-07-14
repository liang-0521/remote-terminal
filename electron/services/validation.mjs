import path from "node:path";
import { AppError } from "./app-error.mjs";

const ID_PATTERN = /^[0-9a-f-]{36}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", `${label}格式不正确。`);
  }
  return value;
}

function requireString(value, label, { min = 1, max = 256, allowWhitespace = true } = {}) {
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new AppError("INVALID_INPUT", `${label}长度必须在 ${min}–${max} 个字符之间。`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new AppError("INVALID_INPUT", `${label}不能包含控制字符。`);
  }
  if (!allowWhitespace && /\s/.test(normalized)) {
    throw new AppError("INVALID_INPUT", `${label}不能包含空白字符。`);
  }
  return normalized;
}

export function validateConnectionDraft(payload) {
  const input = requireObject(payload, "连接配置");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError("INVALID_INPUT", "端口必须是 1–65535 的整数。");
  }
  if (input.authMethod !== "password") {
    throw new AppError("UNSUPPORTED_AUTH_METHOD", "首版原生客户端仅支持密码认证。");
  }

  return {
    name: requireString(input.name, "连接名称", { max: 80 }),
    group: requireString(input.group || "未分组", "分组", { max: 80 }),
    host: requireString(input.host, "主机地址", { max: 253, allowWhitespace: false }),
    port,
    username: requireString(input.username, "用户名", { max: 128, allowWhitespace: false }),
    authMethod: "password",
  };
}

export function validateId(value, label = "标识") {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AppError("INVALID_INPUT", `${label}格式不正确。`);
  }
  return value;
}

export function validatePassword(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new AppError("INVALID_INPUT", "密码不能为空且不能超过 4096 个字符。");
  }
  return value;
}

export function validateTerminalData(value) {
  if (typeof value !== "string" || value.length > 65_536) {
    throw new AppError("INVALID_INPUT", "终端输入格式不正确或单次输入过大。");
  }
  return value;
}

export function validateTerminalDimensions(payload) {
  const input = requireObject(payload, "终端尺寸");
  const cols = Number(input.cols);
  const rows = Number(input.rows);
  if (!Number.isInteger(cols) || cols < 2 || cols > 1000) {
    throw new AppError("INVALID_INPUT", "终端列数必须是 2–1000 的整数。");
  }
  if (!Number.isInteger(rows) || rows < 1 || rows > 500) {
    throw new AppError("INVALID_INPUT", "终端行数必须是 1–500 的整数。");
  }
  return { cols, rows };
}

export function validateRemotePath(value) {
  const remotePath = requireString(value, "远程路径", { max: 4096 });
  if (!remotePath.startsWith("/")) {
    throw new AppError("INVALID_REMOTE_PATH", "远程路径必须是绝对路径。");
  }
  const normalized = path.posix.normalize(remotePath);
  if (!normalized.startsWith("/")) {
    throw new AppError("INVALID_REMOTE_PATH", "远程路径超出允许范围。");
  }
  return normalized;
}

export function validateUploadFiles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new AppError("INVALID_INPUT", "每次必须选择 1–100 个本地文件。");
  }
  return value.map((item) => {
    const input = requireObject(item, "本地文件");
    const localPath = requireString(input.localPath, "本地文件路径", { max: 32_767 });
    if (!path.isAbsolute(localPath)) {
      throw new AppError("INVALID_LOCAL_FILE", "本地文件路径必须是绝对路径。" );
    }
    return {
      localPath,
    };
  });
}
