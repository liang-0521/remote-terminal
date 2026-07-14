const DEFAULT_RESULT_LIMIT = 8;
const MAX_TRACKED_TERMINAL_INPUT = 2_048;
const CLEAR_CURRENT_TERMINAL_LINE = "\u0001\u000b";

export const COMMAND_COMPLETIONS = Object.freeze([
  {
    command: "ls -lah",
    description: "查看当前目录详细内容",
    group: "文件",
    keywords: ["ll", "ls", "目录列表", "文件列表", "列出文件", "查看目录", "查看文件"],
  },
  {
    command: "cd /var/log",
    description: "进入系统日志目录",
    group: "文件",
    keywords: ["cd", "切换目录", "日志目录"],
  },
  {
    command: "find . -type f -name '*.log'",
    description: "按名称查找日志文件",
    group: "文件",
    keywords: ["find", "查找文件", "搜索文件", "日志文件"],
  },
  {
    command: "grep -Rni -- 'ERROR' .",
    description: "递归查找错误内容",
    group: "文件",
    keywords: ["grep", "搜索内容", "查找文本", "错误"],
  },
  {
    command: "tail -f /var/log/messages",
    description: "持续查看系统日志",
    group: "日志",
    keywords: ["tail", "实时日志", "跟踪日志"],
  },
  {
    command: "journalctl -xe",
    description: "查看近期系统错误",
    group: "日志",
    keywords: ["journalctl", "系统日志", "错误日志"],
  },
  {
    command: "journalctl -u nginx -f",
    description: "持续查看 nginx 服务日志",
    group: "日志",
    keywords: ["journalctl", "nginx", "服务日志", "实时日志"],
  },
  {
    command: "systemctl status nginx",
    description: "查看 nginx 服务状态",
    group: "服务",
    keywords: ["systemctl", "nginx", "服务状态"],
  },
  {
    command: "systemctl list-units --failed",
    description: "查看启动失败的服务",
    group: "服务",
    keywords: ["systemctl", "失败服务", "异常服务"],
  },
  {
    command: "ps aux --sort=-%cpu | head",
    description: "查看 CPU 占用最高的进程",
    group: "性能",
    keywords: ["ps", "cpu", "进程", "进程排行"],
  },
  {
    command: "free -h",
    description: "查看内存与 Swap",
    group: "性能",
    keywords: ["free", "内存", "swap", "交换空间"],
  },
  {
    command: "df -h",
    description: "查看文件系统容量",
    group: "性能",
    keywords: ["df", "磁盘", "磁盘容量", "文件系统"],
  },
  {
    command: "ss -lntp",
    description: "查看正在监听的 TCP 端口",
    group: "网络",
    keywords: ["ss", "tcp", "端口", "监听端口"],
  },
  {
    command: "ip address",
    description: "查看网络接口与地址",
    group: "网络",
    keywords: ["ip", "ip地址", "网卡", "网络接口"],
  },
  {
    command: "docker ps",
    description: "查看运行中的容器",
    group: "容器",
    keywords: ["docker", "容器列表", "运行容器"],
  },
  {
    command: "docker compose ps",
    description: "查看 Compose 服务状态",
    group: "容器",
    keywords: ["docker", "compose", "容器编排", "服务状态"],
  },
].map((completion) => Object.freeze({
  ...completion,
  source: "builtin",
  sourceLabel: "内置语义",
})));

const SOURCE_DETAILS = Object.freeze({
  builtin: Object.freeze({ label: "内置语义", group: "内置语义", priority: 2 }),
  "remote-command": Object.freeze({ label: "远端命令", group: "远端命令", priority: 0 }),
  history: Object.freeze({ label: "Shell 历史", group: "Shell 历史", priority: 1 }),
  directory: Object.freeze({ label: "当前目录", group: "当前目录", priority: 3 }),
});

const INVALID_TERMINAL_TEXT = /[\u0000-\u001f\u007f]/;
const SAFE_POSIX_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

function sourceDetails(source) {
  return SOURCE_DETAILS[source] || { label: "服务器补全", group: "服务器补全", priority: 4 };
}

function normalizeKeywords(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === "string" && value.trim() && !INVALID_TERMINAL_TEXT.test(value))
    .map((value) => value.trim());
}

