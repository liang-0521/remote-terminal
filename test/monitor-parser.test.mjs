import assert from "node:assert/strict";
import test from "node:test";
import {
  MONITOR_SECTION_MARKERS,
  MONITOR_SNAPSHOT_COMMAND,
  calculateCpuUsage,
  calculateNetworkRates,
  parseCpuStat,
  parseMonitorSnapshot,
  parseNetworkDev,
} from "../electron/services/monitor-parser.mjs";

function createSnapshot({ swapTotal = 4_194_304, swapFree = 3_145_728, omit = [] } = {}) {
  const sections = {
    os: "Ubuntu 24.04.1 LTS",
    uptime: "176580.50 1234.00",
    load: "0.76 0.90 0.83 2/901 2210",
    cpuCores: "8",
    memory: [
      "MemTotal:        8388608 kB",
      "MemAvailable:    6291456 kB",
      `SwapTotal:       ${swapTotal} kB`,
      `SwapFree:        ${swapFree} kB`,
    ].join("\n"),
    processes: [
      " 2481 www-data 4.3 2097152 java -jar app.jar",
      " 1836 mysql 2.8 1331200 mysqld",
    ].join("\n"),
    mounts: [
      "/\t104857600\t52428800\t52428800\t50%",
      "/boot\t1048576\t314572\t734004\t30%",
    ].join("\n"),
  };

  return Object.keys(MONITOR_SECTION_MARKERS)
    .filter((name) => !omit.includes(name))
    .flatMap((name) => [MONITOR_SECTION_MARKERS[name], sections[name]])
    .join("\n");
}

function networkDev({ received, transmitted }) {
  return [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0",
    `ens160: ${received} 10 0 0 0 0 0 0 ${transmitted} 10 0 0 0 0 0 0`,
  ].join("\n");
}

test("解析 CPU、网络和完整监控快照", () => {
  const previousCpu = parseCpuStat("cpu 100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0");
  const currentCpu = parseCpuStat("cpu 150 0 150 900 0 0 0 0 0 0\ncpu0 75 0 75 450 0 0 0 0 0 0");
  const cpu = calculateCpuUsage(previousCpu, currentCpu);
  assert.equal(cpu, 50);

  const previousNetwork = parseNetworkDev(networkDev({ received: 1_000, transmitted: 2_000 }));
  const currentNetwork = parseNetworkDev(networkDev({ received: 103_400, transmitted: 53_200 }));
  const network = calculateNetworkRates(previousNetwork, currentNetwork, 1_000);
  assert.deepEqual(network, { interface: "ens160", down: 100, up: 50 });

  const snapshot = parseMonitorSnapshot(createSnapshot(), { cpu, network });
  assert.deepEqual(snapshot, {
    os: "Ubuntu 24.04.1 LTS",
    uptime: "2 天 1 小时",
    load: [0.76, 0.9, 0.83],
    cpuCores: 8,
    cpu: 50,
    memoryUsed: 2,
    memoryTotal: 8,
    swapUsed: 1,
    swapTotal: 4,
    processes: [
      { pid: 2481, user: "www-data", cpu: 4.3, memory: "2.0 GB", command: "java -jar app.jar" },
      { pid: 1836, user: "mysql", cpu: 2.8, memory: "1.3 GB", command: "mysqld" },
    ],
    networkInterface: "ens160",
    down: 100,
    up: 50,
    latency: null,
    mounts: [
      { path: "/", used: 50, available: 50, total: 100, percent: 50 },
      { path: "/boot", used: 0.3, available: 0.7, total: 1, percent: 30 },
    ],
  });
  assert.match(MONITOR_SNAPSHOT_COMMAND, /@@REMOTE_TERMINAL:MEMORY@@/);
});

test("SwapTotal 为 0 时返回合法的零容量，不伪造数值", () => {
  const snapshot = parseMonitorSnapshot(createSnapshot({ swapTotal: 0, swapFree: 0 }), {
    cpu: 12.5,
    network: { interface: "eth0", down: 0, up: 0 },
  });

  assert.equal(snapshot.swapTotal, 0);
  assert.equal(snapshot.swapUsed, 0);
});

test("关键 section 缺失或原始计数器畸形时明确失败", () => {
  assert.throws(
    () => parseMonitorSnapshot(createSnapshot({ omit: ["memory"] }), {
      cpu: 10,
      network: { interface: "eth0", down: 1, up: 1 },
    }),
    /缺少监控 section: memory/,
  );
  assert.throws(() => parseCpuStat("cpu invalid 0 0 0"), /CPU tick 必须是非负整数/);
  assert.throws(() => parseNetworkDev("eth0: 1 2 3"), /字段不足/);

  const previous = parseNetworkDev(networkDev({ received: 2_000, transmitted: 2_000 }));
  const current = parseNetworkDev(networkDev({ received: 1_000, transmitted: 3_000 }));
  assert.throws(() => calculateNetworkRates(previous, current, 1_000), /网络计数器发生回退/);
});
