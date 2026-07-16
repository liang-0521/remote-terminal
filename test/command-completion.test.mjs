import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_COMPLETIONS,
  advanceTerminalInputState,
  buildCommandCompletionCatalog,
  calculateInlineCompletionPosition,
  collectExecutedTerminalCommands,
  createTerminalCompletionInput,
  createTerminalInputState,
  createDirectoryCompletions,
  isImeCompositionKeyEvent,
  nextCommandCompletionIndex,
  quotePosixShellArgument,
  resolveInlineCompletionKeyAction,
  searchCommandCompletions,
  searchInlineCommandCompletions,
  shouldAutoOpenCommandCompletion,
} from "../src/services/command-completion.js";

test("命令补全支持 ll/ls alias、中文描述、关键词和分组", () => {
  assert.equal(searchCommandCompletions("ll")[0].command, "ll");
  assert.equal(searchCommandCompletions("ls")[0].command, "ls -lah");
  assert.equal(searchCommandCompletions("系统日志")[0].command, "journalctl -xe");
  assert.equal(searchCommandCompletions("磁盘")[0].command, "df -h");
  assert.equal(searchCommandCompletions("memory")[0].command, "free -h");
  assert.equal(searchCommandCompletions("disk space")[0].command, "df -h");
  assert.equal(searchCommandCompletions("清理")[0].command, "clear");
  assert.ok(searchCommandCompletions("容器").every((item) => item.group === "容器"));
  assert.equal(COMMAND_COMPLETIONS.find((item) => item.command === "ll").keywords.includes("long listing"), true);
});

test("空目录中查看文件仍命中内置 ls 语义", () => {
  const catalog = buildCommandCompletionCatalog({ directoryEntries: [] });
  assert.equal(searchCommandCompletions("查看文件", { completions: catalog })[0].command, "ls -lah");
});

test("空格分隔的中英文关键词可跨字段组合匹配", () => {
  const matches = searchCommandCompletions("nginx 日志");
  assert.equal(matches[0].command, "journalctl -u nginx -f");
  assert.equal(matches[0].matchType, "keyword");
  assert.deepEqual(searchCommandCompletions("ＮＧＩＮＸ　日志").map((item) => item.command), matches.map((item) => item.command));
});

test("匹配结果按 exact、prefix、keyword 排名并保持同级原始顺序", () => {
  const completions = [
    { command: "show alpha usage", description: "演示", group: "其他", keywords: [] },
    { command: "alphabet", description: "前缀", group: "其他", keywords: [] },
    { command: "run exact", description: "精确", group: "其他", keywords: ["alpha"] },
  ];

  const matches = searchCommandCompletions("alpha", { completions });
  assert.deepEqual(matches.map((item) => item.command), ["run exact", "alphabet", "show alpha usage"]);
  assert.deepEqual(matches.map((item) => item.matchType), ["exact", "prefix", "keyword"]);
});

test("结果数量可限制，非法限制恢复默认值", () => {
  assert.equal(searchCommandCompletions("", { limit: 2 }).length, 2);
  assert.equal(searchCommandCompletions("", { limit: -1 }).length, 8);
});

test("空查询先展示本机历史与精选内置命令，不倾倒远端可执行目录", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "ls", source: "remote-command" },
      { command: "deployctl", source: "remote-command" },
      { command: "deployctl release", source: "history" },
    ],
  });

  const matches = searchCommandCompletions("", { completions: catalog, limit: 30 });
  assert.equal(matches.length, COMMAND_COMPLETIONS.length + 1);
  assert.deepEqual(
    matches.slice(0, 1).map((item) => [item.command, item.source]),
    [["deployctl release", "history"]],
  );
  assert.equal(matches.slice(1).every((item) => item.curated === true), true);
  assert.equal(matches.some((item) => item.command === "deployctl"), false);
});

