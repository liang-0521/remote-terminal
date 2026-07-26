const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SHELL_OPERATOR = /(?:[;&|`]|\$\()/;
const MAX_REMOTE_PATH_BYTES = 4096;

function invalidPathInput(message) {
  const error = new Error(message);
  error.code = "INVALID_REMOTE_PATH_INPUT";
  return error;
}

function unwrapQuotedPath(value) {
  const quote = value[0];
  if (!["'", '"'].includes(quote)) return value;
  if (value.length < 2 || value.at(-1) !== quote) {
    throw invalidPathInput("cd 路径的引号没有闭合。");
  }
  return value.slice(1, -1);
}

function normalizeRemotePath(value) {
  const segments = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) {
        throw invalidPathInput("远程路径不能越过根目录。");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.length ? `/${segments.join("/")}` : "/";
  if (new TextEncoder().encode(normalized).length > MAX_REMOTE_PATH_BYTES) {
    throw invalidPathInput("远程路径不能超过 4096 字节。");
  }
  return normalized;
}

export function parseRemotePathInput(value, currentPath) {
  const input = String(value || "").trim();
  if (!input) throw invalidPathInput("请输入远程路径。");
  if (CONTROL_CHARACTER.test(input)) throw invalidPathInput("远程路径不能包含控制字符。");

  const cdInput = /^cd(?:\s|$)/.test(input);
  if (!cdInput) {
    if (!input.startsWith("/")) {
      throw invalidPathInput("请输入绝对路径，或使用 cd 路径。");
    }
    return normalizeRemotePath(input);
  }

  let argument = input.slice(2).trim();
  if (/^--(?:\s|$)/.test(argument)) argument = argument.slice(2).trim();
  if (!argument) throw invalidPathInput("cd 后请输入目标路径。");
  argument = unwrapQuotedPath(argument);
  if (!argument) throw invalidPathInput("cd 后请输入目标路径。");
  if (argument === "-" || argument === "~" || argument.startsWith("~/")) {
    throw invalidPathInput("此处暂不支持 cd - 或 cd ~，请填写具体路径。");
  }
  if (SHELL_OPERATOR.test(argument)) {
    throw invalidPathInput("路径框只支持单个 cd 路径，不能执行组合命令。");
  }

  if (argument.startsWith("/")) return normalizeRemotePath(argument);
  if (typeof currentPath !== "string" || !currentPath.startsWith("/")) {
    throw invalidPathInput("当前远程目录不可用，无法解析相对路径。");
  }
  return normalizeRemotePath(`${currentPath}/${argument}`);
}
