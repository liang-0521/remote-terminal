const DEFAULT_RESULT_LIMIT = 8;
const MAX_TRACKED_TERMINAL_INPUT = 2_048;
const CLEAR_CURRENT_TERMINAL_LINE = "\u0001\u000b";

export const COMMAND_COMPLETIONS = Object.freeze([
  {
    command: "ll",
    description: "ls -l 的常用别名，长格式列出目录内容",
    group: "文件",
    keywords: ["ll", "ls -l", "长格式", "目录内容", "long listing", "list files", "directory listing"],
  },
  {
    command: "ls -lah",
    description: "查看当前目录详细内容",
    group: "文件",
    keywords: ["ls", "目录列表", "文件列表", "列出文件", "查看目录", "查看文件", "list files", "directory listing", "show files"],
  },
  {
    command: "cd /var/log",
    description: "进入系统日志目录",
    group: "文件",
    keywords: ["cd", "切换目录", "日志目录", "change directory", "logs"],
  },
  {
    command: "find . -type f -name '*.log'",
    description: "按名称查找日志文件",
    group: "文件",
    keywords: ["find", "查找文件", "搜索文件", "日志文件", "find files", "search files", "log files"],
  },
  {
    command: "grep -Rni -- 'ERROR' .",
    description: "递归查找错误内容",
    group: "文件",
    keywords: ["grep", "搜索内容", "查找文本", "错误", "search text", "find text", "error"],
  },
  {
    command: "tail -f /var/log/messages",
    description: "持续查看系统日志",
    group: "日志",
    keywords: ["tail", "实时日志", "跟踪日志", "follow logs", "live logs"],
  },
  {
    command: "journalctl -xe",
    description: "查看近期系统错误",
    group: "日志",
    keywords: ["journalctl", "系统日志", "错误日志", "system logs", "error logs"],
  },
  {
    command: "journalctl -u nginx -f",
    description: "持续查看 nginx 服务日志",
    group: "日志",
    keywords: ["journalctl", "nginx", "服务日志", "实时日志", "service logs", "follow nginx logs"],
  },
  {
    command: "systemctl status nginx",
    description: "查看 nginx 服务状态",
    group: "服务",
    keywords: ["systemctl", "nginx", "服务状态", "service status"],
  },
  {
    command: "systemctl list-units --failed",
    description: "查看启动失败的服务",
    group: "服务",
    keywords: ["systemctl", "失败服务", "异常服务", "failed services"],
  },
  {
    command: "ps aux --sort=-%cpu | head",
    description: "查看 CPU 占用最高的进程",
    group: "性能",
    keywords: ["ps", "cpu", "进程", "进程排行", "processes", "top cpu"],
  },
  {
    command: "free -h",
    description: "查看内存与 Swap",
    group: "性能",
    keywords: ["free", "内存", "swap", "交换空间", "memory"],
  },
  {
    command: "df -h",
    description: "查看文件系统容量",
    group: "性能",
    keywords: ["df", "磁盘", "磁盘容量", "文件系统", "disk", "disk space", "filesystem"],
  },
  {
    command: "ss -lntp",
    description: "查看正在监听的 TCP 端口",
    group: "网络",
    keywords: ["ss", "tcp", "端口", "监听端口", "ports", "listening ports"],
  },
  {
    command: "ip address",
    description: "查看网络接口与地址",
    group: "网络",
    keywords: ["ip", "ip地址", "网卡", "网络接口", "ip address", "network interface"],
  },
  {
    command: "docker ps",
    description: "查看运行中的容器",
    group: "容器",
    keywords: ["docker", "容器列表", "运行容器", "containers", "running containers"],
  },
  {
    command: "docker compose ps",
    description: "查看 Compose 服务状态",
    group: "容器",
    keywords: ["docker", "compose", "容器编排", "服务状态", "container services"],
  },
  {
    command: "clear",
    description: "清空当前终端屏幕",
    group: "终端",
    keywords: ["clear", "清屏", "清理", "清空终端", "clear terminal", "clear screen"],
  },
].map((completion) => Object.freeze({
  ...completion,
  curated: true,
  source: "builtin",
  sourceLabel: "内置语义",
})));

const SOURCE_DETAILS = Object.freeze({
  builtin: Object.freeze({ label: "内置语义", group: "内置语义", priority: 2 }),
  "remote-command": Object.freeze({ label: "远端命令", group: "远端命令", priority: 1 }),
  history: Object.freeze({ label: "本机历史", group: "本机历史", priority: 0 }),
  directory: Object.freeze({ label: "当前目录", group: "当前目录", priority: 3 }),
});

