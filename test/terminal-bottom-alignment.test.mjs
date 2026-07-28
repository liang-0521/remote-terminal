import assert from "node:assert/strict";
import test from "node:test";
import { calculateTerminalBottomOffsetRows } from "../src/services/terminal-bottom-alignment.js";

function buffer(lines, { cursorY = 0, type = "normal", viewportY = 0, baseY = 0 } = {}) {
  return {
    type,
    cursorY,
    viewportY,
    baseY,
    getLine(index) {
      const value = lines[index - viewportY] || "";
      return { translateToString: () => value.trimEnd() };
    },
  };
}

test("实时普通终端把最后一行贴到可见区域底部", () => {
  assert.equal(calculateTerminalBottomOffsetRows(buffer(["prompt"], { cursorY: 0 }), 24), 23);
  assert.equal(calculateTerminalBottomOffsetRows(buffer(["one", "prompt"], { cursorY: 1 }), 24), 22);
  assert.equal(calculateTerminalBottomOffsetRows(buffer(Array(24).fill("line"), { cursorY: 23 }), 24), 0);
});

test("查看历史或运行全屏终端程序时不移动屏幕", () => {
  assert.equal(calculateTerminalBottomOffsetRows(
    buffer(["history"], { cursorY: 0, viewportY: 4, baseY: 10 }),
    24,
  ), 0);
  assert.equal(calculateTerminalBottomOffsetRows(
    buffer(["vim"], { cursorY: 0, type: "alternate" }),
    24,
  ), 0);
});
