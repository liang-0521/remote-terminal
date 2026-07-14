import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CredentialStore } from "../electron/services/credential-store.mjs";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const TEST_FILE = path.join(
  os.tmpdir(),
  `remote-terminal-credential-store-${process.pid}-${crypto.randomUUID()}.json`,
);
const EMPTY_STORE = `${JSON.stringify({ version: 1, entries: {} }, null, 2)}\n`;
const MOCK_PREFIX = "remote-terminal-async-safe-storage:";
const XOR_MASK = 0xa5;

function errorCode(code) {
  return (error) => error?.code === code;
}

function protect(value) {
  const plain = Buffer.from(`${MOCK_PREFIX}${value}`, "utf8");
  return Buffer.from(plain.map((byte) => byte ^ XOR_MASK));
}

function unprotect(value) {
  const decoded = Buffer.from(value.map((byte) => byte ^ XOR_MASK)).toString("utf8");
  if (!decoded.startsWith(MOCK_PREFIX)) throw new Error("mock ciphertext invalid");
  return decoded.slice(MOCK_PREFIX.length);
}

function createSafeStorage({
  available = true,
  decryptError = null,
  malformedDecryptResult = false,
  shouldReEncrypt = false,
  invalidEncryptCall = null,
} = {}) {
  const calls = { availability: 0, encrypt: 0, decrypt: 0 };
  return {
    calls,
    async isAsyncEncryptionAvailable() {
      calls.availability += 1;
      return available;
    },
    async encryptStringAsync(value) {
      calls.encrypt += 1;
      if (calls.encrypt === invalidEncryptCall) return Buffer.alloc(0);
      return protect(value);
    },
    async decryptStringAsync(value) {
      calls.decrypt += 1;
      if (decryptError) throw decryptError;
      const result = unprotect(value);
      if (malformedDecryptResult) return { shouldReEncrypt: "yes", result };
      return { shouldReEncrypt, result };
    },
  };
}

async function resetStoreFile() {
  await writeFile(TEST_FILE, EMPTY_STORE, "utf8");
}

async function readStoreFile() {
  return readFile(TEST_FILE, "utf8");
}

