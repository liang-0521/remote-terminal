import { AppError } from "./app-error.mjs";
import {
  MONITOR_SNAPSHOT_COMMAND,
  calculateCpuUsage,
  calculateNetworkRates,
  parseCpuStat,
  parseMonitorSnapshot,
  parseNetworkDev,
} from "./monitor-parser.mjs";
import { validateId } from "./validation.mjs";

const NETWORK_MARKER = "@@REMOTE_TERMINAL:NETWORK_DEV@@";
const COUNTER_COMMAND = [
  "export LC_ALL=C",
  "sed -n '1p' /proc/stat",
  `printf '%s\\n' '${NETWORK_MARKER}'`,
  "cat /proc/net/dev",
].join("\n");

function parseCounters(text) {
  const markerIndex = text.indexOf(NETWORK_MARKER);
  if (markerIndex < 0) throw new TypeError("监控计数器缺少网络分隔标记");
  return {
    cpu: parseCpuStat(text.slice(0, markerIndex)),
    network: parseNetworkDev(text.slice(markerIndex + NETWORK_MARKER.length)),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MonitorService {
  #ssh;
  #sampling = new Set();

  constructor(ssh) {
    this.#ssh = ssh;
  }

  async sample(sessionId) {
    const id = validateId(sessionId, "会话标识");
    if (this.#sampling.has(id)) {
      throw new AppError("MONITOR_BUSY", "上一轮性能采样尚未完成。" );
    }
    this.#sampling.add(id);

    try {
      const firstResult = await this.#ssh.exec(id, COUNTER_COMMAND);
      const previous = parseCounters(firstResult.stdout);
      const startedAt = performance.now();
      const [snapshotResult, secondResult] = await Promise.all([
        this.#ssh.exec(id, MONITOR_SNAPSHOT_COMMAND),
        wait(600).then(() => this.#ssh.exec(id, COUNTER_COMMAND)),
      ]);
      const elapsedMs = performance.now() - startedAt;
      const current = parseCounters(secondResult.stdout);
      const cpu = calculateCpuUsage(previous.cpu, current.cpu);
      const network = calculateNetworkRates(previous.network, current.network, elapsedMs);
      return {
        ...parseMonitorSnapshot(snapshotResult.stdout, { cpu, network }),
        sampledAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MONITOR_PARSE_FAILED", "Linux 性能采样格式无法识别，本轮数据未更新。", { cause: error });
    } finally {
      this.#sampling.delete(id);
    }
  }
}
