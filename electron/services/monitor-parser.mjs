const KIBIBYTES_PER_GIBIBYTE = 1024 * 1024;
const KIBIBYTES_PER_MEBIBYTE = 1024;

export const MONITOR_SECTION_MARKERS = Object.freeze({
  os: "@@REMOTE_TERMINAL:OS@@",
  uptime: "@@REMOTE_TERMINAL:UPTIME@@",
  load: "@@REMOTE_TERMINAL:LOAD@@",
  cpuCores: "@@REMOTE_TERMINAL:CPU_CORES@@",
  memory: "@@REMOTE_TERMINAL:MEMORY@@",
  processes: "@@REMOTE_TERMINAL:PROCESSES@@",
  mounts: "@@REMOTE_TERMINAL:MOUNTS@@",
});

// CPU and network counters need two samples, so the sampler reads /proc/stat and
// /proc/net/dev separately and passes their calculated values to
// parseMonitorSnapshot. This command collects the remaining point-in-time data.
export const MONITOR_SNAPSHOT_COMMAND = [
  "export LC_ALL=C",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.os}'`,
  "os_name=''",
  "if [ -r /etc/os-release ]; then os_name=$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | sed 's/^\"//;s/\"$//' | sed -n '1p'); fi",
  "if [ -z \"$os_name\" ]; then os_name=$(uname -sr); fi",
  "printf '%s\\n' \"$os_name\"",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.uptime}'`,
  "cat /proc/uptime",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.load}'`,
  "cat /proc/loadavg",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.cpuCores}'`,
  "getconf _NPROCESSORS_ONLN",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.memory}'`,
  "cat /proc/meminfo",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.processes}'`,
  "ps -eo pid=,user=,pcpu=,rss=,args= --sort=-pcpu | sed -n '1,8p'",
  `printf '%s\\n' '${MONITOR_SECTION_MARKERS.mounts}'`,
  "df -Pk | awk 'NR > 1 && $2 > 0 { mount=$6; for (i=7; i<=NF; i++) mount=mount \" \" $i; printf \"%s\\t%s\\t%s\\t%s\\t%s\\n\", mount,$2,$3,$4,$5 }'",
].join("\n");

export function parseCpuStat(text) {
  assertText(text, "CPU stat");
  const cpuLine = text
    .split(/\r?\n/)
    .find((line) => /^cpu\s+/.test(line.trim()));

  if (!cpuLine) {
    throw new TypeError("CPU stat 缺少 cpu 汇总行");
  }

  const fields = cpuLine.trim().split(/\s+/).slice(1);
  if (fields.length < 4) {
    throw new TypeError("CPU stat 的 cpu 汇总行字段不足");
  }

  const counters = fields.map((field) => parseNonNegativeSafeInteger(field, "CPU tick"));
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = counters;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const idleTotal = idle + iowait;

  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(idleTotal)) {
    throw new RangeError("CPU tick 总量超出安全整数范围");
  }

  return { user, nice, system, idle, iowait, irq, softirq, steal, total, idleTotal };
}

export function calculateCpuUsage(previous, current) {
  assertCpuSample(previous, "previous");
  assertCpuSample(current, "current");

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idleTotal - previous.idleTotal;
  if (totalDelta <= 0) {
    throw new RangeError("CPU 总 tick 必须随时间增加");
  }
  if (idleDelta < 0 || idleDelta > totalDelta) {
    throw new RangeError("CPU idle tick 增量无效");
  }

  return roundTo(((totalDelta - idleDelta) / totalDelta) * 100, 1);
}

export function parseNetworkDev(text) {
  assertText(text, "network dev");
  const interfaces = Object.create(null);

  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(":")) continue;
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (!match) {
      throw new TypeError(`无法解析 network dev 行: ${line.trim()}`);
    }

    const name = match[1].trim();
    const fields = match[2].split(/\s+/);
    if (!name || fields.length < 16) {
      throw new TypeError(`network dev 接口 ${name || "<empty>"} 的字段不足`);
    }

    const counters = fields.map((field) => parseNonNegativeSafeInteger(field, `接口 ${name} 计数器`));
    interfaces[name] = {
      receivedBytes: counters[0],
      transmittedBytes: counters[8],
    };
  }

  if (Object.keys(interfaces).length === 0) {
    throw new TypeError("network dev 未包含任何接口");
  }

  return interfaces;
}

