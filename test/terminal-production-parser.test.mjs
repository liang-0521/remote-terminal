import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "vite";

test("正式构建的终端处理 vi 模式查询后仍能解析输出、调整尺寸和接收按键", async () => {
  const entry = "virtual:terminal-parser-regression";
  const bundle = await build({
    configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
    logLevel: "silent",
    plugins: [{
      name: "terminal-parser-regression",
      resolveId(id) { if (id === entry) return `\0${entry}`; },
      load(id) { if (id === `\0${entry}`) return 'export { Terminal } from "@xterm/xterm";'; },
    }],
    build: {
      write: false,
      rollupOptions: { input: entry, preserveEntrySignatures: "strict" },
    },
  });
  const chunk = bundle.output.find((output) => output.type === "chunk" && output.isEntry);
  assert.ok(chunk, "必须测试经过正式构建配置生成的 xterm 代码");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`;

  // xterm parses asynchronously; isolate an uncaught parser exception so it
  // fails this regression with a concise message instead of stalling the suite.
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    encoding: "utf8",
    timeout: 10_000,
    input: `
      import assert from "node:assert/strict";
      process.on("uncaughtException", (error) => {
        console.error(error.name + ": " + error.message);
        process.exit(1);
      });
      const { Terminal } = await import(${JSON.stringify(moduleUrl)});
      const terminal = new Terminal({ cols: 80, rows: 24 });
      const replies = [];
      terminal.onData((data) => replies.push(data));
      const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
      try {
        await write("\\x1b[?1004$p");
        await write("\\x1b[?1049h\\x1b[?1004h\\x1b[?2004h");
        await write("\\x1b[?1004$p\\x1b[?2004$p\\x1b[?1049$p\\x1b[4$p");
        assert.deepEqual(replies.filter((reply) => reply.endsWith("$y")), [
          "\\x1b[?1004;2$y", "\\x1b[?1004;1$y", "\\x1b[?2004;1$y",
          "\\x1b[?1049;1$y", "\\x1b[4;2$y",
        ]);
        for (const rows of [10, 35, 24]) {
          terminal.resize(100, rows);
          await write("\\x1b[Hvi-edit-" + rows);
          assert.equal(terminal.buffer.active.type, "alternate");
          assert.equal(terminal.rows, rows);
          assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "vi-edit-" + rows);
        }
        for (const data of ["i", "text", "\\x1b", ":wq\\r"]) terminal.input(data, true);
        assert.deepEqual(replies.slice(-4), ["i", "text", "\\x1b", ":wq\\r"]);
        await write("\\x1b[?1049l");
        assert.equal(terminal.buffer.active.type, "normal");
      } finally {
        terminal.dispose();
      }
    `,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout || "终端解析进程异常退出");
});
