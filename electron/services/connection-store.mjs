import crypto from "node:crypto";
import { AppError } from "./app-error.mjs";
import { JsonStore } from "./json-store.mjs";
import { validateConnectionDraft, validateId } from "./validation.mjs";

function createEmptyStore() {
  return { version: 1, connections: [] };
}

function validateStore(value) {
  if (value?.version !== 1 || !Array.isArray(value.connections)) {
    throw new AppError("STORE_CORRUPT", "连接配置结构不正确。请先备份该文件再处理。" );
  }
  return value;
}

export class ConnectionStore {
  #store;

  constructor(filePath) {
    this.#store = new JsonStore(filePath, createEmptyStore);
  }

  async list() {
    const value = validateStore(await this.#store.read());
    return value.connections.map((connection) => ({ ...connection }));
  }

  async get(connectionId) {
    const id = validateId(connectionId, "连接标识");
    const connections = await this.list();
    const connection = connections.find((item) => item.id === id);
    if (!connection) throw new AppError("CONNECTION_NOT_FOUND", "未找到该服务器连接配置。");
    return connection;
  }

  async save(payload) {
    const draft = validateConnectionDraft(payload);
    const now = new Date().toISOString();
    const connection = {
      id: crypto.randomUUID(),
      ...draft,
      createdAt: now,
      updatedAt: now,
    };

    return this.#store.update(async (raw) => {
      const value = validateStore(raw);
      return {
        value: { ...value, connections: [...value.connections, connection] },
        result: { ...connection },
      };
    });
  }

  async remove(connectionId) {
    const id = validateId(connectionId, "连接标识");
    return this.#store.update(async (raw) => {
      const value = validateStore(raw);
      const connection = value.connections.find((item) => item.id === id);
      if (!connection) throw new AppError("CONNECTION_NOT_FOUND", "未找到该服务器连接配置。");
      return {
        value: {
          ...value,
          connections: value.connections.filter((item) => item.id !== id),
        },
        result: { connectionId: id, removed: true },
      };
    });
  }
}