export function calculateNetworkRates(previous, current, elapsedMs) {
  assertNetworkSample(previous, "previous");
  assertNetworkSample(current, "current");
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new RangeError("网络采样间隔必须大于 0 毫秒");
  }

  const candidates = Object.keys(current)
    .filter((name) => name !== "lo" && Object.hasOwn(previous, name))
    .map((name) => {
      const receivedDelta = current[name].receivedBytes - previous[name].receivedBytes;
      const transmittedDelta = current[name].transmittedBytes - previous[name].transmittedBytes;
      if (receivedDelta < 0 || transmittedDelta < 0) {
        throw new RangeError(`接口 ${name} 的网络计数器发生回退`);
      }
      return {
        name,
        receivedDelta,
        transmittedDelta,
        activity: receivedDelta + transmittedDelta,
        volume: current[name].receivedBytes + current[name].transmittedBytes,
      };
    });

  if (candidates.length === 0) {
    throw new TypeError("两次网络采样之间没有共同的非 loopback 接口");
  }

  candidates.sort((left, right) => (
    right.activity - left.activity
    || right.volume - left.volume
    || left.name.localeCompare(right.name)
  ));
  const selected = candidates[0];
  const seconds = elapsedMs / 1000;

  return {
    interface: selected.name,
    down: roundTo(selected.receivedDelta / 1024 / seconds, 2),
    up: roundTo(selected.transmittedDelta / 1024 / seconds, 2),
  };
}

export function parseMonitorSnapshot(text, { cpu, network } = {}) {
  if (!Number.isFinite(cpu) || cpu < 0 || cpu > 100) {
    throw new RangeError("CPU 使用率必须是 0–100 的有效数字");
  }
  assertNetworkRates(network);

  const sections = parseSections(text);
  const memory = parseMemoryInfo(sections.memory);
  const load = parseLoad(sections.load);
  const cpuCores = parsePositiveInteger(sections.cpuCores.trim(), "CPU 核数");
  const uptimeSeconds = Number(sections.uptime.trim().split(/\s+/)[0]);
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new TypeError("uptime section 不包含有效的运行秒数");
  }

  const os = sections.os.trim();
  if (!os) {
    throw new TypeError("os section 不能为空");
  }

  return {
    os,
    uptime: formatUptime(uptimeSeconds),
    load,
    cpuCores,
    cpu,
    memoryUsed: toGibibytes(memory.memTotal - memory.memAvailable),
    memoryTotal: toGibibytes(memory.memTotal),
    swapUsed: toGibibytes(memory.swapTotal - memory.swapFree),
    swapTotal: toGibibytes(memory.swapTotal),
    processes: parseProcesses(sections.processes),
    networkInterface: network.interface,
    down: network.down,
    up: network.up,
    latency: null,
    mounts: parseMounts(sections.mounts),
  };
}

function parseSections(text) {
  assertText(text, "monitor snapshot");
  const markerToName = new Map(
    Object.entries(MONITOR_SECTION_MARKERS).map(([name, marker]) => [marker, name]),
  );
  const content = new Map();
  let currentSection = null;

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (markerToName.has(line)) {
      currentSection = markerToName.get(line);
      if (content.has(currentSection)) {
        throw new TypeError(`重复的监控 section: ${currentSection}`);
      }
      content.set(currentSection, []);
      continue;
    }
    if (line.startsWith("@@REMOTE_TERMINAL:") && line.endsWith("@@")) {
      throw new TypeError(`未知的监控 section marker: ${line}`);
    }
    if (currentSection === null) {
      if (line.trim()) throw new TypeError("首个监控 section 之前存在意外输出");
      continue;
    }
    content.get(currentSection).push(line);
  }

  const sections = {};
  for (const name of Object.keys(MONITOR_SECTION_MARKERS)) {
    if (!content.has(name)) {
      throw new TypeError(`缺少监控 section: ${name}`);
    }
    sections[name] = content.get(name).join("\n").trimEnd();
  }
  return sections;
}

function parseMemoryInfo(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) values.set(match[1], parseNonNegativeSafeInteger(match[2], match[1]));
  }

  const required = ["MemTotal", "MemAvailable", "SwapTotal", "SwapFree"];
  for (const name of required) {
    if (!values.has(name)) throw new TypeError(`memory section 缺少 ${name}`);
  }

  const memTotal = values.get("MemTotal");
  const memAvailable = values.get("MemAvailable");
  const swapTotal = values.get("SwapTotal");
  const swapFree = values.get("SwapFree");
  if (memTotal <= 0 || memAvailable > memTotal) {
    throw new RangeError("内存总量或可用量无效");
  }
  if (swapFree > swapTotal) {
    throw new RangeError("Swap 可用量不能大于总量");
  }

  return { memTotal, memAvailable, swapTotal, swapFree };
}

