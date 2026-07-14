import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConnectionStore } from "../electron/services/connection-store.mjs";

const TEST_FILE = path.join(
  os.tmpdir(),
  `remote-terminal-connection-store-${process.pid}-${crypto.randomUUID()}.json`,
);

test("ConnectionStore 保存和删除连接时不持久化额外凭证字段", async (t) => {
  t.after(async () => {
    try {
      await unlink(TEST_FILE);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });

  const store = new ConnectionStore(TEST_FILE);
  const saved = await store.save({
    name: "测试服务器",
    group: "测试",
    host: "example.test",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "must-not-be-persisted",
  });

  assert.equal(saved.username, "root");
  assert.equal("password" in saved, false);
  assert.equal((await store.list()).length, 1);
  assert.equal((await readFile(TEST_FILE, "utf8")).includes("must-not-be-persisted"), false);
  assert.deepEqual(await store.remove(saved.id), { connectionId: saved.id, removed: true });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.get(saved.id), (error) => error?.code === "CONNECTION_NOT_FOUND");
  await assert.rejects(store.remove(saved.id), (error) => error?.code === "CONNECTION_NOT_FOUND");
});