const INVALID_TERMINAL_TEXT = /[\u0000-\u001f\u007f]/;
const SAFE_POSIX_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VI_COMMANDS = new Set(["vi", "vim", "nvim", "view", "vimdiff", "nvimdiff", "rvim", "rview"]);
const COMMAND_WRAPPERS = new Set(["command", "exec", "nohup"]);
const PRIVILEGE_WRAPPERS = new Set(["sudo", "doas"]);
const WRAPPER_OPTIONS_WITH_VALUE = new Set([
  "-a", "-C", "-D", "-g", "-h", "-p", "-r", "-R", "-T", "-u",
  "--chdir", "--group", "--host", "--prompt", "--role", "--user",
]);
const VI_INSERT_KEYS = new Set(["i", "I", "a", "A", "o", "O", "s", "S", "C", "R"]);
const VI_EXIT_COMMAND = /^(?:q(?:a|all)?!?|wq!?|wqa!?|x!?|xa!?|cq!?)(?:\s|$)/i;

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
      ? "本机为此服务器保存的命令历史"
      : "";
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
    const curated = existing.curated ? existing : completion.curated ? completion : null;
    byCommand.set(key, {
      ...primary,
      description: curated?.description || primary.description || secondary.description,
      group: curated?.group || primary.group,
      curated: Boolean(primary.curated || secondary.curated),
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
  const history = remote.filter((completion) => completion.source === "history");
  const remoteCommands = remote.filter((completion) => completion.source !== "history");
  return deduplicateCompletions([
    ...history,
    ...COMMAND_COMPLETIONS,
    ...remoteCommands,
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
  {
    completions = COMMAND_COMPLETIONS,
    limit = DEFAULT_RESULT_LIMIT,
    prioritizeHistory = true,
  } = {},
) {
  const normalizedQuery = normalizeSearchText(query);
  const resultLimit = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_RESULT_LIMIT;
  if (!normalizedQuery) {
    return [
      ...completions.filter((completion) => completion.source === "history"),
      ...completions.filter((completion) => (
        completion.source !== "history" && completion.curated === true
      )),
    ]
      .slice(0, resultLimit)
      .map((completion) => ({ ...completion, matchType: "default" }));
  }

  return completions
    .map((completion, sourceIndex) => rankCompletion(completion, normalizedQuery, sourceIndex))
    .filter(Boolean)
    .sort((left, right) => (
      (prioritizeHistory ? Number(right.completion.source === "history") - Number(left.completion.source === "history") : 0)
      || left.tier - right.tier
      || left.detail - right.detail
      || left.sourceIndex - right.sourceIndex
    ))
    .slice(0, resultLimit)
    .map(({ completion, matchType }) => ({ ...completion, matchType }));
}

export function searchInlineCommandCompletions(
  query,
  { completions = COMMAND_COMPLETIONS, limit = 10 } = {},
) {
  const normalizedQuery = normalizeSearchText(query);
  const resultLimit = Number.isInteger(limit) && limit >= 0 ? limit : 10;
  if (!normalizedQuery) return [];

  if (/^[\x20-\x7e]+$/.test(normalizedQuery)) {
    const commandPrefixes = completions
      .filter((completion) => {
        const command = normalizeSearchText(completion.command);
        return command.startsWith(normalizedQuery);
      })
      .map((completion, sourceIndex) => ({
        completion,
        sourceIndex,
        matchType: normalizeSearchText(completion.command) === normalizedQuery ? "exact" : "prefix",
      }))
      .sort((left, right) => (
        Number(right.matchType === "exact") - Number(left.matchType === "exact")
        || left.sourceIndex - right.sourceIndex
      ))
      .slice(0, resultLimit)
      .map(({ completion, matchType }) => ({ ...completion, matchType }));
    if (commandPrefixes.length) return commandPrefixes;
  }

  return searchCommandCompletions(normalizedQuery, {
    completions,
    limit: resultLimit,
    prioritizeHistory: false,
  });
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

function splitShellWords(command) {
  const words = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function commandBasename(word) {
  return String(word || "").replaceAll("\\", "/").split("/").at(-1).toLocaleLowerCase("en-US");
}

function skipWrapperOptions(words, startIndex) {
  let index = startIndex;
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index];
    index += 1;
    if (!option.includes("=") && WRAPPER_OPTIONS_WITH_VALUE.has(option)) index += 1;
  }
  return index;
}

export function detectTerminalApplicationCommand(command) {
  if (typeof command !== "string" || !command.trim() || INVALID_TERMINAL_TEXT.test(command)) return null;
  const words = splitShellWords(command.trim());
  let index = 0;
  while (index < words.length && SHELL_ASSIGNMENT.test(words[index])) index += 1;

  for (;;) {
    const wrapper = commandBasename(words[index]);
    if (wrapper === "env") {
      index = skipWrapperOptions(words, index + 1);
      while (index < words.length && SHELL_ASSIGNMENT.test(words[index])) index += 1;
      continue;
    }
    if (PRIVILEGE_WRAPPERS.has(wrapper) || COMMAND_WRAPPERS.has(wrapper)) {
      index = skipWrapperOptions(words, index + 1);
      while (index < words.length && SHELL_ASSIGNMENT.test(words[index])) index += 1;
      continue;
    }
    break;
  }

  const executable = commandBasename(words[index]);
  if (executable === "busybox" && commandBasename(words[index + 1]) === "vi") return "vi";
  return VI_COMMANDS.has(executable) ? "vi" : null;
}

export function createTerminalApplicationInputState(kind) {
  if (kind !== "vi") throw new TypeError("不支持的终端全屏程序类型");
  return { kind, mode: "normal", commandLine: "", normalSequence: "" };
}

function skipTerminalEscapeSequence(data, escapeIndex) {
  const marker = data[escapeIndex + 1];
  if (marker !== "[" && marker !== "O") return escapeIndex;
  let index = escapeIndex + 2;
  while (index < data.length && !/[\x40-\x7e]/.test(data[index])) index += 1;
  return Math.min(index, data.length - 1);
}

export function advanceTerminalApplicationInputState(state, data) {
  if (!state || state.kind !== "vi" || !["normal", "insert", "command"].includes(state.mode)) {
    throw new TypeError("终端全屏程序输入状态无效");
  }
  if (typeof data !== "string") throw new TypeError("终端输入数据必须是字符串");

  const next = { ...state };
  let exits = false;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "\u001b") {
      const escapeEnd = skipTerminalEscapeSequence(data, index);
      if (escapeEnd !== index) {
        index = escapeEnd;
        continue;
      }
      next.mode = "normal";
      next.commandLine = "";
      next.normalSequence = "";
      continue;
    }
    if (character === "\u0003") {
      next.mode = "normal";
      next.commandLine = "";
      next.normalSequence = "";
      continue;
    }
    if (next.mode === "insert") continue;
    if (next.mode === "command") {
      if (character === "\r" || character === "\n") {
        exits = VI_EXIT_COMMAND.test(next.commandLine.trim());
        next.mode = "normal";
        next.commandLine = "";
        next.normalSequence = "";
      } else if (character === "\b" || character === "\u007f") {
        next.commandLine = Array.from(next.commandLine).slice(0, -1).join("");
      } else if (character >= " ") {
        next.commandLine += character;
      }
      continue;
    }
    if (character === ":") {
      next.mode = "command";
      next.commandLine = "";
      next.normalSequence = "";
      continue;
    }
    if (VI_INSERT_KEYS.has(character)) {
      next.mode = "insert";
      next.normalSequence = "";
      continue;
    }
    if (character === "Z") {
      next.normalSequence += character;
      if (next.normalSequence === "ZZ") exits = true;
      continue;
    }
    if (character === "Q" && next.normalSequence === "Z") {
      exits = true;
      continue;
    }
    next.normalSequence = "";
  }
  return { state: next, exits };
}

export function shouldTrackTerminalCommandInput(buffer, terminalApplicationActive = false) {
  // 不只依赖备用缓冲区：服务器可配置 Vim 直接复用普通缓冲区。
  return !terminalApplicationActive && buffer?.type === "normal";
}

function transitionTerminalInputState(state, data, onExecute = undefined) {
  if (!state || typeof state.reliable !== "boolean" || typeof state.text !== "string") {
    throw new TypeError("终端输入状态无效");
  }
  if (typeof data !== "string") throw new TypeError("终端输入数据必须是字符串");

  let next = { reliable: state.reliable, text: state.text };
  for (const character of data) {
    if (["\r", "\n"].includes(character)) {
      const command = next.reliable ? next.text.trim() : "";
      if (command) onExecute?.(command);
      next = createTerminalInputState();
      continue;
    }
    if (character === "\u0003") {
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

export function advanceTerminalInputState(state, data) {
  return transitionTerminalInputState(state, data);
}

export function collectExecutedTerminalCommands(state, data) {
  const commands = [];
  transitionTerminalInputState(state, data, (command) => commands.push(command));
  return commands;
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

export function calculateInlineCompletionPosition({
  cursorLeft,
  cursorTop,
  lineHeight,
  containerWidth,
  containerHeight,
  popoverWidth,
  popoverHeight,
  margin = 8,
  gap = 6,
}) {
  const values = [cursorLeft, cursorTop, lineHeight, containerWidth, containerHeight, popoverWidth, popoverHeight, margin, gap];
  if (values.some((value) => !Number.isFinite(value))
    || lineHeight <= 0
    || containerWidth <= 0
    || containerHeight <= 0
    || popoverWidth <= 0
    || popoverHeight <= 0
    || margin < 0
    || gap < 0) {
    throw new TypeError("行内补全定位参数无效");
  }

  const maxLeft = Math.max(margin, containerWidth - popoverWidth - margin);
  const left = Math.min(Math.max(cursorLeft, margin), maxLeft);
  const belowTop = cursorTop + lineHeight + gap;
  const fitsBelow = belowTop + popoverHeight <= containerHeight - margin;
  return {
    left,
    top: fitsBelow ? belowTop : Math.max(margin, cursorTop - popoverHeight - gap),
    placement: fitsBelow ? "below" : "above",
  };
}

export function shouldAutoOpenCommandCompletion(state, suggestionCount) {
  return Boolean(
    state?.reliable
    && typeof state.text === "string"
    && state.text.trim()
    && Number.isInteger(suggestionCount)
    && suggestionCount > 0,
  );
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
