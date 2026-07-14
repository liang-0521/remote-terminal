import crypto from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./app-error.mjs";

export class JsonStore {
  #filePath;
  #createEmpty;
  #writeQueue = Promise.resolve();

  constructor(filePath, createEmpty) {
    this.#filePath = filePath;
    this.#createEmpty = createEmpty;
  }

  async read() {
    await this.#writeQueue;
    return this.#readCurrent();
  }

  async #readCurrent() {
    let content;
    try {
      content = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return this.#createEmpty();
      throw new AppError("STORE_READ_FAILED", "无法读取客户端本地配置。", { cause: error });
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      throw new AppError("STORE_CORRUPT", `本地配置文件损坏：${path.basename(this.#filePath)}`, { cause: error });
    }
  }

  async update(mutator) {
    const operation = async () => {
      const current = await this.#readCurrent();
      const { value, result } = await mutator(current);
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporaryPath = `${this.#filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      let handle = null;
      try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporaryPath, this.#filePath);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        let cause = error;
        try {
          await unlink(temporaryPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            cause = new AggregateError([error, cleanupError], "配置写入及临时文件清理均失败");
          }
        }
        throw new AppError("STORE_WRITE_FAILED", "无法写入客户端本地配置。", { cause });
      }
      return result;
    };

    const next = this.#writeQueue.then(operation, operation);
    this.#writeQueue = next.then(() => undefined, () => undefined);
    return next;
  }
}