test("识别浏览器、React 包装事件和 Windows IME keyCode 229", () => {
  assert.equal(isImeCompositionKeyEvent({ isComposing: true }), true);
  assert.equal(isImeCompositionKeyEvent({ nativeEvent: { isComposing: true } }), true);
  assert.equal(isImeCompositionKeyEvent({ keyCode: 229 }), true);
  assert.equal(isImeCompositionKeyEvent({ which: 229 }), true);
  assert.equal(isImeCompositionKeyEvent({ key: "Enter" }, true), true);
  assert.equal(isImeCompositionKeyEvent({ key: "Enter" }), false);
});

test("智能补全列表支持循环方向键与 Home/End", () => {
  assert.equal(nextCommandCompletionIndex(1, "ArrowDown", 3), 2);
  assert.equal(nextCommandCompletionIndex(2, "ArrowDown", 3), 0);
  assert.equal(nextCommandCompletionIndex(0, "ArrowUp", 3), 2);
  assert.equal(nextCommandCompletionIndex(2, "Home", 3), 0);
  assert.equal(nextCommandCompletionIndex(0, "End", 3), 2);
  assert.equal(nextCommandCompletionIndex(0, "Tab", 3), null);
  assert.equal(nextCommandCompletionIndex(0, "Home", 0), null);
});

test("动态目录合并远端命令与本机历史，按命令去重并保留可读来源", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "ls", source: "remote-command" },
      { command: "ls", source: "history" },
      { command: "deployctl", source: "remote-command" },
      { command: "docker ps", source: "history" },
    ],
    directoryEntries: [
      { name: "release 2026", type: "directory" },
      { name: "application.log", type: "file" },
    ],
  });

  assert.equal(catalog.filter((item) => item.command === "ls").length, 1);
  assert.equal(catalog.find((item) => item.command === "ls").sourceLabel, "本机历史");
  assert.equal(catalog.find((item) => item.command === "deployctl").description, "");
  assert.equal(catalog.find((item) => item.command === "docker ps").sourceLabel, "本机历史");
  assert.equal(catalog.find((item) => item.command === "docker ps").description, "查看运行中的容器");
  assert.equal(catalog.find((item) => item.command === "docker ps").curated, true);
  assert.equal(catalog.find((item) => item.command.startsWith("cd --")).sourceLabel, "当前目录");
});

test("显式搜索保留远端精确项，且不生成重复命令描述", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "deployctl", source: "remote-command" },
      { command: "deployctl-debug", source: "remote-command" },
    ],
  });

  const matches = searchCommandCompletions("deployctl", { completions: catalog });
  assert.equal(matches[0].command, "deployctl");
  assert.equal(matches[0].matchType, "exact");
  assert.equal(matches[0].description, "");
});

test("显式搜索把匹配的本机历史置于内置与远端命令之前", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "ls", source: "remote-command" },
      { command: "ls -lah", source: "history" },
      { command: "lsmod", source: "remote-command" },
    ],
  });

  assert.deepEqual(
    searchCommandCompletions("ls", { completions: catalog }).slice(0, 3).map((item) => [item.command, item.source]),
    [["ls -lah", "history"], ["ls", "remote-command"], ["lsmod", "remote-command"]],
  );
});

test("动态补全对 ll、ls、中文语义和当前目录名称执行统一排名", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "ls", source: "remote-command", keywords: ["查看文件"] },
      { command: "ll", source: "history" },
    ],
    directoryEntries: [{ name: "部署说明.txt", type: "file" }],
  });

  assert.equal(searchCommandCompletions("ll", { completions: catalog })[0].command, "ll");
  assert.equal(searchCommandCompletions("ls", { completions: catalog })[0].command, "ll");
  assert.ok(["ls", "ls -lah"].includes(searchCommandCompletions("查看文件", { completions: catalog })[0].command));
  assert.equal(searchCommandCompletions("部署说明", { completions: catalog })[0].command, "ls -lah -- '部署说明.txt'");
});

