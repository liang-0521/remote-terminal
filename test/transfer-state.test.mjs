import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeDownloadProgressTransfer,
  shouldRefreshRemoteDirectory,
} from "../src/services/transfer-state.js";

test("传输只在首次进入完成状态时刷新远程目录", () => {
  assert.equal(shouldRefreshRemoteDirectory(undefined, "success"), true);
  assert.equal(shouldRefreshRemoteDirectory("uploading", "success"), true);
  assert.equal(shouldRefreshRemoteDirectory("success", "success"), false);
  assert.equal(shouldRefreshRemoteDirectory("success", "failed"), false);
});

test("迟到的下载进度不能覆盖完成、失败或取消终态", () => {
  const progress = { id: "download-1", state: "downloading", progress: 80 };
  for (const state of ["success", "failed", "cancelled"]) {
    const terminal = { id: "download-1", state, progress: state === "success" ? 100 : 40 };
    assert.strictEqual(mergeDownloadProgressTransfer(terminal, progress), terminal);
  }

  assert.strictEqual(mergeDownloadProgressTransfer(undefined, progress), progress);
  assert.strictEqual(
    mergeDownloadProgressTransfer({ id: "download-1", state: "queued" }, progress),
    progress,
  );
});
