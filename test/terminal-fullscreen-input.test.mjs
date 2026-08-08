import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const paneUrl = new URL("../src/components/terminal/NativeTerminalPane.jsx", import.meta.url);

test("vi 在普通或备用缓冲区都绕过命令补全并保留远端编辑键", async () => {
  const source = await readFile(paneUrl, "utf8");

  assert.match(source, /terminal\.buffer\.onBufferChange\(\(buffer\) => \{/);
  assert.match(source, /terminalApplicationInputRef\.current = createTerminalApplicationInputState\(terminalApplication\);/);
  assert.match(source, /if \(!shouldTrackTerminalCommandInput\(\s*terminal\.buffer\.active,\s*Boolean\(terminalApplicationInputRef\.current\),\s*\)\) \{\s+if \(inlineCompletionOpenRef\.current\) closeInlineCompletion\(\);\s+return true;/s);
  assert.match(source, /const tracksCommandInput = shouldTrackTerminalCommandInput\(\s*terminal\.buffer\.active,\s*Boolean\(applicationInput\),\s*\);/s);
  assert.match(source, /if \(tracksCommandInput\) trackTerminalInput\(data\);/);
  assert.match(source, /if \(applicationTransition\?\.exits && terminal\.buffer\.active\.type === "normal"\) \{/);
});
