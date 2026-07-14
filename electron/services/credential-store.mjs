import { AppError } from "./app-error.mjs";
import { JsonStore } from "./json-store.mjs";
import { validateId, validatePassword } from "./validation.mjs";

const ENCRYPTED_VALUE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_ENCRYPTED_BYTES = 12;
const MAX_ENCRYPTED_BYTES = 24_576;
const STORE_KEYS = new Set(["version", "entries"]);
const ENTRY_KEYS = new Set(["kind", "protection", "formatVersion", "ciphertext", "updatedAt"]);

function createEmptyStore() {
  return { version: 1, entries: {} };
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isValidTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function corruptStore(message, cause) {
  return new AppError("CREDENTIAL_STORE_CORRUPT", message, cause ? { cause } : undefined);
}

function decodeCiphertext(value) {
  if (typeof value !== "string"
    || value.length < 16
    || value.length > 32_768
    || value.length % 4 !== 0
    || !ENCRYPTED_VALUE_PATTERN.test(value)) {
    throw corruptStore("本机密码存储中存在无效的加密数据。");
  }
  const encrypted = Buffer.from(value, "base64");
  if (encrypted.length < MIN_ENCRYPTED_BYTES
    || encrypted.length > MAX_ENCRYPTED_BYTES
    || encrypted.toString("base64") !== value) {
    throw corruptStore("本机密码存储中存在无效的加密数据。");
  }
  return encrypted;
}

function requireEncryptedBuffer(value, code, message) {
  if (!Buffer.isBuffer(value)
    || value.length < MIN_ENCRYPTED_BYTES
    || value.length > MAX_ENCRYPTED_BYTES) {
    throw new AppError(code, message);
  }
  return value;
}

function validateStore(value) {
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== 1
    || !value.entries
    || typeof value.entries !== "object"
    || Array.isArray(value.entries)
    || !hasOnlyKeys(value, STORE_KEYS)) {
    throw new AppError("CREDENTIAL_STORE_CORRUPT", "本机密码存储结构不正确。请先备份该文件再处理。" );
  }
  for (const [connectionId, entry] of Object.entries(value.entries)) {
    try {
      validateId(connectionId, "凭证连接标识");
    } catch (error) {
      throw corruptStore("本机密码存储中存在无效的连接标识。", error);
    }
    if (!entry || typeof entry !== "object"
      || Array.isArray(entry)
      || !hasOnlyKeys(entry, ENTRY_KEYS)
      || entry.kind !== "password"
      || entry.protection !== "electron-safe-storage"
      || entry.formatVersion !== 1
      || !isValidTimestamp(entry.updatedAt)) {
      throw new AppError("CREDENTIAL_STORE_CORRUPT", "本机密码存储中存在无效的加密数据。" );
    }
    decodeCiphertext(entry.ciphertext);
  }
  return value;
}

export class CredentialStore {
  #store;
  #safeStorage;

  constructor(filePath, safeStorage) {
    this.#store = new JsonStore(filePath, createEmptyStore);
    this.#safeStorage = safeStorage;
  }

  async savedIds(connectionIds) {
    if (!Array.isArray(connectionIds)) {
      throw new AppError("INVALID_INPUT", "连接标识列表格式不正确。" );
    }
    const ids = connectionIds.map((connectionId) => validateId(connectionId, "连接标识"));
    const value = validateStore(await this.#store.read());
    return new Set(ids.filter((connectionId) => Boolean(value.entries[connectionId])));
  }

  async status() {
    try {
      return {
        available: Boolean(await this.#safeStorage.isAsyncEncryptionAvailable()),
        protection: "windows-user",
      };
    } catch {
      return { available: false, protection: "windows-user" };
    }
  }

  async save(connectionId, password) {
    const id = validateId(connectionId, "连接标识");
    const secret = validatePassword(password);
    await this.#assertAvailable();

    let encrypted;
    try {
      encrypted = requireEncryptedBuffer(
        await this.#safeStorage.encryptStringAsync(secret),
        "CREDENTIAL_ENCRYPT_FAILED",
        "Windows 返回了无效的密码加密结果，密码未保存。",
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "CREDENTIAL_ENCRYPT_FAILED") throw error;
      throw new AppError("CREDENTIAL_ENCRYPT_FAILED", "Windows 无法加密该密码，密码未保存。", { cause: error });
    }

    const entry = {
      kind: "password",
      protection: "electron-safe-storage",
      formatVersion: 1,
      ciphertext: encrypted.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    await this.#store.update(async (raw) => {
      const value = validateStore(raw);
      return {
        value: { ...value, entries: { ...value.entries, [id]: entry } },
        result: null,
      };
    });
    return { connectionId: id, saved: true };
  }

  async get(connectionId) {
    const id = validateId(connectionId, "连接标识");
    const value = validateStore(await this.#store.read());
    const entry = value.entries[id];
    if (!entry) throw new AppError("SAVED_PASSWORD_NOT_FOUND", "该连接没有已保存的密码，请重新输入。" );
    await this.#assertAvailable();

    let decrypted;
    try {
      decrypted = await this.#safeStorage.decryptStringAsync(decodeCiphertext(entry.ciphertext));
    } catch (error) {
      throw new AppError("CREDENTIAL_DECRYPT_FAILED", "Windows 无法解密已保存密码，请重新输入并保存。", { cause: error });
    }
    let secret;
    try {
      if (!decrypted
        || typeof decrypted !== "object"
        || typeof decrypted.shouldReEncrypt !== "boolean") {
        throw new TypeError("异步解密结果结构不正确");
      }
      secret = validatePassword(decrypted.result);
    } catch (error) {
      throw new AppError("CREDENTIAL_DECRYPT_FAILED", "Windows 返回了无效的密码解密结果，请重新输入并保存。", { cause: error });
    }

    if (decrypted.shouldReEncrypt) {
      let refreshed;
      try {
        refreshed = requireEncryptedBuffer(
          await this.#safeStorage.encryptStringAsync(secret),
          "CREDENTIAL_REENCRYPT_FAILED",
          "Windows 密钥已变化，但返回了无效的重新加密结果。",
        );
      } catch (error) {
        if (error instanceof AppError && error.code === "CREDENTIAL_REENCRYPT_FAILED") throw error;
        throw new AppError("CREDENTIAL_REENCRYPT_FAILED", "Windows 密钥已变化，但无法重新加密已保存密码。", { cause: error });
      }
      const refreshedEntry = {
        ...entry,
        ciphertext: refreshed.toString("base64"),
        updatedAt: new Date().toISOString(),
      };
      await this.#store.update(async (raw) => {
        const current = validateStore(raw);
        if (current.entries[id]?.ciphertext !== entry.ciphertext) return { value: current, result: null };
        return {
          value: { ...current, entries: { ...current.entries, [id]: refreshedEntry } },
          result: null,
        };
      });
    }
    return secret;
  }

  async remove(connectionId) {
    const id = validateId(connectionId, "连接标识");
    return this.#store.update(async (raw) => {
      const value = validateStore(raw);
      const existed = Boolean(value.entries[id]);
      if (!existed) return { value, result: { connectionId: id, saved: false, removed: false } };
      const entries = { ...value.entries };
      delete entries[id];
      return {
        value: { ...value, entries },
        result: { connectionId: id, saved: false, removed: true },
      };
    });
  }

  async #assertAvailable() {
    const status = await this.status();
    if (!status.available) {
      throw new AppError("CREDENTIAL_STORAGE_UNAVAILABLE", "Windows 本机密码加密服务暂时不可用。" );
    }
  }
}
