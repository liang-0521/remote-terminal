import assert from "node:assert/strict";
import test from "node:test";
import { findTextMatches } from "../src/lib/text-search.js";

test("远程文本搜索支持大小写、全字和正则组合", () => {
  const content = "Error error ErrorCode 错误 错误码\nitem-12 item-34";

  assert.equal(findTextMatches(content, "error").matches.length, 3);
  assert.equal(findTextMatches(content, "Error", { caseSensitive: true }).matches.length, 2);
  assert.equal(findTextMatches(content, "Error", { wholeWord: true }).matches.length, 2);
  assert.equal(findTextMatches(content, "错误", { wholeWord: true }).matches.length, 1);
  assert.equal(findTextMatches(content, "item-\\d+", { regularExpression: true }).matches.length, 2);
});

test("无效正则表达式返回可展示错误且不产生匹配", () => {
  assert.deepEqual(findTextMatches("content", "[", { regularExpression: true }), {
    matches: [],
    error: "正则表达式无效",
  });
});