test("当前目录参数使用 POSIX 单参数引用，空格、单引号和元字符不能变成命令分隔符", () => {
  assert.equal(quotePosixShellArgument("release.tar.gz"), "release.tar.gz");
  assert.equal(quotePosixShellArgument("release 2026"), "'release 2026'");
  assert.equal(quotePosixShellArgument("owner's notes"), "'owner'\\''s notes'");

  const completions = createDirectoryCompletions([
    { name: "release 2026", type: "directory" },
    { name: "owner's notes.txt", type: "file" },
    { name: "build; touch injected", type: "file" },
  ]);
  assert.deepEqual(completions.map((item) => item.command), [
    "cd -- 'release 2026'",
    "ls -lah -- 'owner'\\''s notes.txt'",
    "ls -lah -- 'build; touch injected'",
  ]);
});

test("目录项和远端命令中的控制字符不会进入终端候选", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "safe-command", source: "remote-command" },
      { command: "bad\ncommand", source: "history" },
    ],
    directoryEntries: [
      { name: "safe.txt", type: "file" },
      { name: "bad\nname", type: "file" },
    ],
  });

  assert.equal(catalog.some((item) => item.command.includes("bad")), false);
  assert.equal(catalog.some((item) => item.command === "safe-command"), true);
  assert.equal(catalog.some((item) => item.command === "ls -lah -- safe.txt"), true);
});

test("终端当前行跟踪普通输入、中文 IME 提交、Backspace 和可靠状态下的 Ctrl+U", () => {
  let state = createTerminalInputState();
  state = advanceTerminalInputState(state, "查看文件");
  state = advanceTerminalInputState(state, "\u007f");
  assert.deepEqual(state, { reliable: true, text: "查看文" });

  state = advanceTerminalInputState(state, "件");
  assert.equal(searchCommandCompletions(state.text)[0].command, "ls -lah");
  assert.deepEqual(advanceTerminalInputState(state, "\u0015"), { reliable: true, text: "" });
});

test("只从可靠当前行的 Enter 边界提取本机历史，Ctrl+C 和不可靠输入不记录", () => {
  const typed = advanceTerminalInputState(createTerminalInputState(), "  ls -lah  ");
  assert.deepEqual(collectExecutedTerminalCommands(typed, "\r"), ["ls -lah"]);
  assert.deepEqual(
    collectExecutedTerminalCommands(createTerminalInputState(), "pwd\rwhoami\r"),
    ["pwd", "whoami"],
  );
  assert.deepEqual(collectExecutedTerminalCommands(typed, "\u0003"), []);
  const unreliable = advanceTerminalInputState(typed, "\u001b[D");
  assert.deepEqual(collectExecutedTerminalCommands(unreliable, "\r"), []);
});

test("光标移动、远端 Tab 和未知控制输入会锁定替换，Enter 或 Ctrl+C 才建立新边界", () => {
  const typed = advanceTerminalInputState(createTerminalInputState(), "journalctl");
  const moved = advanceTerminalInputState(typed, "\u001b[D");
  assert.deepEqual(moved, { reliable: false, text: "" });
  assert.deepEqual(advanceTerminalInputState(moved, "\u0015"), { reliable: false, text: "" });
  assert.deepEqual(advanceTerminalInputState(moved, "\r"), { reliable: true, text: "" });
  assert.deepEqual(advanceTerminalInputState(moved, "\u0003"), { reliable: true, text: "" });
  assert.equal(advanceTerminalInputState(typed, "\t").reliable, false);
  assert.equal(advanceTerminalInputState(typed, "\u001b[3~").reliable, false);
});

test("Tab 补全只替换可靠当前行且永不附加执行字符", () => {
  const typed = advanceTerminalInputState(createTerminalInputState(), "查看文件");
  const input = createTerminalCompletionInput(typed, "ls -lah");
  assert.equal(input, "\u0001\u000bls -lah");
  assert.equal(input.includes("\r"), false);
  assert.equal(input.includes("\n"), false);

  const unreliable = advanceTerminalInputState(typed, "\u001b[D");
  assert.equal(createTerminalCompletionInput(unreliable, "ls -lah"), null);
  assert.equal(createTerminalCompletionInput(typed, "printf unsafe\n"), null);
});

