import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createTerminalTransport } from "../src/services/terminal-transport.js";

const paneUrl = new URL("../src/components/terminal/NativeTerminalPane.jsx", import.meta.url);

test("全屏终端输入不依赖应用猜测且始终先排队写入远端", async () => {
  const source = await readFile(paneUrl, "utf8");

  assert.match(source, /terminal\.buffer\.onBufferChange\(\(buffer\) => \{/);
  assert.doesNotMatch(source, /isLikelyViTerminalBuffer|detectTerminalApplicationCommand|advanceTerminalApplicationInputState/);
  assert.match(source, /const writeRequest = enqueueTerminalWrite\(data\);/);
  assert.match(source, /if \(!shouldTrackTerminalCommandInput\(terminal\.buffer\.active, shellPromptReadyRef\.current\)\) \{/);
  assert.match(source, /if \(keyAction === "close"\) \{\s+closeInlineCompletion\(\);\s+return true;/s);
  assert.match(source, /shellPromptReadyRef\.current = false;/);
});

function fixture() {
  let sessionId = "session-first";
  const events = [];
  const transport = createTerminalTransport({
    getSessionId: () => sessionId,
    write: async (id, data) => events.push({ type: "write", id, data }),
    resize: async (id, dimensions) => events.push({ type: "resize", id, ...dimensions }),
  });
  return { transport, events, reconnect: (id) => { sessionId = id; } };
}

test("首次连接先同步已适配的尺寸，再依序发送 vi 编辑和保存退出按键", async () => {
  const { transport, events } = fixture();
  const dimensions = { cols: 99, rows: 23 };
  const requests = [transport.resize(dimensions)];
  for (const data of ["vi example.txt\r", "i", "text", "\u001b", ":wq", "\r"]) {
    requests.push(transport.write(data));
  }
  await Promise.all(requests);
  assert.deepEqual(events[0], { type: "resize", id: "session-first", ...dimensions });
  assert.deepEqual(events.slice(1).map((event) => event.data), ["vi example.txt\r", "i", "text", "\u001b", ":wq", "\r"]);
});

test("同尺寸适配不重复发送，重连后的新会话必须重新同步", async () => {
  const { transport, events, reconnect } = fixture();
  const size = { cols: 99, rows: 23 };
  await Promise.all([transport.resize(size), transport.resize(size)]);
  await transport.resize(size);
  assert.equal(events.length, 1);
  reconnect("session-second");
  await transport.resize(size);
  assert.equal(events.length, 2);
  assert.equal(events[1].id, "session-second");
  await transport.resize({ cols: 70, rows: 18 });
  assert.deepEqual(events[2], { type: "resize", id: "session-second", cols: 70, rows: 18 });
});

test("重连后排队中的旧尺寸和旧输入不得进入新会话", async () => {
  const { transport, events, reconnect } = fixture();
  const requests = [transport.resize({ cols: 99, rows: 23 }), transport.write(":wq\r")];
  reconnect("session-second");
  const results = await Promise.allSettled(requests);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.deepEqual(events, []);
  await transport.resize({ cols: 99, rows: 23 });
  await transport.write("vi example.txt\r");
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.id === "session-second"));
});

test("尺寸同步失败向调用方报错，下次显式同步可以重试", async () => {
  const failure = new Error("resize failed");
  let attempts = 0;
  const transport = createTerminalTransport({
    getSessionId: () => "session-first",
    write: async () => {},
    resize: async () => { if (++attempts === 1) throw failure; },
  });
  await assert.rejects(transport.resize({ cols: 80, rows: 24 }), (error) => error === failure);
  await transport.resize({ cols: 80, rows: 24 });
  assert.equal(attempts, 2);
  await assert.rejects(transport.resize({ cols: 0, rows: 24 }), TypeError);
});

test("全屏输入必须等待尚未完成的尺寸同步", async () => {
  let finishResize;
  const events = [];
  const transport = createTerminalTransport({
    getSessionId: () => "session-first",
    resize: () => new Promise((resolve) => { finishResize = resolve; }),
    write: async (_id, data) => events.push(data),
  });
  const resized = transport.resize({ cols: 80, rows: 24 });
  const input = transport.write("vi example.txt\r");
  await Promise.resolve();
  assert.deepEqual(events, []);
  finishResize();
  await Promise.all([resized, input]);
  assert.deepEqual(events, ["vi example.txt\r"]);
});