function parseLoad(text) {
  const fields = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (fields.length !== 3 || fields.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError("load section 必须包含三个非负负载值");
  }
  return fields;
}

function parseProcesses(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    throw new TypeError("processes section 不能为空");
  }

  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+([0-9]+(?:\.[0-9]+)?)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) throw new TypeError(`无法解析进程行: ${line.trim()}`);
    const pid = parsePositiveInteger(match[1], "进程 PID");
    const cpu = Number(match[3]);
    const rssKibibytes = parseNonNegativeSafeInteger(match[4], `进程 ${pid} RSS`);
    if (!Number.isFinite(cpu) || cpu < 0) throw new TypeError(`进程 ${pid} CPU 使用率无效`);
    return {
      pid,
      user: match[2],
      cpu,
      memory: formatMemory(rssKibibytes),
      command: match[5],
    };
  });
}

function parseMounts(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) {
    throw new TypeError("mounts section 不能为空");
  }

  return lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 5 || !fields[0]) {
      throw new TypeError(`无法解析挂载点行: ${line}`);
    }
    const totalKibibytes = parsePositiveInteger(fields[1], `挂载点 ${fields[0]} 总量`);
    const usedKibibytes = parseNonNegativeSafeInteger(fields[2], `挂载点 ${fields[0]} 已用量`);
    const availableKibibytes = parseNonNegativeSafeInteger(fields[3], `挂载点 ${fields[0]} 可用量`);
    const percentMatch = fields[4].match(/^(\d+)%$/);
    if (!percentMatch) throw new TypeError(`挂载点 ${fields[0]} 使用率无效`);
    const percent = Number(percentMatch[1]);
    if (percent < 0 || percent > 100) throw new RangeError(`挂载点 ${fields[0]} 使用率超出范围`);

    return {
      path: fields[0],
      used: toGibibytes(usedKibibytes),
      available: toGibibytes(availableKibibytes),
      total: toGibibytes(totalKibibytes),
      percent,
    };
  });
}

function assertCpuSample(sample, label) {
  if (!sample || !Number.isSafeInteger(sample.total) || !Number.isSafeInteger(sample.idleTotal)) {
    throw new TypeError(`${label} CPU 样本无效`);
  }
  if (sample.total < 0 || sample.idleTotal < 0 || sample.idleTotal > sample.total) {
    throw new RangeError(`${label} CPU 样本范围无效`);
  }
}

function assertNetworkSample(sample, label) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError(`${label} 网络样本无效`);
  }
  for (const [name, counters] of Object.entries(sample)) {
    if (!name || !counters
      || !Number.isSafeInteger(counters.receivedBytes)
      || !Number.isSafeInteger(counters.transmittedBytes)
      || counters.receivedBytes < 0
      || counters.transmittedBytes < 0) {
      throw new TypeError(`${label} 接口 ${name || "<empty>"} 计数器无效`);
    }
  }
}

function assertNetworkRates(network) {
  if (!network || typeof network.interface !== "string" || !network.interface.trim()) {
    throw new TypeError("网络速率缺少接口名称");
  }
  if (!Number.isFinite(network.down) || network.down < 0 || !Number.isFinite(network.up) || network.up < 0) {
    throw new RangeError("网络上下行速率必须是非负有效数字");
  }
}

function parseNonNegativeSafeInteger(value, label) {
  if (!/^\d+$/.test(String(value))) throw new TypeError(`${label} 必须是非负整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${label} 超出安全整数范围`);
  return number;
}

function parsePositiveInteger(value, label) {
  const number = parseNonNegativeSafeInteger(value, label);
  if (number <= 0) throw new RangeError(`${label} 必须大于 0`);
  return number;
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} 必须是非空字符串`);
  }
}

function toGibibytes(kibibytes) {
  return roundTo(kibibytes / KIBIBYTES_PER_GIBIBYTE, 2);
}

function formatMemory(kibibytes) {
  if (kibibytes >= KIBIBYTES_PER_GIBIBYTE) {
    return `${(kibibytes / KIBIBYTES_PER_GIBIBYTE).toFixed(1)} GB`;
  }
  if (kibibytes >= KIBIBYTES_PER_MEBIBYTE) {
    return `${(kibibytes / KIBIBYTES_PER_MEBIBYTE).toFixed(1)} MB`;
  }
  return `${kibibytes} KB`;
}

function formatUptime(seconds) {
  const wholeMinutes = Math.floor(seconds / 60);
  const days = Math.floor(wholeMinutes / (24 * 60));
  const hours = Math.floor((wholeMinutes % (24 * 60)) / 60);
  const minutes = wholeMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
