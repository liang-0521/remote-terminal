import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const paneUrl = new URL("../src/components/terminal/NativeTerminalPane.jsx", import.meta.url);

test("vi 备用缓冲区绕过命令补全并保留远端编辑键", async () => {
  const source = await readFile(paneUrl, "utf8");

  assert.match(source, /terminal\.buffer\.onBufferChange\(\(buffer\) => \{/);
  assert.match(source, /if \(shouldTrackTerminalCommandInput\(buffer\)\) return;\s+closeInlineCompletion\(\);/s);
  assert.match(source, /if \(!shouldTrackTerminalCommandInput\(terminal\.buffer\.active\)\) \{\s+if \(inlineCompletionOpenRef\.current\) closeInlineCompletion\(\);\s+return true;/s);
  assert.match(source, /const tracksCommandInput = shouldTrackTerminalCommandInput\(terminal\.buffer\.active\);/);
  assert.match(source, /if \(tracksCommandInput\) trackTerminalInput\(data\);/);
});
