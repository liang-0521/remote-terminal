const BASE_NETWORK_HISTORY = [
  { time: "11:28:20", down: 1.1, up: 2.4 },
  { time: "11:28:25", down: 1.8, up: 3.2 },
  { time: "11:28:30", down: 2.3, up: 2.8 },
  { time: "11:28:35", down: 1.6, up: 4.1 },
  { time: "11:28:40", down: 2.8, up: 3.6 },
  { time: "11:28:45", down: 2.1, up: 4.5 },
  { time: "11:28:50", down: 2.6, up: 4.3 },
];

export function createDemoMetrics(overrides = {}) {
  const diskTotal = overrides.diskTotal ?? 160;
  const disk = overrides.disk ?? 36;
  const rootUsed = Number((diskTotal * disk / 100).toFixed(1));

  return {
    cpu: 12,
    cpuCores: 4,
    memoryUsed: 2.4,
    memoryTotal: 8,
    swapUsed: 0.6,
    swapTotal: 4,
    disk,
    diskTotal,
    down: 1.2,
    up: 0.7,
    os: "Ubuntu 24.04 LTS",
    uptime: "23 天 7 小时",
    load: [0.28, 0.34, 0.31],
    networkInterface: "ens160",
    latency: 12,
    history: BASE_NETWORK_HISTORY,
    processes: [
      { pid: 2481, user: "www-data", cpu: 4.3, memory: "2.0 GB", command: "java -jar app.jar" },
      { pid: 1836, user: "mysql", cpu: 2.8, memory: "1.3 GB", command: "mysqld" },
      { pid: 927, user: "root", cpu: 1.3, memory: "636 MB", command: "dockerd" },
      { pid: 3118, user: "www-data", cpu: 0.9, memory: "58.8 MB", command: "php-fpm" },
    ],
    mounts: [
      { path: "/", used: rootUsed, available: Number((diskTotal - rootUsed).toFixed(1)), total: diskTotal, percent: disk },
      { path: "/boot", used: 0.3, available: 0.7, total: 1, percent: 30 },
      { path: "/run", used: 0.1, available: 7.9, total: 8, percent: 1 },
    ],
    ...overrides,
  };
}

export const SERVERS = [
  {
    id: "prod-web-01",
    name: "prod-web-01",
    endpoint: "deploy@prod-web-01:22",
    host: "prod-web-01",
    port: 22,
    username: "deploy",
    authMethod: "ssh-agent",
    group: "生产环境",
    state: "connected",
    directory: "/var/www/app/releases",
    metrics: createDemoMetrics({
      cpu: 32,
      cpuCores: 8,
      memoryUsed: 5.8,
      memoryTotal: 16,
      swapUsed: 0.9,
      swapTotal: 8,
      disk: 61,
      diskTotal: 320,
      down: 2.6,
      up: 4.3,
      uptime: "87 天 4 小时",
      load: [0.76, 0.9, 0.83],
      latency: 9,
      mounts: [
        { path: "/", used: 195.2, available: 124.8, total: 320, percent: 61 },
        { path: "/boot", used: 0.3, available: 0.7, total: 1, percent: 30 },
        { path: "/data", used: 405.6, available: 394.4, total: 800, percent: 51 },
      ],
    }),
  },
  {
    id: "staging-api-01",
    name: "staging-api-01",
    endpoint: "deploy@staging-api-01:22",
    host: "staging-api-01",
    port: 22,
    username: "deploy",
    authMethod: "key-file",
    group: "预发布环境",
    state: "disconnected",
    directory: "/srv/staging/releases",
    metrics: createDemoMetrics({
      cpu: 18,
      cpuCores: 4,
      memoryUsed: 3.2,
      memoryTotal: 8,
      swapUsed: 0.2,
      swapTotal: 4,
      disk: 44,
      diskTotal: 160,
      down: 0.8,
      up: 1.1,
      os: "Rocky Linux 9.4",
      uptime: "12 天 16 小时",
      load: [0.31, 0.28, 0.25],
      networkInterface: "enp1s0",
      latency: 18,
      history: BASE_NETWORK_HISTORY.map((item) => ({ ...item, down: Number((item.down * 0.42).toFixed(1)), up: Number((item.up * 0.36).toFixed(1)) })),
      processes: [
        { pid: 1664, user: "deploy", cpu: 3.1, memory: "1.1 GB", command: "node server.js" },
        { pid: 982, user: "postgres", cpu: 1.7, memory: "824 MB", command: "postgres" },
        { pid: 711, user: "root", cpu: 0.8, memory: "264 MB", command: "podman" },
      ],
      mounts: [
        { path: "/", used: 70.4, available: 89.6, total: 160, percent: 44 },
        { path: "/boot", used: 0.2, available: 0.8, total: 1, percent: 20 },
        { path: "/srv", used: 112.0, available: 128.0, total: 240, percent: 47 },
      ],
    }),
  },
];

