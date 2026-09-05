import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("界面缩放不再使用会破坏终端鼠标坐标的 CSS 变换", async () => {
  const source = await readFile(new URL("../src/NativeApp.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bzoom:\s*uiScale\b/);
  assert.doesNotMatch(source, /width:\s*`\$\{100\s*\/\s*uiScale\}%`/);
  assert.doesNotMatch(source, /height:\s*`\$\{100\s*\/\s*uiScale\}%`/);
  assert.doesNotMatch(source, /transform:\s*`scale\(\$\{uiScale\}\)`/);
});

test("固定定位弹窗按缩放后的逻辑画布限宽限高", async () => {
  const source = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /\.connection-manager\s*\{[^}]*width:\s*min\(820px,\s*100%\);[^}]*max-height:\s*min\(760px,\s*100%\);/s);
  assert.match(source, /\.settings-panel\s*\{[^}]*width:\s*min\(940px,\s*100%\);[^}]*max-height:\s*min\(820px,\s*100%\);/s);
  assert.doesNotMatch(source, /\.(?:connection-manager|settings-panel)\s*\{[^}]*(?:100vw|100vh)/s);
});

test("远程文本编辑器在主工作区和并排工作区都保持网格布局", async () => {
  const source = await readFile(new URL("../src/feature-styles.css", import.meta.url), "utf8");

  assert.match(
    source,
    /\.native-workspace-grid\s*>\s*\.remote-text-editor\.is-primary,\s*\.native-workspace-grid\s*>\s*\.remote-text-editor\.is-secondary\s*\{\s*display:\s*grid;/s,
  );
});

test("底部面板拖动统一使用逻辑高度并换算缩放后的指针位移", async () => {
  const source = await readFile(new URL("../src/components/shell/BottomPanel.jsx", import.meta.url), "utf8");

  const layoutSource = await readFile(new URL("../src/services/bottom-panel-layout.js", import.meta.url), "utf8");
  assert.match(layoutSource, /height: panel\.offsetHeight/);
  assert.match(source, /startHeight: panel\.offsetHeight/);
  assert.match(source, /renderedHeight \/ panel\.offsetHeight/);
  assert.match(source, /\(dragState\.current\.startY - event\.clientY\) \/ dragState\.current\.scaleY/);
  assert.match(source, /closest\("\.bottom-panel"\)\.offsetHeight/);
});
