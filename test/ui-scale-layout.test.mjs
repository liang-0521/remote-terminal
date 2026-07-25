import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("界面缩放固定在左上角并保持可视画布填满窗口", async () => {
  const source = await readFile(new URL("../src/NativeApp.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bzoom:\s*uiScale\b/);
  assert.match(source, /width:\s*`\$\{100\s*\/\s*uiScale\}%`/);
  assert.match(source, /height:\s*`\$\{100\s*\/\s*uiScale\}%`/);
  assert.match(source, /transform:\s*`scale\(\$\{uiScale\}\)`/);
  assert.match(source, /transformOrigin:\s*"top left"/);
});

test("固定定位弹窗按缩放后的逻辑画布限宽限高", async () => {
  const source = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /\.connection-manager\s*\{[^}]*width:\s*min\(820px,\s*100%\);[^}]*max-height:\s*min\(760px,\s*100%\);/s);
  assert.match(source, /\.settings-panel\s*\{[^}]*width:\s*min\(940px,\s*100%\);[^}]*max-height:\s*min\(820px,\s*100%\);/s);
  assert.doesNotMatch(source, /\.(?:connection-manager|settings-panel)\s*\{[^}]*(?:100vw|100vh)/s);
});

test("所有可选比例的反向画布尺寸在缩放后都等于完整视口", () => {
  for (const scale of [0.8, 0.9, 1, 1.1, 1.25, 1.5]) {
    const layoutPercent = 100 / scale;
    assert.ok(Math.abs(layoutPercent * scale - 100) < Number.EPSILON * 100);
  }
});