export const RELEASES = [
  "20260714_101530",
  "20260713_091205",
  "20260712_174430",
  "20260711_120010",
  "20260710_083015",
];

export const COMPLETIONS = [
  { command: "journalctl -u nginx -f", description: "跟随 nginx 服务日志", source: "本地模板" },
  { command: "journalctl -u php-fpm -f", description: "跟随 php-fpm 服务日志", source: "本地模板" },
  { command: "journalctl -xe", description: "查看系统错误日志", source: "本地模板" },
  { command: 'journalctl --since "1 hour ago"', description: "查看最近 1 小时日志", source: "本地模板" },
  { command: "journalctl -u sshd --since today", description: "查看 sshd 今日日志", source: "本地模板" },
];

export const TRANSFER_SEED = {
  id: "release-upload",
  fileName: "release-2026.07.14.tar.gz",
  sizeLabel: "512.0 MB",
  target: "/var/www/app/releases/release-2026.07.14.tar.gz",
  progress: 68,
  speed: "8.6 MB/s",
  state: "uploading",
  serverId: "prod-web-01",
  autoAdvance: false,
};

export function createTerminalLines(server) {
  const username = server.username || "root";
  const directoryName = server.directory.split("/").filter(Boolean).at(-1) || "/";
  const prompt = `[${username}@${server.name} ${directoryName}]$`;
  return [
    { kind: "muted", text: "Last login: Mon Jul 14 10:15:42 2026 from local console" },
    { kind: "command", prompt, text: " pwd" },
    { kind: "plain", text: server.directory },
    { kind: "command", prompt, text: " ls -l" },
    { kind: "plain", text: "total 24" },
    { kind: "plain", text: `lrwxrwxrwx 1 ${username} ${username}   18 Jul 14 10:15 current -> 20260714_101530` },
    { kind: "link", text: `drwxr-xr-x 6 ${username} ${username} 4096 Jul 14 10:15 20260714_101530` },
    { kind: "link", text: `drwxr-xr-x 6 ${username} ${username} 4096 Jul 13 09:12 20260713_091205` },
    { kind: "link", text: `drwxr-xr-x 6 ${username} ${username} 4096 Jul 12 17:44 20260712_174430` },
    { kind: "link", text: `drwxr-xr-x 6 ${username} ${username} 4096 Jul 11 12:00 20260711_120010` },
    { kind: "link", text: `drwxr-xr-x 6 ${username} ${username} 4096 Jul 10 08:30 20260710_083015` },
    { kind: "plain", text: `-rw-r--r-- 1 ${username} ${username}    0 Jul 14 10:15 .release.lock` },
    { kind: "command", prompt, text: " cd 20260714_101530" },
    { kind: "command", prompt: `[${username}@${server.name} 20260714_101530]$`, text: " ls" },
    { kind: "cyan", text: "bin  config  public  resources  storage  vendor  artisan  composer.json  package.json" },
  ];
}

export const INITIAL_TERMINAL_LINES = createTerminalLines(SERVERS[0]);

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