test("CredentialStore 使用异步 safeStorage 管理独立密码存储", async (t) => {
  t.after(async () => {
    try {
      await unlink(TEST_FILE);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });

  await t.test("save/get/savedIds/remove 且磁盘无明文", async () => {
    await resetStoreFile();
    const safeStorage = createSafeStorage();
    const store = new CredentialStore(TEST_FILE, safeStorage);
    const password = "unique-test-password-密码";

    assert.deepEqual(await store.status(), { available: true, protection: "windows-user" });
    assert.deepEqual(await store.save(CONNECTION_ID, password), {
      connectionId: CONNECTION_ID,
      saved: true,
    });
    const raw = await readStoreFile();
    assert.equal(raw.includes(password), false);
    assert.equal(JSON.parse(raw).entries[CONNECTION_ID].protection, "electron-safe-storage");
    assert.equal(await store.get(CONNECTION_ID), password);
    assert.deepEqual([...await store.savedIds([CONNECTION_ID, SECOND_CONNECTION_ID])], [CONNECTION_ID]);
    assert.deepEqual(await store.remove(CONNECTION_ID), {
      connectionId: CONNECTION_ID,
      saved: false,
      removed: true,
    });
    assert.deepEqual([...await store.savedIds([CONNECTION_ID])], []);
    await assert.rejects(store.get(CONNECTION_ID), errorCode("SAVED_PASSWORD_NOT_FOUND"));
    assert.deepEqual(await store.remove(CONNECTION_ID), {
      connectionId: CONNECTION_ID,
      saved: false,
      removed: false,
    });
    assert.deepEqual(safeStorage.calls, { availability: 3, encrypt: 1, decrypt: 1 });
  });

  await t.test("异步加密不可用时拒绝保存和读取但不改变原文件", async () => {
    await resetStoreFile();
    const availableStore = new CredentialStore(TEST_FILE, createSafeStorage());
    await availableStore.save(CONNECTION_ID, "available-password");
    const before = await readStoreFile();
    const store = new CredentialStore(TEST_FILE, createSafeStorage({ available: false }));

    assert.deepEqual(await store.status(), { available: false, protection: "windows-user" });
    assert.deepEqual([...await store.savedIds([CONNECTION_ID])], [CONNECTION_ID]);
    await assert.rejects(
      store.save(SECOND_CONNECTION_ID, "must-not-be-written"),
      errorCode("CREDENTIAL_STORAGE_UNAVAILABLE"),
    );
    await assert.rejects(store.get(CONNECTION_ID), errorCode("CREDENTIAL_STORAGE_UNAVAILABLE"));
    assert.equal(await readStoreFile(), before);
  });

  await t.test("解密失败或异步返回结构畸形时不删除也不覆盖密文", async () => {
    await resetStoreFile();
    const writableStore = new CredentialStore(TEST_FILE, createSafeStorage());
    await writableStore.save(CONNECTION_ID, "preserve-this-ciphertext");
    const before = await readStoreFile();

    const failingStore = new CredentialStore(TEST_FILE, createSafeStorage({
      decryptError: new Error("simulated key failure"),
    }));
    await assert.rejects(failingStore.get(CONNECTION_ID), errorCode("CREDENTIAL_DECRYPT_FAILED"));
    assert.equal(await readStoreFile(), before);

    const malformedStore = new CredentialStore(TEST_FILE, createSafeStorage({
      malformedDecryptResult: true,
    }));
    await assert.rejects(malformedStore.get(CONNECTION_ID), errorCode("CREDENTIAL_DECRYPT_FAILED"));
    assert.equal(await readStoreFile(), before);
  });

  await t.test("重新加密结果无效时保留旧密文", async () => {
    await resetStoreFile();
    const safeStorage = createSafeStorage({ shouldReEncrypt: true, invalidEncryptCall: 2 });
    const store = new CredentialStore(TEST_FILE, safeStorage);
    await store.save(CONNECTION_ID, "rotation-password");
    const before = await readStoreFile();

    await assert.rejects(store.get(CONNECTION_ID), errorCode("CREDENTIAL_REENCRYPT_FAILED"));
    assert.equal(await readStoreFile(), before);
  });

  await t.test("损坏 JSON、连接标识和密文均明确失败且不被修复覆盖", async () => {
    await writeFile(TEST_FILE, "{broken-json", "utf8");
    let before = await readStoreFile();
    let store = new CredentialStore(TEST_FILE, createSafeStorage());
    await assert.rejects(store.savedIds([CONNECTION_ID]), errorCode("STORE_CORRUPT"));
    assert.equal(await readStoreFile(), before);

    const validEntry = {
      kind: "password",
      protection: "electron-safe-storage",
      formatVersion: 1,
      ciphertext: Buffer.alloc(16, 7).toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(TEST_FILE, `${JSON.stringify({
      version: 1,
      entries: { "not-a-connection-id": validEntry },
    }, null, 2)}\n`, "utf8");
    before = await readStoreFile();
    store = new CredentialStore(TEST_FILE, createSafeStorage());
    await assert.rejects(store.savedIds([CONNECTION_ID]), errorCode("CREDENTIAL_STORE_CORRUPT"));
    assert.equal(await readStoreFile(), before);

    await writeFile(TEST_FILE, `${JSON.stringify({
      version: 1,
      entries: {
        [CONNECTION_ID]: { ...validEntry, ciphertext: "not-base64!!!!" },
      },
    }, null, 2)}\n`, "utf8");
    before = await readStoreFile();
    store = new CredentialStore(TEST_FILE, createSafeStorage());
    await assert.rejects(store.savedIds([CONNECTION_ID]), errorCode("CREDENTIAL_STORE_CORRUPT"));
    assert.equal(await readStoreFile(), before);
  });
});