function normalizeDynamicCompletion(item) {
  if (!item || typeof item !== "object" || typeof item.command !== "string") return null;
  const command = item.command.trim();
  if (!command || command.length > 2_048 || INVALID_TERMINAL_TEXT.test(command)) return null;
  const source = typeof item.source === "string" && item.source.trim()
    ? item.source.trim()
    : "remote-command";
  const details = sourceDetails(source);
  const description = typeof item.description === "string" && item.description.trim()
    ? item.description.trim()
    : source === "history"
      ? "该服务器账户的 Shell 历史命令"
      : `远端可执行命令：${command}`;
  return {
    command,
    description,
    group: typeof item.group === "string" && item.group.trim() ? item.group.trim() : details.group,
    keywords: normalizeKeywords(item.keywords),
    source,
    sourceLabel: details.label,
  };
}

function completionKey(command) {
  return command.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function mergeKeywords(left = [], right = []) {
  return [...new Set([...left, ...right])];
}

function deduplicateCompletions(completions) {
  const byCommand = new Map();
  for (const completion of completions) {
    if (!completion) continue;
    const key = completionKey(completion.command);
    const existing = byCommand.get(key);
    if (!existing) {
      byCommand.set(key, completion);
      continue;
    }
    const existingPriority = sourceDetails(existing.source).priority;
    const candidatePriority = sourceDetails(completion.source).priority;
    const primary = candidatePriority < existingPriority ? completion : existing;
    const secondary = primary === existing ? completion : existing;
    byCommand.set(key, {
      ...primary,
      description: primary.description || secondary.description,
      keywords: mergeKeywords(primary.keywords, secondary.keywords),
    });
  }
  return [...byCommand.values()];
}

export function quotePosixShellArgument(value) {
  if (typeof value !== "string" || !value || INVALID_TERMINAL_TEXT.test(value)) {
    throw new TypeError("远程目录项名称包含无法安全插入终端的字符");
  }
  if (SAFE_POSIX_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createDirectoryCompletions(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry.name !== "string") return [];
    const name = entry.name;
    if (!name || name === "." || name === ".." || name.includes("/") || INVALID_TERMINAL_TEXT.test(name)) return [];
    const argument = quotePosixShellArgument(name);
    const isDirectory = entry.type === "directory";
    return [{
      command: isDirectory ? `cd -- ${argument}` : `ls -lah -- ${argument}`,
      description: isDirectory ? `进入当前目录中的文件夹：${name}` : `查看当前目录中的文件：${name}`,
      group: "当前目录",
      keywords: [name, "当前目录", isDirectory ? "文件夹" : "文件", isDirectory ? "进入目录" : "查看文件"],
      source: "directory",
      sourceLabel: "当前目录",
    }];
  });
}

export function buildCommandCompletionCatalog({ remoteCompletions = [], directoryEntries = [] } = {}) {
  const remote = Array.isArray(remoteCompletions)
    ? remoteCompletions.map(normalizeDynamicCompletion).filter(Boolean)
    : [];
  return deduplicateCompletions([
    ...COMMAND_COMPLETIONS,
    ...remote,
    ...createDirectoryCompletions(directoryEntries),
  ]);
}

const FIELD_PRIORITY = Object.freeze({
  command: 0,
  keyword: 1,
  description: 2,
  group: 3,
});

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("zh-CN");
}

function searchableFields(completion) {
  return [
    { type: "command", value: completion.command },
    ...(completion.keywords ?? []).map((value) => ({ type: "keyword", value })),
    { type: "description", value: completion.description },
    { type: "group", value: completion.group },
  ].map((field) => ({ ...field, normalized: normalizeSearchText(field.value) }));
}

function bestDirectMatch(fields, query, predicate) {
  return fields
    .filter((field) => predicate(field.normalized, query))
    .map((field) => ({
      fieldPriority: FIELD_PRIORITY[field.type],
      matchIndex: field.normalized.indexOf(query),
    }))
    .sort((left, right) => left.fieldPriority - right.fieldPriority || left.matchIndex - right.matchIndex)[0];
}

function keywordScore(fields, tokens) {
  let score = 0;
  for (const token of tokens) {
    const matches = fields
      .map((field) => ({
        fieldPriority: FIELD_PRIORITY[field.type],
        matchIndex: field.normalized.indexOf(token),
      }))
      .filter((match) => match.matchIndex >= 0)
      .sort((left, right) => left.fieldPriority - right.fieldPriority || left.matchIndex - right.matchIndex);
    if (!matches.length) return null;
    score += (matches[0].fieldPriority * 100) + matches[0].matchIndex;
  }
  return score;
}

