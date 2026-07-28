import assert from "node:assert/strict";
import test from "node:test";
import {
  INTERFACE_THEME_MODES,
  resolveInterfaceColorScheme,
} from "../src/services/interface-theme.js";

test("界面主题支持系统、亮色和暗色三种会话模式", () => {
  assert.deepEqual(INTERFACE_THEME_MODES, ["system", "light", "dark"]);
  assert.equal(resolveInterfaceColorScheme("system", true), "dark");
  assert.equal(resolveInterfaceColorScheme("system", false), "light");
  assert.equal(resolveInterfaceColorScheme("light", true), "light");
  assert.equal(resolveInterfaceColorScheme("dark", false), "dark");
});

test("未知界面主题模式显式失败", () => {
  assert.throws(() => resolveInterfaceColorScheme("auto", true), /不支持的界面主题模式/);
});

test("设置页卡片直接使用主题变量，不会被拆包顺序恢复成深色半透明背景", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(new URL("../src/update-styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.settings-update\s*\{[^}]*background:\s*var\(--surface-update\)/s);
  assert.match(styles, /\.settings-close-behavior\s*>\s*label\s*\{[^}]*background:\s*var\(--surface-update\)/s);
  assert.match(styles, /\.settings-close-behavior strong\s*\{[^}]*color:\s*var\(--text-primary\)/s);
  assert.doesNotMatch(styles, /rgba\(7,\s*21,\s*37|#eaf1f9|#71869e/i);
});
