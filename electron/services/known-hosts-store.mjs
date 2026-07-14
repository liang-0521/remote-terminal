import { AppError } from "./app-error.mjs";
import { JsonStore } from "./json-store.mjs";

function createEmptyStore() {
  return { version: 1, hosts: {} };
}

function validateStore(value) {
  if (value?.version !== 1 || !value.hosts || typeof value.hosts !== "object" || Array.isArray(value.hosts)) {
    throw new AppError("STORE_CORRUPT", "已知主机配置结构不正确。请先备份该文件再处理。" );
  }
  return value;
}

export function knownHostKey(host, port) {
  const normalizedHost = host.trim().toLowerCase();
  return `${normalizedHost}:${port}`;
}

export class KnownHostsStore {
  #store;

  constructor(filePath) {
    this.#store = new JsonStore(filePath, createEmptyStore);
  }

  async get(host, port) {
    const value = validateStore(await this.#store.read());
    const entry = value.hosts[knownHostKey(host, port)];
    return entry ? { ...entry } : null;
  }

  async trust({ host, port, algorithm, fingerprint }) {
    const key = knownHostKey(host, port);
    const entry = {
      host: host.trim(),
      port,
      algorithm,
      fingerprint,
      trustedAt: new Date().toISOString(),
    };
    return this.#store.update(async (raw) => {
      const value = validateStore(raw);
      return {
        value: { ...value, hosts: { ...value.hosts, [key]: entry } },
        result: { ...entry },
      };
    });
  }
}