test("行内补全键位保持 Tab 插入、Enter 执行当前行、Escape 仅关闭建议", () => {
  const context = { open: true, reliable: true, suggestionCount: 2 };
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "Tab" }), "insert");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "Enter" }), "execute");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "Escape" }), "close");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "ArrowDown" }), "navigate");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "ArrowLeft" }), "passthrough");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "Tab", reliable: false }), "passthrough");
  assert.equal(resolveInlineCompletionKeyAction({ ...context, key: "Enter", open: false }), "passthrough");
});

test("终端输入精确命中 ll 时继续显示精确项和可拼接前缀", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "ll -h", source: "history" },
      { command: "tail -f app.log", source: "history", keywords: ["follow logs"] },
    ],
  });
  assert.deepEqual(
    searchInlineCommandCompletions("ll", { completions: catalog }).map((item) => item.command),
    ["ll", "ll -h"],
  );
  assert.equal(searchInlineCommandCompletions("查看文件", { completions: catalog })[0].command, "ls -lah");
});

test("行内自动提示最多返回五条，并随输入继续缩小候选", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      "deploy", "deploy-api", "deploy-web", "deploy-worker", "deploy-docs", "deploy-status", "describe",
    ].map((command) => ({ command, source: "remote-command" })),
  });

  const broad = searchInlineCommandCompletions("de", { completions: catalog, limit: 5 });
  const precise = searchInlineCommandCompletions("deploy-w", { completions: catalog, limit: 5 });
  assert.equal(broad.length, 5);
  assert.deepEqual(precise.map((item) => item.command), ["deploy-web", "deploy-worker"]);
});

test("当前输入已精确命中命令时，行内补全保留当前项和更长前缀项", () => {
  const catalog = buildCommandCompletionCatalog({
    remoteCompletions: [
      { command: "clear", source: "remote-command" },
      { command: "clear_console", source: "remote-command" },
    ],
  });

  assert.deepEqual(
    searchInlineCommandCompletions("clear", { completions: catalog }).map((item) => [item.command, item.matchType]),
    [["clear", "exact"], ["clear_console", "prefix"]],
  );
  assert.equal(searchCommandCompletions("clear", { completions: catalog })[0].command, "clear");
  assert.equal(
    searchCommandCompletions("clear", { completions: catalog })
      .some((item) => item.command === "clear_console"),
    true,
  );
  assert.deepEqual(
    searchInlineCommandCompletions("clear_console", { completions: catalog }).map((item) => [item.command, item.matchType]),
    [["clear_console", "exact"]],
  );
});

test("行内候选优先显示在光标下方，空间不足时翻到上方并保持容器内", () => {
  assert.deepEqual(calculateInlineCompletionPosition({
    cursorLeft: 180,
    cursorTop: 48,
    lineHeight: 18,
    containerWidth: 800,
    containerHeight: 500,
    popoverWidth: 400,
    popoverHeight: 260,
  }), { left: 180, top: 72, placement: "below" });

  assert.deepEqual(calculateInlineCompletionPosition({
    cursorLeft: 760,
    cursorTop: 430,
    lineHeight: 18,
    containerWidth: 800,
    containerHeight: 500,
    popoverWidth: 400,
    popoverHeight: 260,
  }), { left: 392, top: 164, placement: "above" });
});

test("可靠当前行存在实际输入和候选时自动显示补全", () => {
  assert.equal(shouldAutoOpenCommandCompletion({ reliable: true, text: "ls" }, 2), true);
  assert.equal(shouldAutoOpenCommandCompletion({ reliable: true, text: "  " }, 2), false);
  assert.equal(shouldAutoOpenCommandCompletion({ reliable: true, text: "unknown" }, 0), false);
  assert.equal(shouldAutoOpenCommandCompletion({ reliable: false, text: "ls" }, 2), false);
});