function rankCompletion(completion, query, sourceIndex) {
  const fields = searchableFields(completion);
  const exact = bestDirectMatch(fields, query, (value, normalizedQuery) => value === normalizedQuery);
  if (exact) {
    return { completion, matchType: "exact", tier: 0, detail: exact.fieldPriority, sourceIndex };
  }

  const prefix = bestDirectMatch(fields, query, (value, normalizedQuery) => value.startsWith(normalizedQuery));
  if (prefix) {
    return { completion, matchType: "prefix", tier: 1, detail: prefix.fieldPriority, sourceIndex };
  }

  const detail = keywordScore(fields, query.split(" "));
  if (detail === null) return null;
  return { completion, matchType: "keyword", tier: 2, detail, sourceIndex };
}

export function searchCommandCompletions(
  query,
  { completions = COMMAND_COMPLETIONS, limit = DEFAULT_RESULT_LIMIT } = {},
) {
  const normalizedQuery = normalizeSearchText(query);
  const resultLimit = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_RESULT_LIMIT;
  if (!normalizedQuery) {
    return completions.slice(0, resultLimit).map((completion) => ({ ...completion, matchType: "default" }));
  }

  return completions
    .map((completion, sourceIndex) => rankCompletion(completion, normalizedQuery, sourceIndex))
    .filter(Boolean)
    .sort((left, right) => (
      left.tier - right.tier
      || left.detail - right.detail
      || left.sourceIndex - right.sourceIndex
    ))
    .slice(0, resultLimit)
    .map(({ completion, matchType }) => ({ ...completion, matchType }));
}

export function nextCommandCompletionIndex(currentIndex, key, length) {
  if (!Number.isInteger(length) || length <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (!["ArrowDown", "ArrowUp"].includes(key)) return null;
  const safeIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < length
    ? currentIndex
    : 0;
  return (safeIndex + (key === "ArrowDown" ? 1 : -1) + length) % length;
}

export function createTerminalInputState() {
  return { reliable: true, text: "" };
}

export function advanceTerminalInputState(state, data) {
  if (!state || typeof state.reliable !== "boolean" || typeof state.text !== "string") {
    throw new TypeError("终端输入状态无效");
  }
  if (typeof data !== "string") throw new TypeError("终端输入数据必须是字符串");

  let next = { reliable: state.reliable, text: state.text };
  for (const character of data) {
    if (["\r", "\n", "\u0003"].includes(character)) {
      next = createTerminalInputState();
      continue;
    }
    if (!next.reliable) continue;
    if (["\b", "\u007f"].includes(character)) {
      next.text = Array.from(next.text).slice(0, -1).join("");
      continue;
    }
    if (character === "\u0015") {
      next.text = "";
      continue;
    }
    if (character < " " || character === "\u007f") {
      next = { reliable: false, text: "" };
      continue;
    }
    next.text += character;
    if (next.text.length > MAX_TRACKED_TERMINAL_INPUT) {
      next = { reliable: false, text: "" };
    }
  }
  return next;
}

export function createTerminalCompletionInput(state, command) {
  if (!state?.reliable) return null;
  if (
    typeof command !== "string"
    || !command
    || command.length > MAX_TRACKED_TERMINAL_INPUT
    || INVALID_TERMINAL_TEXT.test(command)
  ) {
    return null;
  }
  return `${CLEAR_CURRENT_TERMINAL_LINE}${command}`;
}

export function resolveInlineCompletionKeyAction({ key, open, reliable, suggestionCount }) {
  if (!open) return "passthrough";
  if (key === "Escape") return "close";
  if (key === "Enter") return "execute";
  if (key === "Tab") return reliable && suggestionCount > 0 ? "insert" : "passthrough";
  if (["ArrowDown", "ArrowUp"].includes(key) && suggestionCount > 0) return "navigate";
  return "passthrough";
}

export function isImeCompositionKeyEvent(event, compositionActive = false) {
  return Boolean(
    compositionActive
    || event?.isComposing
    || event?.nativeEvent?.isComposing
    || event?.keyCode === 229
    || event?.which === 229,
  );
}
