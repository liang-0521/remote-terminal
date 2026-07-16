import assert from "node:assert/strict";
import test from "node:test";
import { shouldRefreshRemoteDirectory } from "../src/services/transfer-state.js";

test("传输只在首次进入完成状态时刷新远程目录", () => {
  assert.equal(shouldRefreshRemoteDirectory(undefined, "success"), true);
  assert.equal(shouldRefreshRemoteDirectory("uploading", "success"), true);
  assert.equal(shouldRefreshRemoteDirectory("success", "success"), false);
  assert.equal(shouldRefreshRemoteDirectory("success", "failed"), false);
});
