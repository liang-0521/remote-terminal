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
