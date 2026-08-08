import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
